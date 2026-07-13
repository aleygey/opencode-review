import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork, execFileSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  git(['config', 'user.email', 'host@test'], dir)
  git(['config', 'user.name', 'host'], dir)
  fs.writeFileSync(path.join(dir, 'f.txt'), content)
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'init'], dir)
}

function rpc(child: ChildProcess, op: string, args: any): Promise<any> {
  const id = Math.floor(Math.random() * 1_000_000_000)
  return new Promise((resolve, reject) => {
    const onMessage = (msg: any) => {
      if (msg?.id !== id) return
      child.off('message', onMessage)
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    }
    child.on('message', onMessage)
    child.send({ id, op, args }, (err) => { if (err) reject(err) })
  })
}

test('engineHost checkpoints multiple repos through the bounded worker pool', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-host-'))
  const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-host-shadow-'))
  makeRepo(path.join(root, 'a'), 'a\n')
  makeRepo(path.join(root, 'b'), 'b\n')
  makeRepo(path.join(root, 'c'), 'c\n')
  const host = fork(path.join(import.meta.dirname, '..', 'dist', 'engineHost.js'), [], { silent: true, execArgv: [] })
  t.after(() => {
    host.kill()
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(shadowDir, { recursive: true, force: true }) } catch {}
  })

  const repos = await rpc(host, 'discover', { workspaceRoot: root, skip: [], include: [] })
  assert.equal(repos.length, 3)
  const refs = await rpc(host, 'checkpoint', { repos, shadowDir, id: 'parallel' })
  assert.equal(refs.length, 3)
  for (const ref of refs) {
    const parents = git(['rev-list', '--parents', '-n', '1', ref.commit], ref.repoRoot).trim().split(/\s+/)
    assert.equal(parents.length, 1)
  }
  fs.writeFileSync(path.join(root, 'b', 'f.txt'), 'b2\n')
  const items = await rpc(host, 'collect', {
    refs,
    repos,
    shadowDir,
    pathsByRepo: [{ repoRoot: path.join(root, 'b').replace(/\\/g, '/'), paths: ['f.txt'] }],
  })
  assert.deepEqual(items.map((i: any) => [i.path, i.status]), [['f.txt', 'mod']])
})
