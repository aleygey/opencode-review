import * as vscode from 'vscode'
import type { OpencodeClient } from '../opencode/client.ts'
import type { AgentWriteStore } from '../opencode/agentWrites.ts'
import type { Log } from '../log.ts'
import { normcase } from '../lib/pathcase.ts'

const KEY_THREADS = 'ocReview.askThreads.v1'
const THREAD_CAP = 50

type StoredThread = {
  uri: string
  start: number
  end: number
  sessionID?: string
  selection?: string
  comments: { author: string; body: string }[]
}

// Quick-ask as INLINE COMMENT THREADS (VSCode's built-in Comments UI — the same substrate
// GitHub PR reviews use). No webview, no session picker, no model config:
//  - the thread anchors to the FULL selection range (highlighted alongside the code),
//  - the question goes to the session that last WROTE this file (fallback: last active
//    session in this workspace; fallback: a new session),
//  - the model is whatever that session already uses,
//  - threads are PERSISTED per workspace and restored on reload — an annotation record.
// The widget chrome (collapse button, full editor width) is fixed by VSCode and not stylable.
export class AskThreads {
  private readonly cc: vscode.CommentController
  private readonly threads: vscode.CommentThread[] = []
  private readonly sessionByThread = new WeakMap<vscode.CommentThread, string>()
  private readonly selectionByThread = new WeakMap<vscode.CommentThread, string>()

  constructor(
    private readonly getClient: () => OpencodeClient | undefined,
    private readonly agentWrites: AgentWriteStore,
    private readonly workspaceRoot: string,
    private readonly memento: vscode.Memento,
    private readonly log: Log,
    // Block-level owner lookup (line blame): ask the session that WROTE the selected lines.
    private readonly ownerForLines?: (abs: string, lines: number[]) => Promise<string | undefined>,
  ) {
    this.cc = vscode.comments.createCommentController('ocReviewAsk', 'OC Review — 问 opencode')
    this.cc.options = { placeHolder: '问 opencode(Enter 发送,Shift+Enter 换行)', prompt: '问 opencode' }
    // NO commentingRangeProvider on purpose: it paints a “+” and a gutter bar between the
    // line numbers and the code on every line, which users found noisy. Threads are created
    // only via selection + Ctrl+Alt+A / context menu; existing threads render regardless.
    this.restore()
  }

  // Ctrl+Alt+A: open a thread anchored to the WHOLE current selection.
  openAtSelection(): void {
    const ed = vscode.window.activeTextEditor
    if (!ed || ed.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('OC Review: 先在文件里选中代码/放好光标。')
      return
    }
    const sel = ed.selection
    const range = sel.isEmpty
      ? ed.document.lineAt(sel.active.line).range
      : new vscode.Range(sel.start, sel.end)
    const thread = this.cc.createCommentThread(ed.document.uri, range, [])
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
    thread.canReply = true
    thread.label = sel.isEmpty ? '问 opencode' : `问 opencode · 选中 ${sel.end.line - sel.start.line + 1} 行`
    if (!sel.isEmpty) this.selectionByThread.set(thread, ed.document.getText(sel))
    this.threads.push(thread)
  }

  private async resolveSession(client: OpencodeClient, absFile: string, lines?: number[]): Promise<string | undefined> {
    // Most precise first: the session that wrote THESE lines (line blame).
    if (this.ownerForLines && lines && lines.length) {
      try {
        const owner = await this.ownerForLines(absFile, lines)
        if (owner) return owner
      } catch {
        /* fall through */
      }
    }
    const bySession = this.agentWrites.sessionFor(absFile)
    if (bySession) return bySession
    const last = this.agentWrites.lastSession()
    if (last) return last
    try {
      const ws = normcase(this.workspaceRoot)
      const sessions = await client.listSessions()
      const match = sessions.find(
        (s) => !s.directory || normcase(s.directory).startsWith(ws) || ws.startsWith(normcase(s.directory)),
      )
      if (match) return match.id
    } catch (e: any) {
      this.log.warn(`listSessions failed: ${e?.message ?? e}`)
    }
    try {
      return await client.createSession('VSCode quick-ask', this.workspaceRoot)
    } catch (e: any) {
      this.log.error(`createSession failed: ${e?.message ?? e}`)
      return undefined
    }
  }

  // Context = remembered selection, else the FULL lines the thread range spans (a thread
  // created from the gutter “+” has no selection but may still span several lines).
  private contextText(thread: vscode.CommentThread, doc: vscode.TextDocument): string {
    const sel = this.selectionByThread.get(thread)
    if (sel) return sel
    const r = thread.range
    if (!r) return ''
    const startLine = Math.min(r.start.line, doc.lineCount - 1)
    const endLine = Math.min(r.end.line, doc.lineCount - 1)
    return doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length))
  }

  // Bound to the thread's send button / Enter (receives vscode.CommentReply).
  async submit(reply: vscode.CommentReply): Promise<void> {
    const client = this.getClient()
    const thread = reply.thread
    const question = reply.text.trim()
    if (!question) return
    if (!this.threads.includes(thread)) this.threads.push(thread) // gutter-created thread
    if (!client) {
      this.append(thread, 'OC Review', '未连接 opencode server — 先跑 "OC Review: Connect"。')
      return
    }

    const doc = await vscode.workspace.openTextDocument(thread.uri)
    const rel = vscode.workspace.asRelativePath(thread.uri, false)
    const startLine = (thread.range?.start.line ?? 0) + 1
    const endLine = (thread.range?.end.line ?? 0) + 1
    const code = this.contextText(thread, doc)
    const lang = doc.languageId

    this.append(thread, '你', question)
    this.append(thread, 'opencode', '⏳ 已发送,等待回答…(同一 session,opencode 终端里也能看到)')

    const threadLines: number[] = []
    if (thread.range) for (let l = thread.range.start.line; l <= thread.range.end.line; l++) threadLines.push(l)
    const sessionID =
      this.sessionByThread.get(thread) ?? (await this.resolveSession(client, thread.uri.fsPath, threadLines))
    if (!sessionID) {
      this.replaceLast(thread, 'opencode', '找不到可用 session,也无法创建 — 看 OC Review 输出面板。')
      return
    }
    this.sessionByThread.set(thread, sessionID)

    const prompt = [
      `关于 \`${rel}\` 第 ${startLine}${endLine !== startLine ? `-${endLine}` : ''} 行的代码:`,
      '```' + lang,
      code.length > 12000 ? code.slice(0, 12000) + '\n…(truncated)' : code,
      '```',
      '',
      question,
      '',
      '请简明回答。不要为这个问题修改任何文件。',
    ].join('\n')

    try {
      const res = await client.prompt(sessionID, prompt, undefined, new AbortController().signal)
      this.replaceLast(thread, 'opencode', res.text.trim() || '(空回答 — 看 OC Review 输出面板)')
    } catch (e: any) {
      this.log.error(`quick-ask failed: ${e?.message ?? e}`)
      this.replaceLast(thread, 'opencode', `❌ 失败: ${String(e?.message ?? e).slice(0, 300)}`)
    }
    this.persist()
  }

  // ---- persistence: threads survive window reloads (annotation record) ----

  private persist(): void {
    const stored: StoredThread[] = []
    for (const t of this.threads) {
      if (t.comments.length === 0) continue
      stored.push({
        uri: t.uri.toString(),
        start: t.range?.start.line ?? 0,
        end: t.range?.end.line ?? 0,
        sessionID: this.sessionByThread.get(t),
        selection: this.selectionByThread.get(t),
        comments: t.comments.map((c) => ({
          author: c.author.name,
          body: typeof c.body === 'string' ? c.body : c.body.value,
        })),
      })
    }
    void this.memento.update(KEY_THREADS, stored.slice(-THREAD_CAP))
  }

  private restore(): void {
    const stored = this.memento.get<StoredThread[]>(KEY_THREADS, [])
    for (const s of stored) {
      try {
        const thread = this.cc.createCommentThread(
          vscode.Uri.parse(s.uri),
          new vscode.Range(s.start, 0, s.end, 0),
          s.comments.map((c) => this.mkComment(c.author, c.body)),
        )
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed
        thread.canReply = true
        thread.label = '问 opencode'
        if (s.sessionID) this.sessionByThread.set(thread, s.sessionID)
        if (s.selection) this.selectionByThread.set(thread, s.selection)
        this.threads.push(thread)
      } catch {
        // stale entry (file gone etc.) — drop silently
      }
    }
    if (stored.length) this.log.info(`restored ${stored.length} ask thread(s)`)
  }

  clearAll(): void {
    for (const t of this.threads) t.dispose()
    this.threads.length = 0
    void this.memento.update(KEY_THREADS, [])
  }

  private mkComment(author: string, body: string): vscode.Comment {
    const md = new vscode.MarkdownString(body)
    md.isTrusted = false
    return { author: { name: author }, body: md, mode: vscode.CommentMode.Preview }
  }

  private append(thread: vscode.CommentThread, author: string, body: string): void {
    thread.comments = [...thread.comments, this.mkComment(author, body)]
  }

  private replaceLast(thread: vscode.CommentThread, author: string, body: string): void {
    const list = [...thread.comments]
    list[list.length - 1] = this.mkComment(author, body)
    thread.comments = list
  }

  dispose(): void {
    this.persist()
    this.cc.dispose()
  }
}
