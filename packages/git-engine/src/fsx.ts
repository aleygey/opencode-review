import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

// On some Windows setups fs.rmSync silently no-ops on a file a scanner is briefly holding —
// it returns WITHOUT error yet leaves the entry on disk. A rollback engine must ACTUALLY
// remove files, so we fall back to the OS remover and then verify. On POSIX (the deploy
// target) the first fs.rmSync always succeeds, so this is a pure passthrough there.
export function removeFileSync(abs: string): void {
  try { fs.rmSync(abs, { force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  if (!fs.existsSync(abs)) return
  if (process.platform === 'win32') {
    try { fs.chmodSync(abs, 0o666) } catch {}
    try {
      execFileSync('cmd', ['/c', 'del', '/f', '/q', path.basename(abs)], { cwd: path.dirname(abs), stdio: 'ignore' })
    } catch {}
  }
  try { fs.rmSync(abs, { force: true }) } catch {}
  if (fs.existsSync(abs)) throw new Error(`failed to remove file: ${abs}`)
}

export function removeDirSync(abs: string): void {
  try { fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  if (!fs.existsSync(abs)) return
  if (process.platform === 'win32') {
    // make everything writable, then let the OS remover handle held/read-only entries
    const stack = [abs]
    while (stack.length) {
      const d = stack.pop()!
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = path.join(d, e.name)
        try { fs.chmodSync(full, 0o666) } catch {}
        if (e.isDirectory()) stack.push(full)
      }
    }
    try {
      execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', path.basename(abs)], { cwd: path.dirname(abs), stdio: 'ignore' })
    } catch {}
  }
  try { fs.rmSync(abs, { recursive: true, force: true }) } catch {}
}
