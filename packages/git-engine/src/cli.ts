// CLI for the opencode git-engine. Zero deps; run with Node >=22.6 (Node 24 runs .ts natively).
//
//   node src/cli.ts demo                                 self-contained end-to-end demo (safe, temp dir)
//   node src/cli.ts discover   <workspace>
//   node src/cli.ts checkpoint <workspace> [shadowDir] [id]
//   node src/cli.ts status     <workspace> [shadowDir] [id]
//   node src/cli.ts revert-file <workspace> <path> [shadowDir] [id]
//   node src/cli.ts revert-repo <workspace> <repoRelToWorkspace> [shadowDir] [id] [--delete-added]
//
// Defaults: shadowDir = <tmp>/oc-shadow, id = "default".
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { RepoInfo, CheckpointRef, ChangeItem } from './types.ts'
import { discoverRepos } from './discover.ts'
import { checkpoint, shadowRepoPath } from './checkpoint.ts'
import { collectChanges } from './collect.ts'
import { revertFile, revertRepo } from './revert.ts'
import { runGit, gitText, gitOk } from './git.ts'
import { norm } from './paths.ts'
import { removeFileSync, removeDirSync } from './fsx.ts'

const [cmd, ...rest] = process.argv.slice(2)

function defShadow(): string {
  return path.join(os.tmpdir(), 'oc-shadow')
}

// Rebuild the checkpoint map from the shadow store so `status`/`revert-*` work in a
// separate process from `checkpoint` (the ref lives only in the shadow).
function loadCheckpoints(repos: RepoInfo[], shadowDir: string, id: string): Map<string, CheckpointRef> {
  const out = new Map<string, CheckpointRef>()
  const ref = `refs/opencode/cp/${id}`
  for (const repo of repos) {
    const shadowFsPath = shadowRepoPath(shadowDir, repo.repoRoot)
    if (!fs.existsSync(shadowFsPath)) continue
    const shadowUrl = shadowFsPath.split(path.sep).join('/')
    const r = runGit(['ls-remote', shadowUrl, ref], repo.repoRoot)
    const line = r.stdout.toString('utf8').trim().split('\n')[0]
    if (r.status !== 0 || !line) continue
    const commit = line.split('\t')[0]
    const hadHead = gitOk(['rev-parse', '--verify', '-q', 'HEAD'], repo.repoRoot)
    out.set(repo.repoRoot, { repoRoot: repo.repoRoot, commit, ref, hadHead })
  }
  return out
}

function ownerRepo(repos: RepoInfo[], absPath: string): RepoInfo | undefined {
  let best: RepoInfo | undefined
  for (const r of repos) {
    if (absPath === r.repoRoot || absPath.startsWith(r.repoRoot + '/')) {
      if (!best || r.repoRoot.length > best.repoRoot.length) best = r
    }
  }
  return best
}

function printChanges(items: ChangeItem[]): void {
  if (items.length === 0) {
    console.log('  (no changes)')
    return
  }
  const byRepo = new Map<string, ChangeItem[]>()
  for (const it of items) {
    const arr = byRepo.get(it.repoRoot) ?? []
    arr.push(it)
    byRepo.set(it.repoRoot, arr)
  }
  for (const [repoRoot, arr] of byRepo) {
    console.log(`  repo ${repoRoot}`)
    for (const it of arr) {
      const tag = it.status.toUpperCase().padEnd(6)
      const extra = it.isBinary ? '(binary)' : `${it.hunks.length} hunk(s)`
      console.log(`    ${tag} ${it.path}  ${extra}`)
    }
  }
}

// ---- commands ----------------------------------------------------------------

function cmdDiscover(ws: string): void {
  console.log(JSON.stringify(discoverRepos(ws), null, 2))
}

function cmdCheckpoint(ws: string, shadowDir: string, id: string): void {
  const repos = discoverRepos(ws)
  const cps = checkpoint(repos, { shadowDir, id })
  console.log(`checkpoint id=${id} shadowDir=${shadowDir}`)
  for (const cp of cps.values()) console.log(`  ${cp.commit.slice(0, 12)}  ${cp.repoRoot}`)
}

function cmdStatus(ws: string, shadowDir: string, id: string): void {
  const repos = discoverRepos(ws)
  const cps = loadCheckpoints(repos, shadowDir, id)
  if (cps.size === 0) throw new Error(`no checkpoint found (id=${id}) in ${shadowDir} — run 'checkpoint' first`)
  printChanges(collectChanges(cps, repos, { shadowDir }))
}

function cmdRevertFile(ws: string, target: string, shadowDir: string, id: string): void {
  const repos = discoverRepos(ws)
  const cps = loadCheckpoints(repos, shadowDir, id)
  const abs = norm(path.isAbsolute(target) ? target : path.join(ws, target))
  const repo = ownerRepo(repos, abs)
  if (!repo) throw new Error(`no repo owns ${abs}`)
  const rel = abs.slice(repo.repoRoot.length + 1)
  const item = collectChanges(cps, repos, { shadowDir }).find((c) => c.repoRoot === repo.repoRoot && c.path === rel)
  if (!item) throw new Error(`${rel} is not a changed file in ${repo.repoRoot}`)
  revertFile(item, cps, repos, { shadowDir })
  console.log(`reverted ${rel} in ${repo.repoRoot}`)
}

function cmdRevertRepo(ws: string, repoRel: string, shadowDir: string, id: string, deleteAdded: boolean): void {
  const repos = discoverRepos(ws)
  const cps = loadCheckpoints(repos, shadowDir, id)
  const repoRoot = norm(path.isAbsolute(repoRel) ? repoRel : path.join(ws, repoRel))
  if (!cps.has(repoRoot)) throw new Error(`no checkpoint for repo ${repoRoot}`)
  const changes = collectChanges(cps, repos, { shadowDir })
  const agentAdded = deleteAdded
    ? new Set(changes.filter((c) => c.repoRoot === repoRoot && c.status === 'add').map((c) => c.path))
    : undefined
  revertRepo(repoRoot, cps, changes, repos, { shadowDir, agentAdded })
  console.log(`reverted repo ${repoRoot}${deleteAdded ? ' (deleted agent-added files)' : ' (kept added files)'}`)
}

// ---- self-contained demo -----------------------------------------------------

function git(args: string[], cwd: string): void {
  const env = {
    GIT_AUTHOR_NAME: 'demo',
    GIT_AUTHOR_EMAIL: 'demo@demo',
    GIT_COMMITTER_NAME: 'demo',
    GIT_COMMITTER_EMAIL: 'demo@demo',
  }
  const r = runGit(args, cwd, env)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

function cmdDemo(): void {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-demo-'))
  // The shadow store MUST live OUTSIDE the workspace, or its bare-repo files show up as changes.
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-demo-shadow-'))
  try {
    console.log(`\n== opencode git-engine demo ==\nworkspace: ${ws}\n`)

    // --- build a top repo with an independent NESTED repo inside it ---
    git(['init', '-q', ws], ws)
    write(ws, 'a.txt', 'alpha-1\nalpha-2\nalpha-3\n')
    write(ws, 'b.txt', 'bravo\n')
    write(ws, '.gitignore', 'ignored.txt\n')
    git(['add', '-A'], ws)
    git(['commit', '-q', '-m', 'top init'], ws)

    const nested = path.join(ws, 'lib')
    fs.mkdirSync(nested)
    git(['init', '-q', nested], nested)
    write(ws, 'lib/lib.txt', 'lib-original\n')
    git(['add', '-A'], nested)
    git(['commit', '-q', '-m', 'lib init'], nested)

    // --- discover ---
    const repos = discoverRepos(ws)
    console.log('discovered repos:')
    for (const r of repos) console.log(`  ${r.relToWorkspace}  nested=[${r.nestedChildren.join(', ')}]`)
    const top = repos.find((r) => r.relToWorkspace === '.')!
    assert(!!top && top.nestedChildren.includes('lib'), 'top repo sees nested child "lib"')
    assert(repos.some((r) => r.relToWorkspace === 'lib'), 'nested repo "lib" discovered independently')

    // --- checkpoint (baseline) ---
    const cps = checkpoint(repos, { shadowDir, id: 'demo' })
    console.log('\ncheckpointed', cps.size, 'repos into shadow store')

    // shadow-store proof: the checkpoint tree of the TOP repo must NOT contain the nested repo
    const topTree = gitText(['ls-tree', '-r', '--name-only', cps.get(top.repoRoot)!.commit], ws)
    assert(!topTree.split('\n').includes('lib/lib.txt'), 'top checkpoint excludes the nested repo (no gitlink swallow)')

    // --- simulate an opencode turn editing files across both repos ---
    write(ws, 'a.txt', 'alpha-1\nalpha-CHANGED\nalpha-3\n') // modify (top)
    write(ws, 'c.txt', 'new agent file\n')                   // add    (top)
    removeFileSync(path.join(ws, 'b.txt'))                    // delete (top)
    write(ws, 'lib/lib.txt', 'lib-CHANGED\n')                // modify (NESTED)
    write(ws, 'ignored.txt', 'should be ignored\n')          // ignored (top)
    write(ws, 'user_precious.txt', 'user made this\n')       // user untracked (top) — must survive repo revert

    // --- collect changes ---
    console.log('\ncollected changes:')
    const changes = collectChanges(cps, repos, { shadowDir })
    printChanges(changes)
    const topChanges = changes.filter((c) => c.repoRoot === top.repoRoot).map((c) => `${c.status}:${c.path}`)
    assert(topChanges.includes('mod:a.txt'), 'a.txt reported modified')
    assert(topChanges.includes('add:c.txt'), 'c.txt reported added')
    assert(topChanges.includes('del:b.txt'), 'b.txt reported deleted')
    assert(topChanges.includes('add:user_precious.txt'), 'user untracked file reported as add')
    assert(!topChanges.some((c) => c.includes('ignored.txt')), 'ignored.txt omitted (respects .gitignore)')
    assert(!topChanges.some((c) => c.includes('lib/')), 'nested repo changes NOT attributed to top repo')
    assert(changes.some((c) => c.repoRoot.endsWith('/lib') && c.path === 'lib.txt' && c.status === 'mod'), 'lib.txt attributed to the nested repo')

    // --- revert one file ---
    console.log('\nrevert single file a.txt:')
    const aItem = changes.find((c) => c.repoRoot === top.repoRoot && c.path === 'a.txt')!
    revertFile(aItem, cps, repos, { shadowDir })
    assert(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'alpha-1\nalpha-2\nalpha-3\n', 'a.txt byte-restored to baseline')

    // --- revert the whole TOP repo, deleting agent-added c.txt but PRESERVING user files & nested repo ---
    console.log('\nrevert whole top repo (delete only agent-added c.txt):')
    const agentAdded = new Set(['c.txt']) // opencode would supply this via AgentWriteRecord
    revertRepo(top.repoRoot, cps, changes, repos, { shadowDir, agentAdded })
    assert(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8') === 'bravo\n', 'b.txt restored (was deleted)')
    assert(!fs.existsSync(path.join(ws, 'c.txt')), 'agent-added c.txt removed')
    assert(fs.existsSync(path.join(ws, 'user_precious.txt')), 'user untracked file PRESERVED (not clobbered)')
    assert(fs.existsSync(path.join(nested, '.git')), 'nested repo .git PRESERVED')
    assert(fs.readFileSync(path.join(ws, 'lib/lib.txt'), 'utf8') === 'lib-CHANGED\n', 'nested repo NOT touched by top revert')

    console.log('\n== DEMO PASSED ==\n')
  } finally {
    try { removeDirSync(ws) } catch {}
    try { removeDirSync(shadowDir) } catch {}
  }
}

// ---- dispatch ----------------------------------------------------------------

try {
  if (cmd === 'demo') {
    cmdDemo()
  } else if (cmd === 'discover') {
    cmdDiscover(rest[0] ?? process.cwd())
  } else if (cmd === 'checkpoint') {
    cmdCheckpoint(rest[0] ?? process.cwd(), rest[1] ?? defShadow(), rest[2] ?? 'default')
  } else if (cmd === 'status') {
    cmdStatus(rest[0] ?? process.cwd(), rest[1] ?? defShadow(), rest[2] ?? 'default')
  } else if (cmd === 'revert-file') {
    cmdRevertFile(rest[0], rest[1], rest[2] ?? defShadow(), rest[3] ?? 'default')
  } else if (cmd === 'revert-repo') {
    const flags = rest.filter((a) => a.startsWith('--'))
    const pos = rest.filter((a) => !a.startsWith('--'))
    cmdRevertRepo(pos[0], pos[1], pos[2] ?? defShadow(), pos[3] ?? 'default', flags.includes('--delete-added'))
  } else {
    console.log('usage: node src/cli.ts <demo|discover|checkpoint|status|revert-file|revert-repo> ...')
    process.exitCode = 1
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exitCode = 1
}
