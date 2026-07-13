import { spawnSync } from 'node:child_process'

export type GitEnv = Record<string, string | undefined>
export type GitRun = { status: number; stdout: Buffer; stderr: string }

const MAX_BUFFER = 256 * 1024 * 1024

// -c flags that make blobs BYTE-EXACT (no CRLF smudge) — load-bearing on both
// checkpoint and collect (see SPEC T3/T8). advice.addEmbeddedRepo silences the
// nested-repo warning we deliberately avoid via exclude pathspecs.
export const NO_CRLF = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']
export const ADD_QUIET = ['-c', 'advice.addEmbeddedRepo=false']

export function runGit(args: string[], cwd: string, env?: GitEnv, input?: Buffer | string): GitRun {
  const r = spawnSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    input,
  })
  if (r.error) throw r.error
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString('utf8'),
  }
}

export function gitText(args: string[], cwd: string, env?: GitEnv): string {
  const r = runGit(args, cwd, env)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`)
  return r.stdout.toString('utf8')
}

export function gitBuffer(args: string[], cwd: string, env?: GitEnv): Buffer {
  const r = runGit(args, cwd, env)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`)
  return r.stdout
}

export function gitOk(args: string[], cwd: string, env?: GitEnv): boolean {
  return runGit(args, cwd, env).status === 0
}
