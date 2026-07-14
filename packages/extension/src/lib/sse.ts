// Pure SSE parsing + opencode event normalization. No vscode imports — unit-tested.

export class SseParser {
  private buf = ''
  private sawCr = false

  // Feed a chunk, get back completed event data payloads (multi `data:` lines joined by \n).
  feed(chunk: string): string[] {
    // A CRLF split across chunk boundaries must not become two terminators: the previous
    // chunk's trailing \r was already normalized to \n, so a leading \n here is the second
    // half of that pair — drop it and clear the CR state (empty chunks preserve state).
    if (chunk === '') return []
    if (this.sawCr) {
      this.sawCr = false
      if (chunk.startsWith('\n')) chunk = chunk.slice(1)
    }
    this.sawCr = chunk.endsWith('\r')
    this.buf += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const out: string[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      const datas: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) datas.push(line.slice(5).replace(/^ /, ''))
        // ignore `event:`, `id:`, `retry:` and comment lines (`:heartbeat`)
      }
      if (datas.length) out.push(datas.join('\n'))
    }
    return out
  }
}

export type OcEvent = { type: string; props: any; raw: any }

// opencode has shipped two envelope shapes:
//   v1 bus:    { type, properties }
//   v2 global: { payload: { type, properties? }, workspace? }  (and payload may inline props)
export function normalizeOcEvent(json: any): OcEvent | undefined {
  if (!json || typeof json !== 'object') return undefined
  const inner = json.payload && typeof json.payload === 'object' ? json.payload : json
  const type = inner.type
  if (typeof type !== 'string') return undefined
  const props = inner.properties && typeof inner.properties === 'object' ? inner.properties : inner
  return { type, props, raw: json }
}

// ---- tool-event helpers (shared by AgentWriteStore + controller) ----

const FILE_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit'])

export function toolFilePath(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const p = input.filePath ?? input.file_path ?? input.path
  return typeof p === 'string' && p.length ? p : undefined
}

export type ToolEventInfo = {
  tool: string
  status: string
  filePath?: string
  sessionID?: string
}

// Extract file-tool info from a message.part.updated event, tolerating shape drift.
export function extractToolEvent(props: any): ToolEventInfo | undefined {
  const part = props?.part
  if (!part || part.type !== 'tool') return undefined
  const tool = String(part.tool ?? '')
  if (!FILE_TOOLS.has(tool)) return undefined
  const state = part.state ?? {}
  const status = String(state.status ?? '')
  return {
    tool,
    status,
    filePath: toolFilePath(state.input) ?? toolFilePath(part.input),
    sessionID: part.sessionID ?? props?.sessionID,
  }
}

// Extract text-part delta for quick-ask streaming.
export function extractTextDelta(props: any): { sessionID?: string; text?: string; delta?: string } | undefined {
  const part = props?.part
  if (!part || part.type !== 'text') return undefined
  return {
    sessionID: part.sessionID ?? props?.sessionID,
    text: typeof part.text === 'string' ? part.text : undefined,
    delta: typeof props?.delta === 'string' ? props.delta : undefined,
  }
}

export function parseModelString(s: string): { providerID: string; modelID: string } | undefined {
  const t = s.trim()
  if (!t) return undefined
  const i = t.indexOf('/')
  if (i <= 0 || i === t.length - 1) return undefined
  return { providerID: t.slice(0, i), modelID: t.slice(i + 1) }
}
