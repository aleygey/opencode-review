import * as vscode from 'vscode'
import type { OpencodeClient } from '../opencode/client.ts'
import type { AgentWriteStore } from '../opencode/agentWrites.ts'
import type { Log } from '../log.ts'
import { normcase } from '../lib/pathcase.ts'

// Quick-ask as INLINE COMMENT THREADS (VSCode Comments API) — the closest native thing
// to "a dialog next to the cursor". No webview panel, no session picker, no model config:
//  - the thread opens at the selection / clicked line,
//  - the question goes to the session that last WROTE this file (fallback: last active
//    session in this workspace; fallback: a new session),
//  - the model is whatever that session already uses (server default),
//  - the answer comes back as a reply in the thread (and in the opencode TUI, since it
//    is the same session).
export class AskThreads {
  private readonly cc: vscode.CommentController
  private readonly sessionByThread = new WeakMap<vscode.CommentThread, string>()
  private readonly selectionByThread = new WeakMap<vscode.CommentThread, string>()

  constructor(
    private readonly getClient: () => OpencodeClient | undefined,
    private readonly agentWrites: AgentWriteStore,
    private readonly workspaceRoot: string,
    private readonly log: Log,
  ) {
    this.cc = vscode.comments.createCommentController('ocReviewAsk', 'OC Review — 问 opencode')
    this.cc.options = { placeHolder: '问 opencode:为什么这样改?这段什么作用?…', prompt: '发送' }
    // Every line of every local file can host an ask-thread (the gutter “+” affordance).
    this.cc.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        doc.uri.scheme === 'file' ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [],
    }
  }

  // Ctrl+Alt+A: open a thread at the current selection and remember the selected code.
  openAtSelection(): void {
    const ed = vscode.window.activeTextEditor
    if (!ed || ed.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('OC Review: 先在文件里选中代码/放好光标。')
      return
    }
    const line = ed.selection.end.line
    const thread = this.cc.createCommentThread(ed.document.uri, new vscode.Range(line, 0, line, 0), [])
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
    thread.canReply = true
    thread.label = '问 opencode'
    if (!ed.selection.isEmpty) this.selectionByThread.set(thread, ed.document.getText(ed.selection))
  }

  private async resolveSession(client: OpencodeClient, absFile: string): Promise<string | undefined> {
    // 1) the session that last wrote this file
    const bySession = this.agentWrites.sessionFor(absFile)
    if (bySession) return bySession
    // 2) the most recently observed writing session in this window
    const last = this.agentWrites.lastSession()
    if (last) return last
    // 3) most recent server session whose directory matches this workspace
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
    // 4) fresh session
    try {
      return await client.createSession('VSCode quick-ask', this.workspaceRoot)
    } catch (e: any) {
      this.log.error(`createSession failed: ${e?.message ?? e}`)
      return undefined
    }
  }

  // Bound to the thread's send button (receives vscode.CommentReply).
  async submit(reply: vscode.CommentReply): Promise<void> {
    const client = this.getClient()
    const thread = reply.thread
    const question = reply.text.trim()
    if (!question) return
    if (!client) {
      this.append(thread, 'OC Review', '未连接 opencode server — 先跑 "OC Review: Connect"。')
      return
    }

    const doc = await vscode.workspace.openTextDocument(thread.uri)
    const rel = vscode.workspace.asRelativePath(thread.uri, false)
    const line = thread.range?.start.line ?? 0
    const selected = this.selectionByThread.get(thread)
    const code = selected ?? doc.lineAt(Math.min(line, doc.lineCount - 1)).text
    const lang = doc.languageId

    this.append(thread, '你', question)
    this.append(thread, 'opencode', '⏳ 已发送,等待回答…(同一 session,opencode 终端里也能看到)')

    const sessionID = this.sessionByThread.get(thread) ?? (await this.resolveSession(client, thread.uri.fsPath))
    if (!sessionID) {
      this.replaceLast(thread, 'opencode', '找不到可用 session,也无法创建 — 看 OC Review 输出面板。')
      return
    }
    this.sessionByThread.set(thread, sessionID)

    const prompt = [
      `关于 \`${rel}\` 第 ${line + 1} 行附近的代码:`,
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
    this.cc.dispose()
  }
}
