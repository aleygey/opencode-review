import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { discoverRepos } from '../src/discover.ts'
import { checkpoint, shadowRepoPath } from '../src/checkpoint.ts'
import { collectChanges } from '../src/collect.ts'
import { revertFile, revertHunk, revertRepo } from '../src/revert.ts'
import { removeFileSync, removeDirSync } from '../src/fsx.ts'
import type { ChangeItem } from '../src/types.ts'

const ID = 'test'

function rmrf(dir: string): void {
  try { removeDirSync(dir) } catch {}
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}
function gitBuf(args: string[], cwd: string): Buffer {
  return execFileSync('git', args, { cwd })
}
function initRepo(dir: string, autocrlf?: boolean): void {
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  git(['config', 'user.email', 'test@test'], dir)
  git(['config', 'user.name', 'test'], dir)
  if (autocrlf !== undefined) git(['config', 'core.autocrlf', String(autocrlf)], dir)
}
function commitAll(dir: string, msg = 'c'): void {
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', msg], dir)
}
function mkWorkspace(t: { after: (fn: () => void) => void }): { root: string; shadow: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-eng-'))
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shadow-'))
  t.after(() => { for (const d of [root, shadow]) rmrf(d) })
  return { root, shadow }
}
function topRootOf(root: string): string {
  return discoverRepos(root).find((r) => r.relToWorkspace === '.')!.repoRoot
}

test('discoverRepos finds nested independent repos and computes nestedChildren', (t) => {
  const { root } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'top.txt'), 'top\n')
  commitAll(root)
  const nested = path.join(root, 'sub', 'nested')
  initRepo(nested)
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'inner\n')
  commitAll(nested)

  const repos = discoverRepos(root)
  assert.deepEqual(repos.map((r) => r.relToWorkspace).sort(), ['.', 'sub/nested'])
  assert.deepEqual(repos.find((r) => r.relToWorkspace === '.')!.nestedChildren, ['sub/nested'])
})

test('T1: checkpoint excludes nested repo, is zero-side-effect, stores a shadow ref', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'top.txt'), 'a\n')
  commitAll(root)
  const nested = path.join(root, 'nested')
  initRepo(nested)
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'x\n')
  commitAll(nested)

  const before = {
    status: git(['status', '--porcelain'], root),
    head: git(['rev-parse', 'HEAD'], root).trim(),
    refs: git(['for-each-ref'], root),
  }
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })
  const after = {
    status: git(['status', '--porcelain'], root),
    head: git(['rev-parse', 'HEAD'], root).trim(),
    refs: git(['for-each-ref'], root),
  }
  assert.equal(after.status, before.status, 'status unchanged')
  assert.equal(after.head, before.head, 'HEAD unchanged')
  assert.equal(after.refs, before.refs, 'no ref added to the real repo')

  const cp = cps.get(topRootOf(root))!
  const treeFiles = git(['ls-tree', '-r', '--name-only', cp.commit], root).split('\n').filter(Boolean)
  assert.ok(treeFiles.includes('top.txt'))
  assert.ok(!treeFiles.some((f) => f === 'nested' || f.startsWith('nested/')), 'nested excluded from checkpoint tree')

  const sha = git(['rev-parse', cp.ref], shadowRepoPath(shadow, cp.repoRoot)).trim()
  assert.equal(sha, cp.commit, 'checkpoint durable in the shadow store')
})

test('T3: checkpoint captures CRLF bytes exactly even under autocrlf=true', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root, true)
  const crlf = Buffer.from('x\r\ny\r\n', 'utf8')
  fs.writeFileSync(path.join(root, 'crlf.txt'), crlf)
  commitAll(root)
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })
  const cp = cps.get(repos[0].repoRoot)!
  const blobSha = git(['rev-parse', `${cp.commit}:crlf.txt`], root).trim()
  assert.deepEqual(gitBuf(['cat-file', 'blob', blobSha], root), crlf, 'checkpoint blob is byte-exact CRLF')
})

test('T9: collect captures untracked add, deletion and binary; omits gitignored', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep\n')
  fs.writeFileSync(path.join(root, 'del.txt'), 'bye\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '*.ign\n')
  commitAll(root)
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })

  fs.writeFileSync(path.join(root, 'new.txt'), 'hello\n')
  fs.writeFileSync(path.join(root, 'secret.ign'), 'nope\n')
  removeFileSync(path.join(root, 'del.txt')) // simulate the agent deleting a file (robust on Windows)
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 66]))

  const byPath = new Map(collectChanges(cps, repos, { shadowDir: shadow }).map((i) => [i.path, i]))
  assert.equal(byPath.get('new.txt')?.status, 'add')
  assert.equal(byPath.get('del.txt')?.status, 'del')
  assert.equal(byPath.get('bin.dat')?.isBinary, true)
  assert.ok(!byPath.has('secret.ign'), 'gitignored file omitted')
})

test('T26: collect reuses a warm index across refreshes and stays authoritative', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n')
  commitAll(root)
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })

  // Refresh 1: one edit (this call seeds the persistent index).
  fs.writeFileSync(path.join(root, 'a.txt'), 'a-edited\n')
  let byPath = new Map(collectChanges(cps, repos, { shadowDir: shadow }).map((i) => [i.path, i]))
  assert.deepEqual([...byPath.keys()].sort(), ['a.txt'], 'refresh 1 sees only a.txt')

  // Refresh 2 (warm index): a NEW edit + a NEW untracked file + a deletion must all be picked
  // up — proves the reused index is reconciled to the current worktree, not stale.
  fs.writeFileSync(path.join(root, 'b.txt'), 'b-edited\n')
  fs.writeFileSync(path.join(root, 'c.txt'), 'c-new\n')
  removeFileSync(path.join(root, 'a.txt'))
  byPath = new Map(collectChanges(cps, repos, { shadowDir: shadow }).map((i) => [i.path, i]))
  assert.equal(byPath.get('a.txt')?.status, 'del', 'a.txt now deleted')
  assert.equal(byPath.get('b.txt')?.status, 'mod', 'b.txt modified')
  assert.equal(byPath.get('c.txt')?.status, 'add', 'c.txt added')

  // Refresh 3 (warm index): revert everything to baseline → zero changes reported.
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n')
  removeFileSync(path.join(root, 'c.txt'))
  const items = collectChanges(cps, repos, { shadowDir: shadow })
  assert.deepEqual(items, [], 'worktree back at baseline → clean, no phantom entries from the warm index')
})

test('T14: revertFile restores byte-exact content (no CRLF corruption under autocrlf=true)', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root, true)
  const original = Buffer.from('line1\nline2\nline3\n', 'utf8')
  fs.writeFileSync(path.join(root, 'f.txt'), original)
  commitAll(root)
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })
  fs.writeFileSync(path.join(root, 'f.txt'), 'MUTATED\n')

  const item = collectChanges(cps, repos, { shadowDir: shadow }).find((i) => i.path === 'f.txt')!
  revertFile(item, cps, repos, { shadowDir: shadow })
  assert.deepEqual(fs.readFileSync(path.join(root, 'f.txt')), original, 'reverted byte-exact LF, not smudged to CRLF')
})

test('T17: revertHunk reverts only the targeted hunk, leaving others intact', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  const base = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(path.join(root, 'f.txt'), base)
  commitAll(root)
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })
  fs.writeFileSync(path.join(root, 'f.txt'), base.replace('line2', 'EDIT2').replace('line8', 'EDIT8'))

  const item = collectChanges(cps, repos, { shadowDir: shadow }).find((i) => i.path === 'f.txt')!
  assert.ok(item.hunks.length >= 2, 'two separate hunks')
  revertHunk(item, item.hunks.find((h) => h.body.includes('EDIT2'))!, repos)

  const after = fs.readFileSync(path.join(root, 'f.txt'), 'utf8')
  assert.ok(after.includes('line2') && !after.includes('EDIT2'), 'EDIT2 reverted')
  assert.ok(after.includes('EDIT8'), 'other hunk untouched')
})

test('T21: revertRepo restores/deletes correctly and preserves nested repo + user untracked files', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'f.txt'), 'v1\n')
  fs.writeFileSync(path.join(root, 'del.txt'), 'removeme\n')
  commitAll(root)
  const nested = path.join(root, 'nested')
  initRepo(nested)
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'inner\n')
  commitAll(nested)

  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })
  const topRoot = topRootOf(root)

  fs.writeFileSync(path.join(root, 'user_precious.txt'), 'do not delete\n') // user untracked
  fs.writeFileSync(path.join(root, 'f.txt'), 'v2-agent\n')
  removeFileSync(path.join(root, 'del.txt')) // simulate the agent deleting a file (robust on Windows)
  fs.writeFileSync(path.join(root, 'agent_added.txt'), 'added by agent\n')
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'nested-changed\n')

  const items = collectChanges(cps, repos, { shadowDir: shadow })
  revertRepo(topRoot, cps, items, repos, { shadowDir: shadow, agentAdded: new Set(['agent_added.txt']) })

  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'v1\n', 'modified restored')
  assert.ok(fs.existsSync(path.join(root, 'del.txt')), 'deleted restored')
  assert.ok(!fs.existsSync(path.join(root, 'agent_added.txt')), 'agent-added removed')
  assert.ok(fs.existsSync(path.join(root, 'user_precious.txt')), 'user untracked preserved')
  assert.ok(fs.existsSync(path.join(nested, '.git')), 'nested repo preserved')
  assert.equal(fs.readFileSync(path.join(nested, 'inner.txt'), 'utf8'), 'nested-changed\n', 'nested untouched by top revert')
})

test('T23: revert refuses a path inside a nested repo (boundary guard)', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'top.txt'), 'a\n')
  commitAll(root)
  const nested = path.join(root, 'nested')
  initRepo(nested)
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'x\n')
  commitAll(nested)
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })

  const evil: ChangeItem = {
    repoRoot: topRootOf(root),
    path: 'nested/inner.txt',
    status: 'mod',
    isBinary: false,
    hunks: [],
    patchHeader: '',
  }
  assert.throws(() => revertFile(evil, cps, repos, { shadowDir: shadow }), /boundary/i)
})

test('T24: checkpoint is self-contained in an external shadow store (survives worktree loss)', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'top.txt'), 'a\n')
  commitAll(root)
  const nested = path.join(root, 'nested')
  initRepo(nested)
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'precious\n')
  commitAll(nested)
  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID })
  const nestedRoot = repos.find((r) => r.relToWorkspace === 'nested')!.repoRoot
  const cp = cps.get(nestedRoot)!
  const shadowRepo = shadowRepoPath(shadow, nestedRoot)

  // push transferred a full packfile — no alternates link back to the source, so the shadow's
  // objects do not depend on the source repo surviving. This is what "survives rm -rf" rests on.
  assert.ok(
    !fs.existsSync(path.join(shadowRepo, 'objects', 'info', 'alternates')),
    'shadow is self-contained (no alternates back to source)',
  )

  rmrf(nested) // best-effort: simulate the agent nuking the worktree (Windows may hold handles)

  // The full baseline is recoverable purely from the shadow, independent of the source repo.
  assert.equal(git(['rev-parse', cp.ref], shadowRepo).trim(), cp.commit, 'ref resolvable in shadow')
  const blobSha = git(['rev-parse', `${cp.commit}:inner.txt`], shadowRepo).trim()
  assert.equal(gitBuf(['cat-file', 'blob', blobSha], shadowRepo).toString('utf8'), 'precious\n', 'baseline recoverable from shadow alone')
})

test('T25: checkpoint/collect succeed when a nested repo is itself gitignored', (t) => {
  const { root, shadow } = mkWorkspace(t)
  initRepo(root)
  fs.writeFileSync(path.join(root, 'top.txt'), 'a\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '.opencode\nsource_code\n')
  commitAll(root)
  // Both gitignored nested repos AND a non-ignored one, so the ignore filter and the
  // exclude pathspec are exercised in the same checkpoint.
  for (const name of ['.opencode', 'source_code', 'plain_nested']) {
    const nested = path.join(root, name)
    initRepo(nested)
    fs.writeFileSync(path.join(nested, 'inner.txt'), 'x\n')
    commitAll(nested)
  }

  const repos = discoverRepos(root)
  const cps = checkpoint(repos, { shadowDir: shadow, id: ID }) // must not throw "paths are ignored"
  const cp = cps.get(topRootOf(root))!
  const treeFiles = git(['ls-tree', '-r', '--name-only', cp.commit], root).split('\n').filter(Boolean)
  assert.ok(treeFiles.includes('top.txt'))
  for (const name of ['.opencode', 'source_code', 'plain_nested']) {
    assert.ok(!treeFiles.some((f) => f === name || f.startsWith(name + '/')), `${name} not in checkpoint tree`)
  }

  fs.writeFileSync(path.join(root, 'new.txt'), 'hello\n')
  fs.writeFileSync(path.join(root, '.opencode', 'state.json'), '{}\n')
  const items = collectChanges(cps, repos, { shadowDir: shadow })
  const topItems = items.filter((i) => i.repoRoot === topRootOf(root))
  assert.deepEqual(topItems.map((i) => i.path), ['new.txt'], 'top repo reports only its own change')
  // the gitignored nested repo is still an independent repo with its own baseline
  assert.ok(items.some((i) => i.path === 'state.json' && i.repoRoot !== topRootOf(root)))
})
