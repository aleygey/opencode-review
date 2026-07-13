// Perf benchmark for the engine on a large synthetic workspace.
// Usage: node bench.ts [topFiles] [nestedRepos] [nestedFiles]
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { discoverRepos } from './src/discover.ts'
import { checkpoint } from './src/checkpoint.ts'
import { collectChanges } from './src/collect.ts'

function sh(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}
const ms = (ns: bigint) => (Number(ns) / 1e6).toFixed(0)
function time<T>(label: string, fn: () => T): T {
  const s = process.hrtime.bigint()
  const r = fn()
  console.log(`  ${label.padEnd(46)} ${ms(process.hrtime.bigint() - s).padStart(7)} ms`)
  return r
}

const TOP_FILES = Number(process.argv[2] ?? 8000)
const NESTED = Number(process.argv[3] ?? 3)
const NESTED_FILES = Number(process.argv[4] ?? 2000)

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bench-'))
const SHADOW = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bench-shadow-'))

function makeRepo(dir: string, nFiles: number, prefix: string): void {
  fs.mkdirSync(dir, { recursive: true })
  sh(['init', '-q'], dir)
  sh(['config', 'user.email', 'b@b'], dir)
  sh(['config', 'user.name', 'b'], dir)
  for (let i = 0; i < nFiles; i++) {
    const d = path.join(dir, 'src', 'm' + (i % 50))
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `f${i}.c`), `// ${prefix} file ${i}\nint v${i}(void){\n  return ${i};\n}\n`)
  }
  sh(['add', '-A'], dir)
  sh(['commit', '-qm', 'init'], dir)
}

try {
  console.log(`fixture: top=${TOP_FILES} files + ${NESTED} nested repos x ${NESTED_FILES} files`)
  let t = process.hrtime.bigint()
  makeRepo(ROOT, TOP_FILES, 'top')
  for (let n = 0; n < NESTED; n++) makeRepo(path.join(ROOT, 'sub' + n), NESTED_FILES, 'sub' + n)
  console.log(`  (built fixture in ${ms(process.hrtime.bigint() - t)} ms)\n`)

  const repos = time('discoverRepos', () => discoverRepos(ROOT))
  console.log(`  -> ${repos.length} repos\n`)

  const refs = time('checkpoint (first baseline, COLD)', () => checkpoint(repos, { shadowDir: SHADOW, id: 'bench' }))
  time('collect FULL (cold index)', () => collectChanges(refs, repos, { shadowDir: SHADOW }))
  const warm = time('collect FULL (warm index, no change)', () => collectChanges(refs, repos, { shadowDir: SHADOW }))
  console.log(`  -> ${warm.length} changed files\n`)

  // Simulate a single small edit in the TOP repo.
  fs.appendFileSync(path.join(ROOT, 'src', 'm0', 'f0.c'), '// a one-line edit\n')
  const all = time('collect FULL after 1-file edit', () => collectChanges(refs, repos, { shadowDir: SHADOW }))
  console.log(`  -> ${all.length} changed file(s)`)

  // Scoped collect (only the changed repo) — available after the optimization.
  const topRoot = repos[0].repoRoot
  const scopedRepos = repos.filter((r) => r.repoRoot === topRoot)
  const scopedRefs = new Map([...refs].filter(([k]) => k === topRoot))
  try {
    const scoped = time('collect SCOPED to changed repo only', () =>
      collectChanges(scopedRefs, scopedRepos, { shadowDir: SHADOW }),
    )
    console.log(`  -> ${scoped.length} changed file(s)`)
  } catch (e: any) {
    console.log(`  (scoped collect not available: ${e?.message ?? e})`)
  }
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(SHADOW, { recursive: true, force: true }) } catch {}
}
