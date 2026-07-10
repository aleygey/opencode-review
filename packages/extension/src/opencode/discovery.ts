import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Log } from '../log.ts'

export type ServerInfo = { baseUrl: string; password?: string; source: string }

function authHeaders(password?: string): Record<string, string> {
  if (!password) return {}
  return { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') }
}

async function healthy(baseUrl: string, password: string | undefined, timeoutMs = 1500): Promise<boolean> {
  for (const p of ['/global/health', '/doc']) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), timeoutMs)
      const res = await fetch(baseUrl + p, { headers: authHeaders(password), signal: ctl.signal })
      clearTimeout(t)
      if (res.status === 401) return false // reachable but wrong password — treat as not usable
      if (res.ok) return true
    } catch {
      // try next probe path / next candidate
    }
  }
  return false
}

// Discovery order: explicit setting → OpenCodeGUI-convention lock file → port probe.
export async function discoverServer(
  workspaceRoot: string,
  cfg: { serverUrl: string; serverPassword: string; probePorts: number[] },
  log: Log,
): Promise<ServerInfo | undefined> {
  if (cfg.serverUrl) {
    const info = { baseUrl: cfg.serverUrl.replace(/\/+$/, ''), password: cfg.serverPassword || undefined, source: 'setting' }
    if (await healthy(info.baseUrl, info.password)) return info
    log.warn(`configured serverUrl not reachable: ${info.baseUrl}`)
    return undefined // explicit setting: do not silently fall back somewhere else
  }

  const lockPath = path.join(workspaceRoot, '.opencode', 'server.lock.json')
  try {
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      const port = Number(lock?.port)
      const password = typeof lock?.password === 'string' ? lock.password : undefined
      if (Number.isInteger(port) && port > 0) {
        const info = { baseUrl: `http://127.0.0.1:${port}`, password, source: 'lockfile' }
        if (await healthy(info.baseUrl, info.password)) return info
        log.warn(`lock file server not reachable on port ${port}`)
      }
    }
  } catch (e: any) {
    log.warn(`lock file parse failed: ${e?.message ?? e}`)
  }

  for (const port of cfg.probePorts) {
    const info = { baseUrl: `http://127.0.0.1:${port}`, password: cfg.serverPassword || undefined, source: `probe:${port}` }
    if (await healthy(info.baseUrl, info.password)) return info
  }
  return undefined
}

export { authHeaders }
