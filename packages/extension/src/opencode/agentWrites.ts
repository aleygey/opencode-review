import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Log } from '../log.ts'
import { extractToolEvent, type OcEvent } from '../lib/sse.ts'
import { normcase } from '../lib/pathcase.ts'

// Sentinel stored when the agent deleted a file (cannot collide with real file content
// because it is compared by identity from this shared constant, not retyped literals).
export const DELETED_MARKER = ' oc-review:deleted '

type WriteRecord = {
  content: string
  sessionID?: string
  sessions: string[]
  history: { sessionID?: string; content: string }[] // every capture this epoch, in order
  truncated: boolean // history overflowed — line-blame no longer sound, fall back to sessions[]
}

const HISTORY_CAP = 30

// Records what opencode itself wrote (abs path -> content right after the agent's write,
// plus WHICH session wrote it — that session is the natural target for quick-ask).
// This is the AgentWriteRecord the engine's SPEC calls an integration dependency: without it,
// agent edits can't be told apart from concurrent user edits (co-touch detection).
export class AgentWriteStore {
  private map = new Map<string, WriteRecord>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly workspaceRoot: string,
    private readonly log: Log,
  ) {}

  private toAbs(p: string): string {
    return path.isAbsolute(p) ? path.normalize(p) : path.join(this.workspaceRoot, p)
  }

  // Read shortly after the write completes so we capture the agent's on-disk result.
  // Keys go through normcase() (Windows is case-insensitive; case-sensitive keys silently
  // disabled attribution there) — the un-folded path is kept for actual file I/O.
  private scheduleCapture(p: string, sessionID?: string): void {
    const abs = this.toAbs(p)
    const key = normcase(abs)
    const prev = this.timers.get(key)
    if (prev) clearTimeout(prev)
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        const prev = this.map.get(key)
        const sid = sessionID ?? prev?.sessionID
        // Accumulate EVERY session that ever wrote this file (this epoch) — a revert must
        // be announced to all of them, not just the last writer.
        const sessions = [...new Set([...(prev?.sessions ?? []), ...(sid ? [sid] : [])])]
        let content: string
        try {
          content = fs.readFileSync(abs, 'utf8')
        } catch {
          content = DELETED_MARKER
        }
        const history = [...(prev?.history ?? []), { sessionID: sid, content }]
        let truncated = prev?.truncated ?? false
        while (history.length > HISTORY_CAP) {
          history.shift()
          truncated = true
        }
        this.map.set(key, { content, sessionID: sid, sessions, history, truncated })
      }, 150),
    )
  }

  handleEvent(evt: OcEvent): void {
    if (evt.type === 'message.part.updated') {
      const t = extractToolEvent(evt.props)
      if (t && t.status === 'completed' && t.filePath) {
        this.log.debug(`agent write observed: ${t.tool} ${t.filePath} (session ${t.sessionID ?? '?'})`)
        this.scheduleCapture(t.filePath, t.sessionID)
        return
      }
      const part = evt.props?.part
      if (part?.type === 'patch' && Array.isArray(part.files)) {
        for (const f of part.files) if (typeof f === 'string') this.scheduleCapture(f, part.sessionID)
      }
      return
    }
    if (evt.type === 'file.edited') {
      const f = evt.props?.file
      if (typeof f === 'string' && f.length) {
        this.log.debug(`file.edited observed: ${f}`)
        this.scheduleCapture(f)
      }
    }
  }

  has(abs: string): boolean {
    return this.map.has(normcase(abs))
  }

  // undefined = never saw the agent write this file
  content(abs: string): string | undefined {
    return this.map.get(normcase(abs))?.content
  }

  // The session that last wrote this file — the natural quick-ask target.
  sessionFor(abs: string): string | undefined {
    return this.map.get(normcase(abs))?.sessionID
  }

  // EVERY session that wrote this file in the current epoch — revert notifications go to all.
  sessionsFor(abs: string): string[] {
    return this.map.get(normcase(abs))?.sessions ?? []
  }

  // Full capture history for line-blame; truncated=true means attribution is unsound.
  historyFor(abs: string): { captures: { sessionID?: string; content: string }[]; truncated: boolean } {
    const r = this.map.get(normcase(abs))
    return { captures: r?.history ?? [], truncated: r?.truncated ?? false }
  }

  // Most recently observed session across ALL writes (fallback quick-ask target).
  lastSession(): string | undefined {
    let last: string | undefined
    for (const r of this.map.values()) if (r.sessionID) last = r.sessionID
    return last
  }

  // Any observed agent write under this directory? (used to warn when a whole new
  // repo appearing after baseline was created by the agent, not the user)
  hasUnder(absDirPrefix: string): boolean {
    const p = normcase(absDirPrefix).replace(/[\\/]+$/, '')
    for (const key of this.map.keys()) {
      if (key === p || key.startsWith(p + path.sep) || key.startsWith(p + '/')) return true
    }
    return false
  }

  clear(): void {
    this.map.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  get size(): number {
    return this.map.size
  }
}
