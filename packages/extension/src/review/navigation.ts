import * as vscode from 'vscode'
import * as path from 'node:path'
import type { ReviewController } from './controller.ts'
import { hunkFirstLine } from '../lib/hunkmap.ts'

type Stop = { abs: string; line: number }

// Flat, ordered list of every hunk across every changed file — powers next/prev-change.
function stops(controller: ReviewController): Stop[] {
  const out: Stop[] = []
  for (const item of controller.state().items) {
    if (item.isBinary) {
      out.push({ abs: item.abs, line: 0 })
      continue
    }
    for (const h of item.hunks) out.push({ abs: item.abs, line: hunkFirstLine(h.header, h.body) })
    if (item.hunks.length === 0) out.push({ abs: item.abs, line: 0 })
  }
  out.sort((a, b) => (a.abs === b.abs ? a.line - b.line : a.abs.localeCompare(b.abs)))
  return out
}

export async function gotoStop(s: Stop): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.abs))
    const ed = await vscode.window.showTextDocument(doc, { preview: true })
    const line = Math.min(s.line, Math.max(0, doc.lineCount - 1))
    const pos = new vscode.Position(line, 0)
    ed.selection = new vscode.Selection(pos, pos)
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
  } catch (e: any) {
    void vscode.window.showWarningMessage(`OC Review: cannot open ${path.basename(s.abs)}: ${e?.message ?? e}`)
  }
}

export async function nextChange(controller: ReviewController, dir: 1 | -1): Promise<void> {
  const list = stops(controller)
  if (list.length === 0) {
    void vscode.window.showInformationMessage('OC Review: no changes since baseline')
    return
  }
  const ed = vscode.window.activeTextEditor
  const curAbs = ed?.document.uri.scheme === 'file' ? path.normalize(ed.document.uri.fsPath) : undefined
  const curLine = ed?.selection.active.line ?? -1

  let idx: number
  if (curAbs === undefined) {
    idx = dir === 1 ? 0 : list.length - 1
  } else {
    if (dir === 1) {
      idx = list.findIndex((s) => {
        const c = path.normalize(s.abs).localeCompare(curAbs)
        return c > 0 || (c === 0 && s.line > curLine)
      })
      if (idx < 0) idx = 0 // wrap
    } else {
      const ridx = [...list].reverse().findIndex((s) => {
        const c = path.normalize(s.abs).localeCompare(curAbs)
        return c < 0 || (c === 0 && s.line < curLine)
      })
      idx = ridx < 0 ? list.length - 1 : list.length - 1 - ridx
    }
  }
  await gotoStop(list[idx])
}
