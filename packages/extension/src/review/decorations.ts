import * as vscode from 'vscode'
import * as path from 'node:path'
import type { ReviewController } from './controller.ts'
import { mapFileMarks } from '../lib/hunkmap.ts'

// Inline (single-column) change marks on the REAL file: added lines get a background tint +
// gutter/overview mark; deletions get a top-border anchor whose hover shows the removed lines.
export class InlineMarks {
  private added: vscode.TextEditorDecorationType
  private deleted: vscode.TextEditorDecorationType
  private enabled: boolean

  constructor(private readonly controller: ReviewController) {
    this.enabled = vscode.workspace.getConfiguration('ocReview').get<boolean>('inlineMarks', true)
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    })
    this.deleted = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '2px 0 0 0',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    })
    controller.onDidChange(() => this.refreshAll())
    vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll())
  }

  toggle(): boolean {
    this.enabled = !this.enabled
    this.refreshAll()
    return this.enabled
  }

  refreshAll(): void {
    for (const ed of vscode.window.visibleTextEditors) this.apply(ed)
  }

  private apply(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') return
    const item = this.controller.itemFor(editor.document.uri.fsPath)
    if (!this.enabled || !item || item.isBinary || item.hunks.length === 0) {
      editor.setDecorations(this.added, [])
      editor.setDecorations(this.deleted, [])
      return
    }
    const marks = mapFileMarks(item.hunks)
    const lastLine = Math.max(0, editor.document.lineCount - 1)

    const addedRanges: vscode.Range[] = marks.added
      .filter((l) => l >= 0 && l <= lastLine)
      .map((l) => editor.document.lineAt(l).range)

    const deletedOpts: vscode.DecorationOptions[] = marks.deletions.map((d) => {
      // Anchor sits on the line BELOW the removal point so the top border marks the seam.
      const line = Math.min(Math.max(d.line + 1, 0), lastLine)
      const hover = new vscode.MarkdownString()
      hover.appendMarkdown(`**OC Review — removed ${d.text.length} line(s):**\n`)
      hover.appendCodeblock(d.text.join('\n').slice(0, 1500), path.extname(item.path).slice(1) || 'text')
      return { range: editor.document.lineAt(line).range, hoverMessage: hover }
    })

    editor.setDecorations(this.added, addedRanges)
    editor.setDecorations(this.deleted, deletedOpts)
  }

  dispose(): void {
    this.added.dispose()
    this.deleted.dispose()
  }
}
