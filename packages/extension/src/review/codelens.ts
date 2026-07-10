import * as vscode from 'vscode'
import type { ReviewController } from './controller.ts'
import { hunkFirstLine } from '../lib/hunkmap.ts'

// One-click revert affordance directly in the editor: a lens above every changed hunk
// (and a file-level pair on line 0). Clicking still goes through the same confirmation
// modal as the tree action — the click is direct, the safety gate stays.
export class RevertLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => this._onDidChangeCodeLenses.fire())
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== 'file') return []
    if (!vscode.workspace.getConfiguration('ocReview').get<boolean>('codeLens', true)) return []
    const item = this.controller.itemFor(doc.uri.fsPath)
    if (!item || item.isBinary) return []

    const lenses: vscode.CodeLens[] = []
    const top = new vscode.Range(0, 0, 0, 0)
    lenses.push(
      new vscode.CodeLens(top, {
        command: 'ocReview.openDiff',
        title: `$(diff) diff${item.attribution === 'agent' ? '' : ` · ${item.attribution}`}`,
        arguments: [item],
      }),
      new vscode.CodeLens(top, {
        command: 'ocReview.revertFile',
        title: '$(discard) 撤销文件',
        arguments: [item],
      }),
    )
    const lastLine = Math.max(0, doc.lineCount - 1)
    item.hunks.forEach((h, index) => {
      const line = Math.min(hunkFirstLine(h.header, h.body), lastLine)
      lenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          command: 'ocReview.revertHunk',
          title: '$(discard) 撤销块',
          arguments: [item, index],
        }),
      )
    })
    return lenses
  }
}
