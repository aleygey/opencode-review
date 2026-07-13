// Engine worker — forked by the extension so the engine's synchronous git calls
// (spawnSync) never block the extension host. Speaks JSON over process IPC.
import * as path from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  discoverRepos,
  checkpoint,
  collectChanges,
  revertFile,
  revertHunk,
  revertRepo,
  ensureCommitPresent,
} from '../../git-engine/src/index.ts'
import type { RepoInfo, CheckpointRef, ChangeItem, Hunk } from '../../git-engine/src/index.ts'
import { gitText, gitBuffer, gitOk, runGit as runGitAllowFail } from '../../git-engine/src/git.ts'

type Req = { id: number; op: string; args: any }
type Res = { id: number; ok: boolean; result?: any; error?: string }

type CheckpointWorkerData = { kind: 'checkpoint'; repo: RepoInfo; shadowDir: string; id: string }

function cpMap(refs: CheckpointRef[]): Map<string, CheckpointRef> {
  return new Map(refs.map((r) => [r.repoRoot, r]))
}

function checkpointInWorker(repo: RepoInfo, shadowDir: string, id: string): Promise<CheckpointRef> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { kind: 'checkpoint', repo, shadowDir, id } satisfies CheckpointWorkerData })
    worker.once('message', (msg: any) => msg?.ok ? resolve(msg.ref) : reject(new Error(msg?.error ?? 'checkpoint worker failed')))
    worker.once('error', reject)
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`checkpoint worker exited (${code})`)) })
  })
}

async function checkpointParallel(repos: RepoInfo[], shadowDir: string, id: string): Promise<CheckpointRef[]> {
  const out = new Array<CheckpointRef>(repos.length)
  let next = 0
  const run = async () => {
    for (;;) {
      const i = next++
      if (i >= repos.length) return
      out[i] = await checkpointInWorker(repos[i], shadowDir, id)
    }
  }
  // Two concurrent repos is a good SSD/remote default without turning a baseline into an IO storm.
  await Promise.all(Array.from({ length: Math.min(2, repos.length) }, run))
  return out
}

async function handle(op: string, a: any): Promise<any> {
  switch (op) {
    case 'ping':
      return 'pong'
    case 'discover':
      return discoverRepos(a.workspaceRoot, { skip: a.skip, include: a.include }) satisfies RepoInfo[]
    case 'checkpoint': {
      if (a.repos.length <= 1) {
        const m = checkpoint(a.repos, { shadowDir: a.shadowDir, id: a.id })
        return [...m.values()]
      }
      return checkpointParallel(a.repos, a.shadowDir, a.id)
    }
    case 'collect': {
      const pathsByRepo = Array.isArray(a.pathsByRepo)
        ? new Map<string, string[] | undefined>(a.pathsByRepo.map((x: any) => [String(x.repoRoot), Array.isArray(x.paths) ? x.paths.map(String) : undefined]))
        : undefined
      return collectChanges(cpMap(a.refs), a.repos, { shadowDir: a.shadowDir, pathsByRepo }) satisfies ChangeItem[]
    }
    case 'revertFile':
      revertFile(a.item, cpMap(a.refs), a.repos, { shadowDir: a.shadowDir, allowCoTouched: a.allowCoTouched })
      return true
    case 'revertHunk':
      revertHunk(a.item as ChangeItem, a.hunk as Hunk, a.repos, { force: !!a.force })
      return true
    case 'revertRepo':
      revertRepo(a.repoRoot, cpMap(a.refs), a.changes, a.repos, {
        shadowDir: a.shadowDir,
        agentAdded: new Set<string>(a.agentAdded ?? []),
      })
      return true
    case 'baselineContent': {
      // Byte-exact baseline content for the diff editor's left side.
      const ref = (a.refs as CheckpointRef[]).find((r) => r.repoRoot === a.repoRoot)
      if (!ref) throw new Error(`no checkpoint for ${a.repoRoot}`)
      ensureCommitPresent(a.repoRoot, ref, a.shadowDir)
      const rel = String(a.relPath)
      if (!gitOk(['rev-parse', '-q', '--verify', `${ref.commit}:${rel}`], a.repoRoot)) return { exists: false }
      const sha = gitText(['rev-parse', `${ref.commit}:${rel}`], a.repoRoot).trim()
      const buf = gitBuffer(['cat-file', 'blob', sha], a.repoRoot)
      // Heuristic binary sniff: NUL byte in the first 8000 bytes.
      const probe = buf.subarray(0, 8000)
      const binary = probe.includes(0)
      return { exists: true, binary, text: binary ? '' : buf.toString('utf8') }
    }
    case 'explainPath': {
      // Why is (or isn't) this path showing up? Owning repo, gitignore verdict, baseline presence.
      const abs = String(a.abs).split('\\').join('/')
      const repos = a.repos as RepoInfo[]
      const owner = repos
        .filter((r) => abs === r.repoRoot || abs.startsWith(r.repoRoot + '/'))
        .sort((x, y) => y.repoRoot.length - x.repoRoot.length)[0]
      if (!owner) return { owned: false }
      const rel = abs === owner.repoRoot ? '.' : abs.slice(owner.repoRoot.length + 1)
      const underNested = owner.nestedChildren.find((c) => rel === c || rel.startsWith(c + '/'))
      const ig = runGitAllowFail(['check-ignore', '-v', '--no-index', '--', rel], owner.repoRoot)
      const ref = (a.refs as CheckpointRef[]).find((r) => r.repoRoot === owner.repoRoot)
      let inBaseline: boolean | undefined
      if (ref && rel !== '.') {
        ensureCommitPresent(owner.repoRoot, ref, a.shadowDir)
        inBaseline = gitOk(['rev-parse', '-q', '--verify', `${ref.commit}:${rel}`], owner.repoRoot)
      }
      return {
        owned: true,
        repoRoot: owner.repoRoot,
        rel,
        underNestedChild: underNested,
        ignored: ig.status === 0 ? ig.stdout.toString('utf8').trim() : undefined,
        repoHasBaseline: Boolean(ref),
        inBaseline,
      }
    }
    case 'headContent': {
      // Current-HEAD content (fallback diff base when no checkpoint covers the file).
      const rel = String(a.relPath)
      if (!gitOk(['rev-parse', '-q', '--verify', `HEAD:${rel}`], a.repoRoot)) return { exists: false }
      const buf = gitBuffer(['show', `HEAD:${rel}`], a.repoRoot)
      return { exists: true, binary: buf.subarray(0, 8000).includes(0), text: buf.toString('utf8') }
    }
    default:
      throw new Error(`unknown op: ${op}`)
  }
}

if (!isMainThread) {
  const data = workerData as CheckpointWorkerData
  try {
    if (data?.kind !== 'checkpoint') throw new Error('unknown engine worker task')
    const ref = [...checkpoint([data.repo], { shadowDir: data.shadowDir, id: data.id }).values()][0]
    parentPort?.postMessage({ ok: true, ref })
  } catch (e: any) {
    parentPort?.postMessage({ ok: false, error: e?.stack || String(e?.message ?? e) })
  }
  parentPort?.close()
} else {
  process.on('message', (msg: Req) => {
    void (async () => {
      const res: Res = { id: msg.id, ok: true }
      try {
        res.result = await handle(msg.op, msg.args ?? {})
      } catch (e: any) {
        res.ok = false
        res.error = e?.stack || String(e?.message ?? e)
      }
      process.send?.(res)
    })()
  })

  // Keep worker alive; exit with parent.
  process.on('disconnect', () => process.exit(0))
}
// Windows path sanity: engine normalizes to forward slashes internally.
void path
