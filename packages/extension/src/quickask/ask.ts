import * as vscode from 'vscode'
import * as path from 'node:path'
import type { OpencodeClient } from '../opencode/client.ts'
import type { Log } from '../log.ts'
import { AskPanel } from './panel.ts'
import { extractTextDelta, parseModelString } from '../lib/sse.ts'
import { normcase } from '../lib/pathcase.ts'

const LAST_SESSION_KEY = 'ocReview.ask.lastSession'

async function pickSession(client: OpencodeClient, workspaceRoot: string, memento: vscode.Memento): Promise<string | undefined> {
  let sessions: Awaited<ReturnType<OpencodeClient['listSessions']>> = []
  try {
    sessions = await client.listSessions()
  } catch (e: any) {
    void vscode.window.showErrorMessage(`OC Review: cannot list sessions: ${e?.message ?? e}`)
    return undefined
  }
  const ws = normcase(workspaceRoot)
  const inWs = sessions.filter((s) => !s.directory || normcase(s.directory).startsWith(ws) || ws.startsWith(normcase(s.directory)))
  const items: (vscode.QuickPickItem & { sid?: string; create?: boolean })[] = [
    ...inWs.slice(0, 12).map((s) => ({
      label: s.title || s.id,
      description: s.directory,
      detail: s.updated ? new Date(s.updated).toLocaleString() : undefined,
      sid: s.id,
    })),
    { label: '$(add) New quick-ask session', create: true },
  ]
  const last = memento.get<string>(LAST_SESSION_KEY)
  if (last) {
    const i = items.findIndex((x) => x.sid === last)
    if (i > 0) items.unshift(items.splice(i, 1)[0])
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Ask in which opencode session?' })
  if (!picked) return undefined
  if (picked.create) {
    try {
      return await client.createSession('VSCode quick-ask', workspaceRoot)
    } catch (e: any) {
      void vscode.window.showErrorMessage(`OC Review: cannot create session: ${e?.message ?? e}`)
      return undefined
    }
  }
  return picked.sid
}

export async function quickAsk(client: OpencodeClient | undefined, workspaceRoot: string, memento: vscode.Memento, log: Log): Promise<void> {
  if (!client) {
    void vscode.window.showWarningMessage('OC Review: not connected to an opencode server (run "OC Review: Connect").')
    return
  }
  const ed = vscode.window.activeTextEditor
  if (!ed) {
    void vscode.window.showInformationMessage('OC Review: open a file and select code to ask about.')
    return
  }

  // Selection, or current line as fallback — works on changed AND unchanged code.
  const sel = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).range : new vscode.Range(ed.selection.start, ed.selection.end)
  const code = ed.document.getText(sel)
  const rel = vscode.workspace.asRelativePath(ed.document.uri, false)
  const startLine = sel.start.line + 1
  const endLine = sel.end.line + 1

  const question = await vscode.window.showInputBox({
    prompt: `Ask opencode about ${rel}:${startLine}-${endLine}`,
    placeHolder: 'e.g. 为什么这里要这样改?这段的作用是什么?',
    ignoreFocusOut: true,
  })
  if (!question) return

  const sessionID = await pickSession(client, workspaceRoot, memento)
  if (!sessionID) return
  await memento.update(LAST_SESSION_KEY, sessionID)

  const lang = ed.document.languageId
  const prompt = [
    `[VSCode quick-ask] About \`${rel}\` lines ${startLine}-${endLine}:`,
    '```' + lang,
    code.length > 12000 ? code.slice(0, 12000) + '\n…(truncated)' : code,
    '```',
    '',
    question,
    '',
    'Answer concisely. Do NOT edit any files for this question.',
  ].join('\n')

  const panel = AskPanel.show()
  panel.startQuestion(`${rel}:${startLine}-${endLine}\n${question}`)

  const abort = new AbortController()
  // Named handler so finally{} can clear it without clobbering a NEWER quick-ask's
  // handler on this singleton panel (closing the panel later must not abort an
  // unrelated in-flight turn).
  const stopHandler = () => {
    abort.abort()
    void client.abortSession(sessionID)
    panel.status('stopped')
  }
  panel.onStop = stopHandler

  // Live streaming: mirror text-part deltas for this session while the prompt call runs.
  // Progress is tracked PER PART — a session can emit several text parts (and echoes our
  // own prompt), and one cumulative counter conflates them.
  let streamedTotal = 0
  const partSeen = new Map<string, number>()
  const unsub = client.onEvent((evt) => {
    if (evt.type !== 'message.part.updated') return
    const d = extractTextDelta(evt.props)
    if (!d || d.sessionID !== sessionID) return
    const part = evt.props?.part
    if (part?.synthetic) return
    if (d.text && d.text.startsWith('[VSCode quick-ask]')) return // echo of our own prompt
    const pid = String(part?.id ?? 'anon')
    const seen = partSeen.get(pid) ?? 0
    if (d.delta) {
      partSeen.set(pid, seen + d.delta.length)
      streamedTotal += d.delta.length
      panel.appendAnswer(d.delta)
    } else if (d.text && d.text.length > seen) {
      const chunk = d.text.slice(seen)
      partSeen.set(pid, d.text.length)
      streamedTotal += chunk.length
      panel.appendAnswer(chunk)
    }
  })

  const model = parseModelString(vscode.workspace.getConfiguration('ocReview').get<string>('askModel', ''))
  try {
    panel.status('waiting for answer…')
    const res = await client.prompt(sessionID, prompt, model, abort.signal)
    if (res.text.length > 0) panel.setAnswer(res.text)
    else if (streamedTotal === 0) panel.setAnswer('(empty answer — check the OC Review output channel)')
    else panel.status('done')
  } catch (e: any) {
    if (!abort.signal.aborted) {
      log.error(`quick-ask failed: ${e?.message ?? e}`)
      panel.status(`error: ${String(e?.message ?? e).slice(0, 160)}`)
      void vscode.window.showErrorMessage(`OC Review ask failed: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  } finally {
    unsub()
    if (panel.onStop === stopHandler) panel.onStop = undefined
  }
}
