import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { RepoInfo, CheckpointRef, ChangeItem, ChangeStatus, Hunk } from './types.ts'
import { runGit, gitText, gitOk, NO_CRLF } from './git.ts'
import { reviewIndexPath } from './paths.ts'
import {
  shadowRepoPath,
  excludePathspecsForAdd,
  pruneIndexToScope,
  reconcileWholeWorktree,
} from './checkpoint.ts'
import {
  coalesceRepoPaths,
  excludeLiteralPathspec,
  isRepoPathInScope,
  literalPathspec,
  projectPathsToScope,
  scopeBoundaryPaths,
  scopePositivePaths,
} from './scope.ts'

// The checkpoint commit is a root snapshot durable in shadow. Re-fetch it if the source
// repo was GC'd/re-created. FETCH_HEAD is the only source-repo state touched.
export function ensureCommitPresent(repoRoot: string, cp: CheckpointRef, shadowDir: string): void {
  if (gitOk(['cat-file', '-e', `${cp.commit}^{commit}`], repoRoot)) return
  const shadow = shadowRepoPath(shadowDir, repoRoot).split(path.sep).join('/')
  const r = runGit(['fetch', '--quiet', shadow, cp.ref], repoRoot)
  if (r.status !== 0) throw new Error(`cannot restore checkpoint ${cp.commit} in ${repoRoot}: ${r.stderr.trim()}`)
}

function mapStatus(letter: string): ChangeStatus {
  if (letter.startsWith('A')) return 'add'
  if (letter.startsWith('D')) return 'del'
  if (letter.startsWith('R')) return 'rename'
  return 'mod'
}

// Split a patch into the shared file header and individual @@ hunks.
function splitPatch(patch: string): { header: string; hunks: { header: string; body: string }[] } {
  const lines = patch.split('\n')
  const header: string[] = []
  const hunks: { header: string; body: string }[] = []
  let i = 0
  while (i < lines.length && !lines[i].startsWith('@@')) header.push(lines[i++])
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) { i++; continue }
    const hHeader = lines[i++]
    const body: string[] = []
    while (i < lines.length && !lines[i].startsWith('@@')) body.push(lines[i++])
    hunks.push({ header: hHeader, body: body.join('\n') })
  }
  return { header: header.join('\n'), hunks }
}

function initReviewIndex(repo: RepoInfo, cp: CheckpointRef, idx: string): { env: { GIT_INDEX_FILE: string }; cold: boolean } {
  fs.mkdirSync(path.dirname(idx), { recursive: true })
  const env = { GIT_INDEX_FILE: idx }
  if (fs.existsSync(idx)) return { env, cold: false }
  // Starting from the checkpoint tree reuses every baseline blob. The old implementation
  // started empty and re-hashed the whole worktree after every extension restart.
  gitText(['read-tree', cp.commit], repo.repoRoot, env)
  return { env, cold: true }
}

function trackedUnder(paths: string[], repo: RepoInfo, env: { GIT_INDEX_FILE: string }): string[] {
  if (paths.length === 0) return []
  return gitText(['ls-files', '-z', '--', ...paths.map(literalPathspec)], repo.repoRoot, env).split('\0').filter(Boolean)
}

function reconcilePaths(repo: RepoInfo, env: { GIT_INDEX_FILE: string }, rawPaths: string[]): string[] {
  const paths = projectPathsToScope(repo, coalesceRepoPaths(rawPaths))
  if (paths.length === 0) return []
  const tracked = trackedUnder(paths, repo, env)
  const active = paths.filter((p) => {
    const hasTracked = tracked.some((t) => t === p || t.startsWith(p + '/'))
    const abs = path.join(repo.repoRoot, p)
    if (!fs.existsSync(abs)) return hasTracked // deletion, or a now-empty tracked directory
    // An explicit ignored-untracked path makes `git add` exit 1. Tracked paths remain valid.
    return hasTracked || !gitOk(['check-ignore', '-q', '--no-index', '--', p], repo.repoRoot)
  })
  if (active.length === 0) return paths // caller still removes stale ChangeItems for these paths
  const relevantBoundaries = scopeBoundaryPaths(repo).filter((boundary) =>
    active.some((p) => p === '.' || boundary === p || boundary.startsWith(p.replace(/\/$/, '') + '/')),
  )
  const args = [
    ...NO_CRLF,
    '-c', 'advice.addEmbeddedRepo=false',
    'add', '-A', '--',
    ...active.map(literalPathspec),
    ...excludePathspecsForAdd(relevantBoundaries, repo.repoRoot, env),
  ]
  const add = runGit(args, repo.repoRoot, env)
  if (add.status !== 0) throw new Error(`incremental add failed in ${repo.repoRoot}: ${add.stderr.trim()}`)
  return paths
}

type RawEntry = {
  path: string
  status: ChangeStatus
  oldMode: string
  newMode: string
  oldOid: string
  newOid: string
}

function diffArgs(cp: CheckpointRef, repo: RepoInfo, queryPaths: string[]): string[] {
  return [
    '--cached', '--no-renames', cp.commit, '--',
    ...queryPaths.map(literalPathspec),
    ...scopeBoundaryPaths(repo).map(excludeLiteralPathspec),
  ]
}

function rawEntries(cp: CheckpointRef, repo: RepoInfo, env: { GIT_INDEX_FILE: string }, queryPaths: string[]): RawEntry[] {
  if (queryPaths.length === 0) return []
  const text = gitText(['diff-index', '--raw', '-z', '--no-abbrev', ...diffArgs(cp, repo, queryPaths)], repo.repoRoot, env)
  const toks = text.split('\0').filter(Boolean)
  const out: RawEntry[] = []
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const m = toks[i].match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/)
    const p = toks[i + 1]
    if (!m || !p || !isRepoPathInScope(repo, p)) continue
    out.push({ path: p, status: mapStatus(m[5]), oldMode: m[1], newMode: m[2], oldOid: m[3], newOid: m[4] })
  }
  return out
}

function numstats(
  cp: CheckpointRef,
  repo: RepoInfo,
  env: { GIT_INDEX_FILE: string },
  queryPaths: string[],
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  if (queryPaths.length === 0) return out
  const text = gitText(['diff-index', '--numstat', '-z', ...diffArgs(cp, repo, queryPaths)], repo.repoRoot, env)
  for (const rec of text.split('\0')) {
    if (!rec) continue
    const first = rec.indexOf('\t')
    const second = first < 0 ? -1 : rec.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const a = rec.slice(0, first)
    const d = rec.slice(first + 1, second)
    const p = rec.slice(second + 1)
    out.set(p, { additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d), binary: a === '-' && d === '-' })
  }
  return out
}

function splitFilePatches(text: string): string[] {
  const starts: number[] = []
  const re = /^diff --git /gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) starts.push(m.index)
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length).replace(/\n+$/, '\n'))
}

function batchPatches(
  cp: CheckpointRef,
  repo: RepoInfo,
  env: { GIT_INDEX_FILE: string },
  paths: string[],
): Map<string, string> {
  const out = new Map<string, string>()
  if (paths.length === 0) return out
  const text = gitText(
    ['-c', 'core.quotePath=false', ...NO_CRLF, 'diff-index', '-p', '--unified=1', ...diffArgs(cp, repo, paths)],
    repo.repoRoot,
    env,
  )
  const unmatched = new Set(paths)
  for (const chunk of splitFilePatches(text)) {
    const first = chunk.slice(0, chunk.indexOf('\n'))
    let p = [...unmatched].find((candidate) => first === `diff --git a/${candidate} b/${candidate}`)
    if (!p) p = [...unmatched].find((candidate) => chunk.split('\n').includes(`+++ b/${candidate}`))
    if (!p && unmatched.size === 1) p = unmatched.values().next().value
    if (p) {
      out.set(p, chunk)
      unmatched.delete(p)
    }
  }
  // Exotic filenames may still be quoted even with core.quotePath=false. Preserve correctness
  // with a per-file fallback only for those rare unmatched paths.
  for (const p of unmatched) {
    out.set(p, gitText([...NO_CRLF, 'diff-index', '-p', '--unified=1', ...diffArgs(cp, repo, [p])], repo.repoRoot, env))
  }
  return out
}

export type CollectOptions = {
  shadowDir?: string
  // Missing entry = authoritative full reconcile for that repo. Present entry = update/query
  // only those repo-relative files or directory prefixes and return a PARTIAL result.
  pathsByRepo?: Map<string, string[] | undefined>
}

export function collectChanges(checkpoints: Map<string, CheckpointRef>, repos: RepoInfo[], opts?: CollectOptions): ChangeItem[] {
  const items: ChangeItem[] = []
  const byRoot = new Map(repos.map((r) => [r.repoRoot, r]))
  const baseDir = opts?.shadowDir || os.tmpdir()

  for (const [repoRoot, cp] of checkpoints) {
    if (opts?.pathsByRepo && !opts.pathsByRepo.has(repoRoot)) continue
    const repo = byRoot.get(repoRoot)
    if (!repo) continue
    if (opts?.shadowDir) ensureCommitPresent(repoRoot, cp, opts.shadowDir)
    const idx = reviewIndexPath(baseDir, repoRoot)
    let { env, cold } = initReviewIndex(repo, cp, idx)
    const requested = opts?.pathsByRepo?.get(repoRoot)
    let queryPaths: string[]
    try {
      if (requested === undefined || cold) {
        pruneIndexToScope(repo, env)
        reconcileWholeWorktree(repo, env)
        queryPaths = requested === undefined ? scopePositivePaths(repo) : projectPathsToScope(repo, requested)
      } else queryPaths = reconcilePaths(repo, env, requested)
    } catch {
      // Rebuild from the checkpoint and do one authoritative full reconcile. This makes a
      // stale/corrupt persistent index self-healing without silently dropping a change.
      try { fs.rmSync(idx, { force: true }) } catch {}
      ;({ env } = initReviewIndex(repo, cp, idx))
      pruneIndexToScope(repo, env)
      reconcileWholeWorktree(repo, env)
      queryPaths = requested === undefined ? scopePositivePaths(repo) : projectPathsToScope(repo, requested)
      cold = false
    }

    const raw = rawEntries(cp, repo, env, queryPaths)
    const stats = numstats(cp, repo, env, queryPaths)
    const patchPaths = raw.filter((e) => e.status !== 'del' && !stats.get(e.path)?.binary).map((e) => e.path)
    const patches = batchPatches(cp, repo, env, patchPaths)

    for (const e of raw) {
      const stat = stats.get(e.path) ?? { additions: 0, deletions: 0, binary: false }
      const patch = patches.get(e.path) ?? ''
      const split = patch ? splitPatch(patch) : { header: '', hunks: [] }
      const modeChange = e.oldMode !== '000000' && e.newMode !== '000000' && e.oldMode !== e.newMode
        ? { from: e.oldMode, to: e.newMode }
        : undefined
      const hunks: Hunk[] = split.hunks.map((h) => ({ header: h.header, body: h.body, agentAttributed: true }))
      items.push({
        repoRoot,
        path: e.path,
        status: e.status,
        isBinary: stat.binary,
        modeChange,
        hunks,
        patchHeader: split.header,
        additions: stat.additions,
        deletions: stat.deletions,
        oldOid: e.oldOid,
        newOid: e.newOid,
        coTouchedByUser: false,
      })
    }
  }
  return items
}
