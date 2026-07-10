import type { Log } from '../log.ts'
import type { ServerInfo } from './discovery.ts'
import { authHeaders } from './discovery.ts'
import { SseParser, normalizeOcEvent, type OcEvent } from '../lib/sse.ts'

export type SessionSummary = {
  id: string
  title?: string
  directory?: string
  updated: number
}

export class OpencodeClient {
  private eventsAbort: AbortController | undefined
  private handlers = new Set<(e: OcEvent) => void>()
  connected = false

  constructor(
    public readonly info: ServerInfo,
    private readonly log: Log,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { ...authHeaders(this.info.password), ...(extra ?? {}) }
  }

  async request(method: string, p: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(this.info.baseUrl + p, {
      method,
      headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    return res
  }

  async json<T>(method: string, p: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.request(method, p, body, signal)
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 400)}`)
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  // ---- sessions ----

  async listSessions(): Promise<SessionSummary[]> {
    const raw = await this.json<any>('GET', '/session')
    const arr: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.sessions) ? raw.sessions : []
    return arr
      .map((s) => ({
        id: String(s?.id ?? ''),
        title: typeof s?.title === 'string' ? s.title : undefined,
        directory: typeof s?.directory === 'string' ? s.directory : undefined,
        updated: Number(s?.time?.updated ?? s?.updatedAt ?? s?.time?.created ?? 0),
      }))
      .filter((s) => s.id.length > 0)
      .sort((a, b) => b.updated - a.updated)
  }

  async createSession(title: string, directory?: string): Promise<string> {
    const body: any = { title }
    if (directory) body.directory = directory
    const res = await this.json<any>('POST', '/session', body)
    const id = res?.id ?? res?.data?.id
    if (!id) throw new Error(`createSession: no id in response`)
    return String(id)
  }

  // Send a prompt and wait for the completed assistant message. Model field shape has
  // drifted across server versions — try object form, then string, then without model.
  async prompt(
    sessionID: string,
    text: string,
    model: { providerID: string; modelID: string } | undefined,
    signal: AbortSignal,
  ): Promise<{ text: string; raw: any }> {
    const parts = [{ type: 'text', text }]
    const attempts: any[] = []
    if (model) {
      attempts.push({ parts, model: { providerID: model.providerID, modelID: model.modelID } })
      attempts.push({ parts, model: `${model.providerID}/${model.modelID}` })
    }
    attempts.push({ parts })

    let lastErr: Error | undefined
    for (const body of attempts) {
      try {
        const raw = await this.json<any>('POST', `/session/${encodeURIComponent(sessionID)}/message`, body, signal)
        const partsOut: any[] = Array.isArray(raw?.parts) ? raw.parts : []
        const answer = partsOut
          .filter((p) => p?.type === 'text' && typeof p.text === 'string' && !p.synthetic)
          .map((p) => p.text)
          .join('')
        return { text: answer, raw }
      } catch (e: any) {
        if (signal.aborted) throw e
        lastErr = e
        const msg = String(e?.message ?? '')
        // Only fall through on request-shape errors; not on 5xx/network.
        if (!/-> 4\d\d/.test(msg)) throw e
        this.log.warn(`prompt attempt failed, trying next body shape: ${msg.slice(0, 200)}`)
      }
    }
    throw lastErr ?? new Error('prompt failed')
  }

  async abortSession(sessionID: string): Promise<void> {
    try {
      await this.json('POST', `/session/${encodeURIComponent(sessionID)}/abort`, {})
    } catch (e: any) {
      this.log.warn(`abort failed: ${e?.message ?? e}`)
    }
  }

  // ---- permissions (dual endpoint shapes across versions) ----

  async replyPermission(sessionID: string | undefined, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<boolean> {
    const bodies = { response, reply: response }
    if (sessionID) {
      try {
        await this.json('POST', `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`, bodies)
        return true
      } catch (e: any) {
        this.log.warn(`permission reply (session path) failed: ${e?.message ?? e}`)
      }
    }
    try {
      await this.json('POST', `/permission/${encodeURIComponent(permissionID)}/reply`, bodies)
      return true
    } catch (e: any) {
      this.log.warn(`permission reply (flat path) failed: ${e?.message ?? e}`)
      return false
    }
  }

  // ---- events (SSE with reconnect) ----

  onEvent(handler: (e: OcEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  startEvents(directory?: string): void {
    if (this.eventsAbort) return
    const ctl = new AbortController()
    this.eventsAbort = ctl
    void this.eventLoop(ctl, directory)
  }

  private async eventLoop(ctl: AbortController, directory?: string): Promise<void> {
    let attempt = 0
    const paths = ['/event', '/global/event']
    while (!ctl.signal.aborted) {
      let streamed = false
      for (const p of paths) {
        if (ctl.signal.aborted) return
        const q = directory ? `?directory=${encodeURIComponent(directory)}` : ''
        try {
          const res = await fetch(this.info.baseUrl + p + q, {
            headers: this.headers({ accept: 'text/event-stream' }),
            signal: ctl.signal,
          })
          if (!res.ok || !res.body) {
            this.log.warn(`SSE ${p} -> ${res.status}`)
            continue
          }
          this.connected = true
          attempt = 0
          this.log.info(`SSE connected via ${p}`)
          const parser = new SseParser()
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            for (const data of parser.feed(dec.decode(value, { stream: true }))) {
              try {
                const evt = normalizeOcEvent(JSON.parse(data))
                if (evt) for (const h of this.handlers) h(evt)
              } catch {
                // non-JSON keepalive — ignore
              }
            }
          }
          streamed = true
          break // stream ended normally; reconnect from the first path
        } catch (e: any) {
          if (ctl.signal.aborted) return
          this.log.warn(`SSE ${p} error: ${e?.message ?? e}`)
        }
      }
      this.connected = false
      attempt += 1
      const backoff = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), streamed ? 1000 : 30000)
      await new Promise((r) => setTimeout(r, backoff))
    }
  }

  dispose(): void {
    this.eventsAbort?.abort()
    this.eventsAbort = undefined
    this.handlers.clear()
    this.connected = false
  }
}
