import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { RepoInfo, CheckpointRef, ChangeItem, ChangeStatus, Hunk } from './types.ts'
import { runGit, gitText, gitOk, NO_CRLF } from './git.ts'
import { repoKey } from './paths.ts'
import { shadowRepoPath, excludePathspecsForAdd } from './checkpoint.ts'

let counter = 0
function tmpIndexPath(key: string): string {
  counter += 1
  return path.join(os.tmpdir(), `oc-col-${key}-${process.pid}-${Date.now()}-${counter}`)
}

// The checkpoint commit is a dangling object in the repo (durable only in the shadow). If it
// was GC'd — or the repo was deleted and re-created — refetch it from the shadow so diff-index
// and cat-file can see it. Fetching sets FETCH_HEAD only (no persistent ref added).
export function ensureCommitPresent(repoRoot: string, cp: CheckpointRef, shadowDir: string): void {
  if (gitOk(['cat-file', '-e', `${cp.commit}^{commit}`], repoRoot)) return
  const shadow = shadowRepoPath(shadowDir, repoRoot).split(path.sep).join('/')
  runGit(['fetch', '--quiet', shadow, cp.ref], repoRoot)
}

function mapStatus(letter: string): ChangeStatus {
  if (letter.startsWith('A')) return 'add'
  if (letter.startsWith('D')) return 'del'
  if (letter.startsWith('R')) return 'rename'
  return 'mod' // M, T (typechange), C, ...
}

function isUnderNested(relPath: string, nested: string[]): boolean {
  return nested.some((c) => relPath === c || relPath.startsWith(c + '/'))
}

// Split a `diff-index -p` patch into the header (everything before the first @@) and the
// individual @@ hunks. Each hunk carries the shared header so it can be reverse-applied alone.
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

export function collectChanges(
  checkpoints: Map<string, CheckpointRef>,
  repos: RepoInfo[],
  opts?: { shadowDir?: string },
): ChangeItem[] {
  const items: ChangeItem[] = []
  const byRoot = new Map(repos.map((r) => [r.repoRoot, r]))

  for (const [repoRoot, cp] of checkpoints) {
    const repo = byRoot.get(repoRoot)
    if (!repo) continue
    const cwd = repoRoot
    if (opts?.shadowDir) ensureCommitPresent(repoRoot, cp, opts.shadowDir)

    const idx = tmpIndexPath(repoKey(repoRoot))
    try {
      try { fs.rmSync(idx, { force: true }) } catch {}
      const env = { GIT_INDEX_FILE: idx }
      const excl = repo.nestedChildren.map((c) => `:(exclude,literal)${c}`)

      // `add` gets the ignore-filtered excludes (a gitignored child in ANY pathspec makes
      // add exit 1 — SPEC T25); diff-index has no such trap, so it keeps the full list.
      const add = runGit([...NO_CRLF, 'add', '-A', '--', '.', ...excludePathspecsForAdd(repo.nestedChildren, cwd, env)], cwd, env)
      if (add.status !== 0) throw new Error(`collect add failed in ${cwd}: ${add.stderr.trim()}`)

      // --no-renames = authoritative revert model (an -M R100 fabricated from an unrelated
      // delete+add would couple two independently-revertable files — SPEC T11).
      // --cached compares the checkpoint tree to OUR temp index (a pure worktree snapshot),
      // not to the live worktree — this is what makes deletions/additions report correctly.
      const nameStatus = gitText(
        [...NO_CRLF, 'diff-index', '--cached', '-z', '--no-renames', '--name-status', cp.commit, '--', '.', ...excl],
        cwd,
        env,
      )
      const toks = nameStatus.split('\0').filter((t) => t.length > 0)
      let k = 0
      while (k < toks.length) {
        const status = mapStatus(toks[k++])
        const p = toks[k++]
        if (p === undefined) break
        if (isUnderNested(p, repo.nestedChildren)) continue // defensive vs a missed nested repo

        const numstat = gitText([...NO_CRLF, 'diff-index', '--cached', '--numstat', cp.commit, '--', p], cwd, env)
        const firstLine = numstat.split('\n').find((l) => l.trim().length > 0) ?? ''
        const isBinary = firstLine.startsWith('-\t-')

        let patchHeader = ''
        let hunks: Hunk[] = []
        let modeChange: { from: string; to: string } | undefined
        if (!isBinary && status !== 'del') {
          const patch = gitText([...NO_CRLF, 'diff-index', '--cached', '-p', '--unified=1', cp.commit, '--', p], cwd, env)
          if (patch.includes('160000')) continue // defensive gitlink drop
          const s = splitPatch(patch)
          patchHeader = s.header
          hunks = s.hunks.map((h) => ({ header: h.header, body: h.body, agentAttributed: true }))
          const om = patchHeader.match(/^old mode (\d+)/m)
          const nm = patchHeader.match(/^new mode (\d+)/m)
          if (om && nm) modeChange = { from: om[1], to: nm[1] }
        }

        // NOTE: agentAttributed defaults true / coTouchedByUser false — valid for the
        // review-after-turn workflow (user not editing concurrently). Detecting concurrent
        // user edits requires an AgentWriteRecord (SPEC open risk #1), wired at P1.
        items.push({ repoRoot, path: p, status, isBinary, modeChange, hunks, patchHeader, coTouchedByUser: false })
      }
    } finally {
      try { fs.rmSync(idx, { force: true }) } catch {}
    }
  }
  return items
}
