import * as vscode from 'vscode'
import type { ReviewController } from './controller.ts'

// Explorer/tab badges for changed files — the same at-a-glance markers git gives you,
// but against the OC baseline. Lets the user review from the normal Explorer instead of
// having to live in the OC Review view.
export class ChangedFileDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChange.event

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => this._onDidChange.fire(undefined)) // refresh all
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined
    const item = this.controller.itemFor(uri.fsPath)
    if (!item) return undefined
    const badge = item.status === 'add' ? 'A' : item.status === 'del' ? 'D' : item.status === 'rename' ? 'R' : 'M'
    const color =
      item.status === 'add'
        ? new vscode.ThemeColor('gitDecoration.addedResourceForeground')
        : item.status === 'del'
          ? new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
          : new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
    const deco = new vscode.FileDecoration(
      badge,
      `OC Review: ${item.status} (${item.attribution})${item.reviewed ? ' ✓reviewed' : ''}`,
      color,
    )
    // Bubble the mark up to collapsed parent FOLDERS (same behavior as git decorations),
    // so a directory containing changes is visible without expanding it.
    deco.propagate = true
    return deco
  }
}
