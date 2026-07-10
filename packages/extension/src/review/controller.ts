import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EngineClient, absOf, type RepoInfo, type CheckpointRef, type ChangeItem } from '../engineClient.ts'
import { DELETED_MARKER, type AgentWriteStore } from '../opencode/agentWrites.ts'
import type { Log } from '../log.ts'
import { normcase } from '../lib/pathcase.ts'

export type Attribution = 'agent' | 'user' | 'unverified' | 'co-touched'

export type ReviewItem = ChangeItem & {
  abs: string
  attribution: Attribution
  reviewed: boolean
}

export type ReviewState = {
  baselineId: string | undefined
  baselineAt: number | undefined
  repos: RepoInfo[]
  items: ReviewItem[]
  missingRepos: { repoRoot: string; rel: string }[] // repos in the baseline whose worktree vanished
  // Repos discovered AFTER the baseline was taken (e.g. a repo cloned/created mid-session).
  // They have no checkpoint, so their changes are INVISIBLE until adopted — must be surfaced.
  newRepos: { repoRoot: string; rel: string; agentCreated: boolean }[]
}

const KEY_BASELINE = 'ocReview.baseline.v1'
const KEY_BASELINE_PREV = 'ocReview.baseline.prev.v1' // one-step recovery from an accidental re-baseline

type StoredBaseline = { id: string; at: number; refs: CheckpointRef[] }

export class ReviewController {
  private repos: RepoInfo[] = []
  private refs: CheckpointRef[] = []
  private baselineId: string | undefined
  private baselineAt: number | undefined
  private items: ReviewItem[] = []
  private missingRepos: { repoRoot: string; rel: string }[] = []
  private newRepos: { repoRoot: string; rel: string; agentCreated: boolean }[] = []
  private reviewed = new Set<string>() // `${repoRoot}\0${path}`
  private refreshTimer: NodeJS.Timeout | undefined

  // All mutating engine operations run through one promise chain: an explicit
  // "Checkpoint Now" queues behind an in-flight collect instead of silently no-oping.
  private op: Promise<unknown> = Promise.resolve()
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.op.then(fn, fn)
    this.op = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private readonly _onDidChange = new vscode.EventEmitter<ReviewState>()
  readonly onDidChange = this._onDidChange.event

  constructor(
    readonly workspaceRoot: string,
    readonly shadowDir: string,
    private readonly engine: EngineClient,
    private readonly agentWrites: AgentWriteStore,
    private readonly memento: vscode.Memento,
    private readonly log: Log,
  ) {
    const stored = memento.get<StoredBaseline>(KEY_BASELINE)
    if (stored?.id && Array.isArray(stored.refs)) {
      this.baselineId = stored.id
      this.baselineAt = stored.at
      this.refs = stored.refs
      this.log.info(`restored baseline ${stored.id} (${stored.refs.length} repos)`)
    }
  }

  state(): ReviewState {
    return {
      baselineId: this.baselineId,
      baselineAt: this.baselineAt,
      repos: this.repos,
      items: this.items,
      missingRepos: this.missingRepos,
      newRepos: this.newRepos,
    }
  }

  hasBaseline(): boolean {
    return this.refs.length > 0
  }

  itemFor(abs: string): ReviewItem | undefined {
    const n = normcase(abs)
    return this.items.find((i) => normcase(i.abs) === n)
  }

  getRefs(): CheckpointRef[] {
    return this.refs
  }
  getRepos(): RepoInfo[] {
    return this.repos
  }

  async ensureRepos(): Promise<RepoInfo[]> {
    this.repos = await this.engine.discover(this.workspaceRoot)
    return this.repos
  }

  // New baseline = checkpoint every repo now; clears review marks.
  newBaseline(reason: string): Promise<void> {
    return this.serialize(() => this.doNewBaseline(reason))
  }

  private async doNewBaseline(reason: string): Promise<void> {
    // Clear FIRST: agent writes observed while the (slow) checkpoint runs must survive
    // into the new epoch — clearing afterwards wiped mid-checkpoint captures.
    this.agentWrites.clear()
    await this.ensureRepos()
    const id = `vs-${Date.now()}`
    this.log.info(`checkpoint (${reason}) id=${id} repos=${this.repos.length}`)
    const refs = await this.engine.checkpoint(this.repos, this.shadowDir, id)
    // Keep the previous baseline recoverable (one step) before overwriting.
    const prev = this.memento.get<StoredBaseline>(KEY_BASELINE)
    if (prev) await this.memento.update(KEY_BASELINE_PREV, prev)
    this.refs = refs
    this.baselineId = id
    this.baselineAt = Date.now()
    this.reviewed.clear()
    await this.memento.update(KEY_BASELINE, { id, at: this.baselineAt, refs } satisfies StoredBaseline)
    this.items = []
    this.missingRepos = []
    this._onDidChange.fire(this.state())
  }

  // Turn start: re-baseline ONLY on an authoritative clean state. The debounced `items`
  // snapshot must never be trusted here — a pending refresh means turn-1 edits may not be
  // collected yet, and blindly re-baselining would silently absorb them (review finding #0).
  async onTurnStart(): Promise<void> {
    if (!this.hasBaseline()) {
      await this.newBaseline('turn-start (first)')
      return
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
    const authoritative = await this.refresh()
    if (authoritative && this.items.length === 0) {
      await this.newBaseline('turn-start (clean)')
    } else {
      this.log.info(`turn start: keeping baseline (${authoritative ? 'pending changes present' : 'collect not authoritative'})`)
    }
  }

  scheduleRefresh(delayMs = 800): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh(), delayMs)
  }

  // Returns true when the collect ran to completion (state is authoritative).
  refresh(): Promise<boolean> {
    return this.serialize(() => this.doRefresh())
  }

  private async doRefresh(): Promise<boolean> {
    if (!this.hasBaseline()) {
      this._onDidChange.fire(this.state())
      return true
    }
    try {
      await this.ensureRepos()
      const present = this.refs.filter((r) => this.repos.some((x) => x.repoRoot === r.repoRoot))
      // A baseline repo whose worktree vanished is data loss in progress — surface it,
      // never silently drop it (review finding #8).
      this.missingRepos = this.refs
        .filter((r) => !present.includes(r))
        .map((r) => ({ repoRoot: r.repoRoot, rel: path.relative(this.workspaceRoot, r.repoRoot).split(path.sep).join('/') || '.' }))
      // Repos that appeared after the baseline: no checkpoint -> collect skips them AND the
      // parent excludes them as a nested child -> their changes are completely invisible.
      // Surface them so the user can adopt them into the baseline (review feedback issue #1).
      this.newRepos = this.repos
        .filter((r) => !this.refs.some((x) => x.repoRoot === r.repoRoot))
        .map((r) => ({
          repoRoot: r.repoRoot,
          rel: r.relToWorkspace,
          agentCreated: this.agentWrites.hasUnder(r.repoRoot),
        }))
      const raw = await this.engine.collect(present, this.repos, this.shadowDir)
      this.items = raw.map((it) => this.classify(it))
      this._onDidChange.fire(this.state())
      this.log.info(`collect: ${this.items.length} changed file(s)${this.missingRepos.length ? `; ${this.missingRepos.length} MISSING repo(s)` : ''}`)
      return true
    } catch (e: any) {
      this.log.error(`refresh failed: ${e?.message ?? e}`)
      return false
    }
  }

  // Co-touch detection (SPEC open risk #1), done here because the engine can't know
  // what the agent wrote. Compares current disk content vs the recorded agent write.
  private classify(it: ChangeItem): ReviewItem {
    const abs = absOf(it)
    const rec = this.agentWrites.content(abs)
    let attribution: Attribution
    if (rec === undefined) {
      attribution = 'unverified' // never saw the agent write it (SSE missed / user's own change)
    } else {
      let current: string | undefined
      try {
        current = fs.readFileSync(abs, 'utf8')
      } catch {
        current = undefined // deleted
      }
      if (it.status === 'del') {
        attribution = rec === DELETED_MARKER ? 'agent' : current === undefined ? 'agent' : 'co-touched'
      } else if (current !== undefined && current === rec) {
        attribution = 'agent'
      } else {
        attribution = 'co-touched' // user edited after the agent wrote
      }
    }
    const coTouched = attribution === 'co-touched'
    // Default STRICT: unverified changes are treated as possibly-user-owned, so reverts
    // require explicit confirmation and hunk reverts are refused (review finding #7).
    const strict = vscode.workspace.getConfiguration('ocReview').get<boolean>('strictAttribution', true)
    const item: ReviewItem = {
      ...it,
      abs,
      coTouchedByUser: coTouched || (strict && attribution === 'unverified'),
      attribution,
      reviewed: this.reviewed.has(`${it.repoRoot}\0${it.path}`),
      // Honest per-hunk flag regardless of the setting: only verified agent output
      // may be hunk-reverted (the engine enforces this too).
      hunks: it.hunks.map((h) => ({ ...h, agentAttributed: attribution === 'agent' })),
    }
    return item
  }

  toggleReviewed(item: ReviewItem): void {
    const key = `${item.repoRoot}\0${item.path}`
    if (this.reviewed.has(key)) this.reviewed.delete(key)
    else this.reviewed.add(key)
    item.reviewed = this.reviewed.has(key)
    this._onDidChange.fire(this.state())
  }

  // Reverts NEVER act on the stale classification captured at scan time: the file may have
  // been edited since. Re-classify against current disk and refuse on a fresh co-touch
  // unless the caller explicitly allowed it (review findings #2/#13).
  revertFile(item: ReviewItem, allowCoTouched: boolean): Promise<void> {
    return this.serialize(async () => {
      const fresh = this.classify(item)
      if (fresh.coTouchedByUser && !item.coTouchedByUser && !allowCoTouched) {
        throw new Error(`'${item.path}' changed since the last scan — refresh and review the co-touched warning`)
      }
      await this.engine.revertFile(fresh, this.refs, this.repos, this.shadowDir, allowCoTouched)
      await this.doRefresh()
    })
  }

  revertHunk(item: ReviewItem, hunkIndex: number): Promise<void> {
    return this.serialize(async () => {
      const fresh = this.classify(item)
      if (fresh.coTouchedByUser || fresh.attribution !== 'agent') {
        throw new Error(`'${item.path}' is ${fresh.attribution} — hunk revert only applies to verified agent output; use file revert instead`)
      }
      const hunk = fresh.hunks[hunkIndex]
      if (!hunk) throw new Error(`no hunk #${hunkIndex} — the file changed since the last scan; refresh first`)
      // If the on-disk content drifted from the scanned hunk, `git apply -R` fails on
      // context mismatch — a safe, atomic-per-file failure surfaced to the user.
      await this.engine.revertHunk(fresh, hunk, this.repos)
      await this.doRefresh()
    })
  }

  revertRepo(repoRoot: string, deleteAgentAdded: boolean): Promise<void> {
    return this.serialize(async () => {
      const agentAdded = deleteAgentAdded
        ? this.items
            .filter((i) => i.repoRoot === repoRoot && i.status === 'add' && this.classify(i).attribution === 'agent')
            .map((i) => i.path)
        : []
      await this.engine.revertRepo(repoRoot, this.refs, this.items, this.repos, this.shadowDir, agentAdded)
      await this.doRefresh()
    })
  }

  async baselineContent(item: Pick<ReviewItem, 'repoRoot' | 'path'>): Promise<{ exists: boolean; binary?: boolean; text?: string }> {
    return this.engine.baselineContent(item.repoRoot, item.path, this.refs, this.shadowDir)
  }

  // Bring a repo that appeared after the baseline into it (checkpoint = its CURRENT content).
  // Caller must confirm with the user first — for an agent-created repo this accepts the
  // agent's current output as baseline (nothing before adoption is revertable).
  adoptRepo(repoRoot: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.baselineId) throw new Error('no baseline to adopt into')
      const repo = this.repos.find((r) => r.repoRoot === repoRoot)
      if (!repo) throw new Error(`repo not found: ${repoRoot}`)
      const refs = await this.engine.checkpoint([repo], this.shadowDir, this.baselineId)
      this.refs = [...this.refs.filter((r) => r.repoRoot !== repoRoot), ...refs]
      await this.memento.update(KEY_BASELINE, {
        id: this.baselineId,
        at: this.baselineAt ?? Date.now(),
        refs: this.refs,
      } satisfies StoredBaseline)
      this.log.info(`adopted repo into baseline ${this.baselineId}: ${repoRoot}`)
      await this.doRefresh()
    })
  }

  explainPath(abs: string): Promise<import('../engineClient.ts').PathExplanation> {
    return this.engine.explainPath(abs, this.repos, this.refs, this.shadowDir)
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this._onDidChange.dispose()
  }
}
