import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { RepoInfo, CheckpointRef, ChangeItem, Hunk } from './types.ts'
import { runGit, gitText, gitBuffer } from './git.ts'
import { assertSafeRelPath } from './paths.ts'
import { removeFileSync } from './fsx.ts'
import { ensureCommitPresent } from './collect.ts'

let counter = 0
function tmpPatchPath(): string {
  counter += 1
  return path.join(os.tmpdir(), `oc-hunk-${process.pid}-${Date.now()}-${counter}.patch`)
}

function repoOf(repoRoot: string, repos: RepoInfo[]): RepoInfo {
  const r = repos.find((x) => x.repoRoot === repoRoot)
  if (!r) throw new Error(`no repo info for ${repoRoot}`)
  return r
}

// The ONLY byte-exact restore: raw blob write, bypassing all smudge filters. checkout-index /
// read-tree re-smudge (LF->CRLF under autocrlf=true, and in-tree `.gitattributes eol=crlf`
// beats even -c core.autocrlf=false). SPEC T14/T15.
function writeBlobToFile(repoRoot: string, commit: string, relPath: string): void {
  const blobSha = gitText(['rev-parse', `${commit}:${relPath}`], repoRoot).trim()
  const buf = gitBuffer(['cat-file', 'blob', blobSha], repoRoot)
  const abs = path.join(repoRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
}

export function revertFile(
  item: ChangeItem,
  checkpoints: Map<string, CheckpointRef>,
  repos: RepoInfo[],
  opts?: { shadowDir?: string; allowCoTouched?: boolean },
): void {
  const repo = repoOf(item.repoRoot, repos)
  assertSafeRelPath(item.path, repo.nestedChildren) // `-C` does not enforce boundaries (SPEC T23)
  if (item.coTouchedByUser && !opts?.allowCoTouched) {
    throw new Error(`refusing revertFile: '${item.path}' was co-touched by the user (would lose their edits)`)
  }
  const cp = checkpoints.get(item.repoRoot)
  if (!cp) throw new Error(`no checkpoint for ${item.repoRoot}`)
  if (opts?.shadowDir) ensureCommitPresent(item.repoRoot, cp, opts.shadowDir)

  const abs = path.join(item.repoRoot, item.path)
  if (item.status === 'add') {
    removeFileSync(abs) // agent-added file is absent in checkpoint -> delete on disk
    return
  }
  writeBlobToFile(item.repoRoot, cp.commit, item.path) // covers mod and del (restore)
  if (item.modeChange) {
    try { fs.chmodSync(abs, parseInt(item.modeChange.from.slice(-3), 8)) } catch {}
  }
}

export function revertHunk(item: ChangeItem, hunk: Hunk, repos: RepoInfo[]): void {
  if (!hunk.agentAttributed) throw new Error('refusing revertHunk: hunk not agent-attributed')
  if (item.coTouchedByUser) throw new Error('refusing revertHunk: file co-touched by user')
  const repo = repoOf(item.repoRoot, repos)
  assertSafeRelPath(item.path, repo.nestedChildren)

  let header = item.patchHeader
  if (!header.endsWith('\n')) header += '\n'
  let body = hunk.body
  if (!body.endsWith('\n')) body += '\n'
  const patch = `${header}${hunk.header}\n${body}`
  const patchFile = tmpPatchPath()
  try {
    fs.writeFileSync(patchFile, patch, 'utf8')
    const res = runGit(['apply', '-R', patchFile], item.repoRoot)
    if (res.status !== 0) throw new Error(`revertHunk apply failed for ${item.path}: ${res.stderr.trim()}`)
  } finally {
    try { fs.rmSync(patchFile, { force: true }) } catch {}
  }
}

export function revertRepo(
  repoRoot: string,
  checkpoints: Map<string, CheckpointRef>,
  changes: ChangeItem[],
  repos: RepoInfo[],
  opts?: { shadowDir?: string; agentAdded?: Set<string> },
): void {
  const repo = repoOf(repoRoot, repos)
  const cp = checkpoints.get(repoRoot)
  if (!cp) throw new Error(`no checkpoint for ${repoRoot}`)
  if (opts?.shadowDir) ensureCommitPresent(repoRoot, cp, opts.shadowDir)

  // (A) restore every checkpoint file byte-exact (covers modified + deleted). NEVER git clean /
  // read-tree --reset / reset --hard — they destroy user untracked files and nested repos
  // (SPEC T20/T22). The checkpoint tree already excludes nested repos, so this never enters one.
  const lsTree = gitText(['ls-tree', '-r', '-z', cp.commit], repoRoot)
  for (const entry of lsTree.split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, sha] = entry.slice(0, tab).split(' ')
    const relPath = entry.slice(tab + 1)
    if (type !== 'blob') continue // defensively skip any 160000 gitlink
    try { assertSafeRelPath(relPath, repo.nestedChildren) } catch { continue }
    const buf = gitBuffer(['cat-file', 'blob', sha], repoRoot)
    const abs = path.join(repoRoot, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, buf)
    try { fs.chmodSync(abs, parseInt(mode.slice(-3), 8)) } catch {}
  }

  // (B) delete ONLY files known to be agent-added (opts.agentAdded from the AgentWriteRecord).
  // Without that evidence we do NOT delete adds — a user's untracked file also shows as `add`,
  // and deleting it would be unrecoverable data loss (SPEC open risk #1).
  for (const item of changes) {
    if (item.repoRoot !== repoRoot || item.status !== 'add') continue
    if (!opts?.agentAdded || !opts.agentAdded.has(item.path)) continue
    try { assertSafeRelPath(item.path, repo.nestedChildren) } catch { continue }
    removeFileSync(path.join(repoRoot, item.path))
  }
}
