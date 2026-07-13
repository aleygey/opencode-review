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
  // Display-level move pairing: this 'rename' row absorbs a byte-identical delete row.
  // Revert still executes as delete+add underneath (safe model, SPEC T11).
  movedFrom?: ReviewItem
}

export type ReviewState = {
  baselineId: string | undefined
  baselineAt: number | undefined
  baselineNote: string | undefined // intent of this batch of changes (auto: the turn's user prompt)
  repos: RepoInfo[]
  items: ReviewItem[]
  missingRepos: { repoRoot: string; rel: string }[] // repos in the baseline whose worktree vanished
  // Repos discovered AFTER the baseline was taken (e.g. a repo cloned/created mid-session).
  // They have no checkpoint, so their changes are INVISIBLE until adopted — must be surfaced.
  newRepos: { repoRoot: string; rel: string; agentCreated: boolean }[]
}

const KEY_BASELINE = 'ocReview.baseline.v1'
const KEY_BASELINE_PREV = 'ocReview.baseline.prev.v1' // one-step recovery from an accidental re-baseline
const KEY_HISTORY = 'ocReview.baseline.history.v1'
const HISTORY_CAP = 30

export type StoredBaseline = { id: string; at: number; refs: CheckpointRef[]; note?: string }

export class ReviewController {
  private repos: RepoInfo[] = []
  private refs: CheckpointRef[] = []
  private baselineId: string | undefined
  private baselineAt: number | undefined
  private baselineNote: string | undefined
  private items: ReviewItem[] = []
  private missingRepos: { repoRoot: string; rel: string }[] = []
  private newRepos: { repoRoot: string; rel: string; agentCreated: boolean }[] = []
  private reviewed = new Set<string>() // `${repoRoot}\0${path}`
  private itemIndex = new Map<string, ReviewItem>()
  private refreshTimer: NodeJS.Timeout | undefined
  private refreshFirstAt: number | undefined // debounce max-wait anchor

  // ---- incremental refresh state ----
  // Only re-collect the repos whose files actually changed; skip a refresh entirely when
  // nothing relevant changed. This turns a refresh from O(all repos) into O(changed repos)
  // — the main scan-latency win on a large workspace.
  private dirtyPaths = new Map<string, Set<string>>() // repoRoot -> repo-relative paths/prefixes
  private dirtyFullRepos = new Set<string>() // ignore/scope semantics changed; reconcile whole repo
  private needsDiscover = true // re-run discoverRepos (repo set may have changed)
  private haveCollected = false // we hold a valid items snapshot to merge onto
  private refreshRequested: 'auto' | 'full' | undefined
  private refreshRunning: Promise<boolean> | undefined

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
      this.baselineNote = stored.note
      this.refs = stored.refs
      this.log.info(`restored baseline ${stored.id} (${stored.refs.length} repos)`)
    }
  }

  state(): ReviewState {
    return {
      baselineId: this.baselineId,
      baselineAt: this.baselineAt,
      baselineNote: this.baselineNote,
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
    return this.itemIndex.get(normcase(abs))
  }

  getRefs(): CheckpointRef[] {
    return this.refs
  }
  getRepos(): RepoInfo[] {
    return this.repos
  }

  async ensureRepos(): Promise<RepoInfo[]> {
    const skip = vscode.workspace.getConfiguration('ocReview').get<string[]>('excludeDirs', [])
    const include = vscode.workspace.getConfiguration('ocReview').get<string[]>('includePaths', [])
    this.repos = await this.engine.discover(this.workspaceRoot, skip, include)
    return this.repos
  }

  private setItems(items: ReviewItem[]): void {
    this.items = items
    this.itemIndex = new Map(items.map((item) => [normcase(item.abs), item]))
  }

  // New baseline = checkpoint every repo now; clears review marks.
  newBaseline(reason: string, note?: string): Promise<void> {
    return this.serialize(() => this.doNewBaseline(reason, note))
  }

  private async doNewBaseline(reason: string, note?: string): Promise<void> {
    // Clear FIRST: agent writes observed while the (slow) checkpoint runs must survive
    // into the new epoch — clearing afterwards wiped mid-checkpoint captures.
    this.agentWrites.clear()
    await this.ensureRepos()
    this.needsDiscover = false
    // Start a new dirty epoch immediately before snapshotting. Events that arrive while the
    // checkpoint runs survive and are reconciled path-by-path against the new baseline.
    this.dirtyPaths.clear()
    this.dirtyFullRepos.clear()
    const id = `vs-${Date.now()}`
    const checkpointStarted = Date.now()
    this.log.info(`checkpoint (${reason}) id=${id} repos=${this.repos.length}`)
    const refs = await this.engine.checkpoint(this.repos, this.shadowDir, id)
    this.log.info(`checkpoint completed in ${Date.now() - checkpointStarted}ms`)
    // Retire the current baseline into HISTORY — the shadow refs are permanent, so any
    // historical baseline can later be re-viewed or reverted to (batch rollback).
    const prev = this.memento.get<StoredBaseline>(KEY_BASELINE)
    if (prev) {
      await this.memento.update(KEY_BASELINE_PREV, prev)
      await this.pushHistory(prev)
    }
    this.refs = refs
    this.baselineId = id
    this.baselineAt = Date.now()
    this.baselineNote = note
    this.reviewed.clear()
    await this.memento.update(KEY_BASELINE, { id, at: this.baselineAt, refs, note } satisfies StoredBaseline)
    this.setItems([])
    this.missingRepos = []
    this.newRepos = []
    // checkpoint deliberately leaves its authoritative index for collect, so no second cold
    // scan is needed. Only paths written during checkpoint remain in dirtyPaths above.
    this.haveCollected = true
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
      this.refreshFirstAt = undefined
    }
    // Turn-start must be authoritative → FULL collect, never a scoped/skipped one.
    const authoritative = await this.refresh('full')
    if (authoritative && this.items.length === 0) {
      await this.newBaseline('turn-start (clean)')
    } else {
      this.log.info(`turn start: keeping baseline (${authoritative ? 'pending changes present' : 'collect not authoritative'})`)
    }
  }

  // Map a changed path to its deepest owning repo and retain the exact repo-relative path.
  // Returns false for paths intentionally outside the configured review scope.
  markPathDirty(abs: string): boolean {
    const base = path.basename(abs)
    if (base === '.git' || abs.split(/[\\/]/).includes('.git')) {
      this.needsDiscover = true
      return true
    }
    const owner = this.ownerRepo(abs)
    if (!owner) {
      this.needsDiscover = true // outside all known repos → a new dir/repo may have appeared
      return true
    }
    const repo = this.repos.find((r) => r.repoRoot === owner)!
    const rel = path.relative(owner, abs).split(path.sep).join('/') || '.'
    if (!this.pathInScope(repo, rel)) return false
    if (base === '.gitignore' || rel === '.git/info/exclude') {
      this.dirtyFullRepos.add(owner) // one ignore edit can change visibility of many paths
    } else {
      const set = this.dirtyPaths.get(owner) ?? new Set<string>()
      set.add(rel)
      this.dirtyPaths.set(owner, set)
    }
    return true
  }

  private pathInScope(repo: RepoInfo, rel: string): boolean {
    const clean = rel.split(path.sep).join('/').replace(/^\.\//, '')
    const under = (p: string) => clean === p || clean.startsWith(p + '/')
    if (repo.nestedChildren.some(under)) return false
    if ((repo.excludedPaths ?? []).some(under)) return false
    const names = new Set(repo.excludedDirNames ?? [])
    if (clean.split('/').some((s) => names.has(s))) return false
    return repo.includedPaths === undefined || repo.includedPaths.some((p) =>
      p === '.' || under(p) || clean === '.' || p.startsWith(clean.replace(/\/$/, '') + '/'),
    )
  }

  private markRepoFull(repoRoot: string): void {
    this.dirtyFullRepos.add(repoRoot)
    this.dirtyPaths.delete(repoRoot)
  }

  private ownerRepo(abs: string): string | undefined {
    let best: string | undefined
    for (const r of this.repos) {
      const rel = path.relative(r.repoRoot, abs) // path.relative normalizes mixed separators
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        if (best === undefined || r.repoRoot.length > best.length) best = r.repoRoot
      }
    }
    return best
  }

  private static readonly REFRESH_MAX_WAIT = 5000 // live preview cap; session.idle flushes sooner

  scheduleRefresh(delayMs = 800): void {
    const now = Date.now()
    if (this.refreshFirstAt === undefined) this.refreshFirstAt = now
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    // Debounce, but cap total delay so changes still surface during sustained agent activity
    // (the timer used to reset indefinitely → nothing showed until the turn went quiet).
    const capRemaining = this.refreshFirstAt + ReviewController.REFRESH_MAX_WAIT - now
    const delay = Math.max(0, Math.min(delayMs, capRemaining))
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.refreshFirstAt = undefined
      void this.refresh()
    }, delay)
  }

  // Returns true when the collect ran to completion (state is authoritative).
  // 'auto' = scoped when possible (only dirty repos), 'full' = discover + collect everything.
  refresh(mode: 'auto' | 'full' = 'auto'): Promise<boolean> {
    // Coalesce all refresh requests into one drain loop. A slow repository can therefore
    // never accumulate an unbounded chain of stale scans every REFRESH_MAX_WAIT milliseconds.
    if (mode === 'full' || this.refreshRequested === undefined) this.refreshRequested = mode
    if (this.refreshRunning) return this.refreshRunning
    this.refreshRunning = this.serialize(async () => {
      let ok = true
      while (this.refreshRequested) {
        const next = this.refreshRequested
        this.refreshRequested = undefined
        ok = (await this.doRefresh(next)) && ok
      }
      return ok
    }).finally(() => {
      this.refreshRunning = undefined
      // Covers the narrow race where an event arrives after the drain loop's final check.
      if (this.refreshRequested) void this.refresh()
    })
    return this.refreshRunning
  }

  private async doRefresh(mode: 'auto' | 'full'): Promise<boolean> {
    if (!this.hasBaseline()) {
      this._onDidChange.fire(this.state())
      return true
    }
    try {
      if (mode === 'full' || this.needsDiscover || !this.haveCollected) return await this.fullCollect()
      return await this.scopedCollect()
    } catch (e: any) {
      if (mode === 'full') {
        this.needsDiscover = true
        this.haveCollected = false
      }
      this.log.error(`refresh failed: ${e?.message ?? e}`)
      return false
    }
  }

  private async fullCollect(): Promise<boolean> {
    const started = Date.now()
    // Clear BEFORE the scan. Events arriving during Git work remain dirty for the next pass.
    this.dirtyPaths.clear()
    this.dirtyFullRepos.clear()
    this.needsDiscover = false
    await this.ensureRepos()
    const present = this.refs.filter((r) => this.repos.some((x) => x.repoRoot === r.repoRoot))
    // A baseline repo whose worktree vanished is data loss in progress — surface it (finding #8).
    this.missingRepos = this.refs
      .filter((r) => !present.includes(r))
      .map((r) => ({ repoRoot: r.repoRoot, rel: path.relative(this.workspaceRoot, r.repoRoot).split(path.sep).join('/') || '.' }))
    // Repos that appeared after the baseline: invisible until adopted — surface them (finding #1).
    this.newRepos = this.repos
      .filter((r) => !this.refs.some((x) => x.repoRoot === r.repoRoot))
      .map((r) => ({ repoRoot: r.repoRoot, rel: r.relToWorkspace, agentCreated: this.agentWrites.hasUnder(r.repoRoot) }))
    const raw = await this.engine.collect(present, this.repos, this.shadowDir)
    this.setItems(raw.map((it) => this.classify(it)))
    this.pairMoves()
    this.haveCollected = true
    this._onDidChange.fire(this.state())
    this.log.info(`collect FULL ${Date.now() - started}ms: ${this.items.length} file(s)${this.missingRepos.length ? `; ${this.missingRepos.length} MISSING repo(s)` : ''}`)
    return true
  }

  private async scopedCollect(): Promise<boolean> {
    const started = Date.now()
    const pathsSnapshot = new Map(this.dirtyPaths)
    const fullSnapshot = new Set(this.dirtyFullRepos)
    // Clear BEFORE awaiting Git. New events land in fresh collections and cannot be erased.
    for (const root of pathsSnapshot.keys()) this.dirtyPaths.delete(root)
    for (const root of fullSnapshot) this.dirtyFullRepos.delete(root)
    const dirty = [...new Set([...pathsSnapshot.keys(), ...fullSnapshot])].filter(
      (root) => this.repos.some((x) => x.repoRoot === root) && this.refs.some((r) => r.repoRoot === root),
    )
    if (dirty.length === 0) return true
    const refsSubset = this.refs.filter((r) => dirty.includes(r.repoRoot))
    const pathRequests = dirty.map((repoRoot) => ({
      repoRoot,
      paths: fullSnapshot.has(repoRoot) ? undefined : [...(pathsSnapshot.get(repoRoot) ?? [])],
    }))
    let raw: ChangeItem[]
    try {
      raw = await this.engine.collect(refsSubset, this.repos, this.shadowDir, pathRequests)
    } catch (e) {
      // A transient Git/worker failure must not consume the dirty generation.
      for (const [root, paths] of pathsSnapshot) {
        const pending = this.dirtyPaths.get(root) ?? new Set<string>()
        for (const p of paths) pending.add(p)
        this.dirtyPaths.set(root, pending)
      }
      for (const root of fullSnapshot) this.markRepoFull(root)
      throw e
    }
    const fresh = raw.map((it) => this.classify(it))
    // Expand display-only move pairs back to their authoritative add+delete rows before
    // merging, then re-pair by blob OID in O(changes).
    const expanded = this.items.flatMap((i) =>
      i.movedFrom
        ? [{ ...i, status: 'add' as const, oldPath: undefined, movedFrom: undefined }, i.movedFrom]
        : [i],
    )
    const affected = (i: ReviewItem): boolean => {
      if (fullSnapshot.has(i.repoRoot)) return true
      const paths = pathsSnapshot.get(i.repoRoot)
      return paths !== undefined && [...paths].some((p) => p === '.' || i.path === p || i.path.startsWith(p.replace(/\/$/, '') + '/'))
    }
    this.setItems(expanded.filter((i) => !affected(i)).concat(fresh))
    this.pairMoves()
    this._onDidChange.fire(this.state())
    const nPaths = [...pathsSnapshot.values()].reduce((n, s) => n + s.size, 0)
    this.log.info(`collect PATH ${Date.now() - started}ms (${dirty.length} repo, ${nPaths} path): ${this.items.length} file(s)`)
    return true
  }

  // A pure MOVE arrives from the engine as delete+add (--no-renames keeps revert safe —
  // git's rename detection can couple unrelated same-content files, SPEC T11). That reads
  // as confusing duplication in the tree, so pair BYTE-IDENTICAL del+add rows into one
  // 'moved' row for display. Moves-with-edits keep their honest D + A rows.
  private pairMoves(): void {
    const dels = this.items.filter((i) => i.status === 'del' && !i.isBinary)
    if (dels.length === 0) return
    const byBlob = new Map<string, ReviewItem[]>()
    for (const del of dels) {
      if (!del.oldOid) continue
      const key = `${del.repoRoot}\0${del.path.split('/').pop()}\0${del.oldOid}`
      const list = byBlob.get(key) ?? []
      list.push(del)
      byBlob.set(key, list)
    }
    const paired = new Set<ReviewItem>()
    for (const add of this.items) {
      if (add.status !== 'add' || add.isBinary || !add.newOid) continue
      const key = `${add.repoRoot}\0${add.path.split('/').pop()}\0${add.newOid}`
      const del = byBlob.get(key)?.find((d) => !paired.has(d))
      if (!del) continue
      paired.add(del)
      add.status = 'rename'
      add.oldPath = del.path
      add.movedFrom = del
      add.hunks = []
    }
    if (paired.size > 0) this.setItems(this.items.filter((i) => !paired.has(i)))
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

  // ---- undo/redo for revert operations (byte-level pre/post snapshots, in-memory) ----

  private undoStack: { label: string; pre: Map<string, Buffer | null>; post: Map<string, Buffer | null> }[] = []
  private redoStack: typeof this.undoStack = []

  private captureFiles(paths: string[]): Map<string, Buffer | null> {
    const m = new Map<string, Buffer | null>()
    for (const abs of paths) {
      try {
        m.set(abs, fs.readFileSync(abs))
      } catch {
        m.set(abs, null) // absent
      }
    }
    return m
  }

  private applyFiles(m: Map<string, Buffer | null>): void {
    for (const [abs, buf] of m) {
      if (buf === null) {
        try {
          fs.rmSync(abs, { force: true })
        } catch {}
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, buf)
      }
    }
  }

  private pushUndo(label: string, pre: Map<string, Buffer | null>, post: Map<string, Buffer | null>): void {
    this.undoStack.push({ label, pre, post })
    if (this.undoStack.length > 20) this.undoStack.shift()
    this.redoStack.length = 0
  }

  undoRevert(): Promise<{ label: string; paths: string[] } | undefined> {
    return this.serialize(async () => {
      const entry = this.undoStack.pop()
      if (!entry) return undefined
      this.applyFiles(entry.pre)
      this.redoStack.push(entry)
      for (const p of entry.pre.keys()) this.markPathDirty(p)
      await this.doRefresh('auto')
      return { label: entry.label, paths: [...entry.pre.keys()] }
    })
  }

  redoRevert(): Promise<{ label: string; paths: string[] } | undefined> {
    return this.serialize(async () => {
      const entry = this.redoStack.pop()
      if (!entry) return undefined
      this.applyFiles(entry.post)
      this.undoStack.push(entry)
      for (const p of entry.post.keys()) this.markPathDirty(p)
      await this.doRefresh('auto')
      return { label: entry.label, paths: [...entry.post.keys()] }
    })
  }

  undoRedoDepth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length }
  }

  // Reverts NEVER act on the stale classification captured at scan time: the file may have
  // been edited since. Re-classify against current disk and refuse on a fresh co-touch
  // unless the caller explicitly allowed it (review findings #2/#13).
  // Every revert returns the affected abs paths (for agent notification) and records a
  // byte-level pre/post snapshot for undo/redo.
  revertFile(item: ReviewItem, allowCoTouched: boolean): Promise<string[]> {
    // A paired move reverts BOTH halves atomically: delete the moved-to file, restore the
    // original location — one undo entry.
    if (item.movedFrom) {
      return this.serialize(async () => {
        const del = item.movedFrom!
        const paths = [item.abs, del.abs]
        const pre = this.captureFiles(paths)
        const asAdd: ReviewItem = { ...item, status: 'add', oldPath: undefined, movedFrom: undefined }
        await this.engine.revertFile(asAdd, this.refs, this.repos, this.shadowDir, allowCoTouched)
        await this.engine.revertFile(del, this.refs, this.repos, this.shadowDir, allowCoTouched)
        this.pushUndo(`还原移动 ${del.path} → ${item.path}`, pre, this.captureFiles(paths))
        this.markPathDirty(item.abs)
        this.markPathDirty(del.abs)
        await this.doRefresh('auto')
        return paths
      })
    }
    return this.serialize(async () => {
      const fresh = this.classify(item)
      if (fresh.coTouchedByUser && !item.coTouchedByUser && !allowCoTouched) {
        throw new Error(`'${item.path}' changed since the last scan — refresh and review the co-touched warning`)
      }
      const paths = [item.abs]
      const pre = this.captureFiles(paths)
      await this.engine.revertFile(fresh, this.refs, this.repos, this.shadowDir, allowCoTouched)
      this.pushUndo(`撤销文件 ${item.path}`, pre, this.captureFiles(paths))
      this.markPathDirty(item.abs)
      await this.doRefresh('auto')
      return paths
    })
  }

  revertHunk(item: ReviewItem, hunkIndex: number, allowUnverified = false): Promise<string[]> {
    return this.serialize(async () => {
      const fresh = this.classify(item)
      // A genuinely co-touched hunk mixes user + agent lines — reverse-applying it loses
      // the user's lines, so it stays hard-refused (file-level revert has its own guard).
      if (fresh.attribution === 'co-touched') {
        throw new Error(`'${item.path}' 混入了扫描后的手动修改 — 块级回退不安全,请用文件级回退`)
      }
      // 'unverified' (no observed agent write, e.g. TUI ran unattached) is allowed only
      // behind the caller's explicit confirmation dialog.
      if (fresh.attribution !== 'agent' && !allowUnverified) {
        throw new Error(`'${item.path}' is ${fresh.attribution} — 需要显式确认才能回退非 agent 归属的块`)
      }
      const hunk = fresh.hunks[hunkIndex]
      if (!hunk) throw new Error(`no hunk #${hunkIndex} — the file changed since the last scan; refresh first`)
      const paths = [item.abs]
      const pre = this.captureFiles(paths)
      // If the on-disk content drifted from the scanned hunk, `git apply -R` fails on
      // context mismatch — a safe, atomic-per-file failure surfaced to the user.
      await this.engine.revertHunk(fresh, hunk, this.repos, fresh.attribution !== 'agent')
      this.pushUndo(`撤销块 ${item.path}#${hunkIndex + 1}`, pre, this.captureFiles(paths))
      this.markPathDirty(item.abs)
      await this.doRefresh('auto')
      return paths
    })
  }

  revertRepo(repoRoot: string, deleteAgentAdded: boolean): Promise<string[]> {
    return this.serialize(async () => {
      const agentAdded = deleteAgentAdded
        ? this.items
            .filter((i) => i.repoRoot === repoRoot && i.status === 'add' && this.classify(i).attribution === 'agent')
            .map((i) => i.path)
        : []
      const paths = this.items.filter((i) => i.repoRoot === repoRoot).map((i) => i.abs)
      const pre = this.captureFiles(paths)
      await this.engine.revertRepo(repoRoot, this.refs, this.items, this.repos, this.shadowDir, agentAdded)
      this.pushUndo(`撤销仓库 ${path.basename(repoRoot)}`, pre, this.captureFiles(paths))
      this.markRepoFull(repoRoot)
      await this.doRefresh('auto')
      return paths
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
        note: this.baselineNote,
      } satisfies StoredBaseline)
      this.log.info(`adopted repo into baseline ${this.baselineId}: ${repoRoot}`)
      this.needsDiscover = true // the adopted repo joins the tracked set
      await this.doRefresh('full')
    })
  }

  explainPath(abs: string): Promise<import('../engineClient.ts').PathExplanation> {
    return this.engine.explainPath(abs, this.repos, this.refs, this.shadowDir)
  }

  // ---- baseline history / batch rollback ----

  private async pushHistory(b: StoredBaseline): Promise<void> {
    const hist = this.memento.get<StoredBaseline[]>(KEY_HISTORY, []).filter((x) => x.id !== b.id)
    hist.unshift(b)
    await this.memento.update(KEY_HISTORY, hist.slice(0, HISTORY_CAP))
  }

  history(): StoredBaseline[] {
    return this.memento.get<StoredBaseline[]>(KEY_HISTORY, [])
  }

  private async persistCurrent(): Promise<void> {
    if (!this.baselineId) return
    await this.memento.update(KEY_BASELINE, {
      id: this.baselineId,
      at: this.baselineAt ?? Date.now(),
      refs: this.refs,
      note: this.baselineNote,
    } satisfies StoredBaseline)
  }

  // Manual note (Rename Baseline command).
  async setBaselineNote(note: string): Promise<void> {
    this.baselineNote = note.trim() || undefined
    await this.persistCurrent()
    this._onDidChange.fire(this.state())
  }

  // Auto-intent: the user prompt that started a turn. First intent names the baseline;
  // later turns on the same baseline append (deduped, capped) so accumulated reviews
  // still say what they contain.
  async noteIntent(intent: string): Promise<void> {
    const t = intent.trim()
    if (!t) return
    if (!this.baselineNote) this.baselineNote = t
    else if (!this.baselineNote.includes(t)) this.baselineNote = `${this.baselineNote} | ${t}`.slice(0, 160)
    else return
    await this.persistCurrent()
    this._onDidChange.fire(this.state())
  }

  // Make a HISTORICAL baseline the review base (disk untouched): the change list then
  // shows the CUMULATIVE diff since that baseline — review or batch-revert from there.
  switchBaseline(id: string): Promise<void> {
    return this.serialize(async () => {
      const target = id === this.baselineId ? undefined : this.history().find((b) => b.id === id)
      if (!target) return
      const current = this.memento.get<StoredBaseline>(KEY_BASELINE)
      if (current) await this.pushHistory(current)
      this.refs = target.refs
      this.baselineId = target.id
      this.baselineAt = target.at
      this.baselineNote = target.note
      this.reviewed.clear()
      await this.memento.update(KEY_BASELINE, target)
      this.log.info(`switched review baseline -> ${target.id}`)
      this.haveCollected = false // whole review base changed → next collect must be full
      await this.doRefresh('full')
    })
  }

  // Batch rollback: revert EVERY repo to the current review baseline. Only agent-attributed
  // added files are deleted; unknown/user adds are kept (they reappear in the list after).
  revertAll(): Promise<string[]> {
    return this.serialize(async () => {
      const present = this.refs.filter((r) => this.repos.some((x) => x.repoRoot === r.repoRoot))
      const paths = this.items.map((i) => i.abs)
      const pre = this.captureFiles(paths)
      for (const ref of present) {
        const agentAdded = this.items
          .filter((i) => i.repoRoot === ref.repoRoot && i.status === 'add' && this.classify(i).attribution === 'agent')
          .map((i) => i.path)
        await this.engine.revertRepo(ref.repoRoot, this.refs, this.items, this.repos, this.shadowDir, agentAdded)
        this.log.info(`revertAll: ${ref.repoRoot} done (${agentAdded.length} agent-added deleted)`)
      }
      this.pushUndo(`批量回退到 ${this.baselineId}`, pre, this.captureFiles(paths))
      await this.doRefresh('full')
      return paths
    })
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this._onDidChange.dispose()
  }
}
