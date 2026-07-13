import * as vscode from 'vscode'
import type { ReviewController } from './controller.ts'

// Explorer/tab badges for changed files — the same at-a-glance markers git gives you,
// but against the OC baseline. Lets the user review from the normal Explorer instead of
// having to live in the OC Review view.
export class ChangedFileDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChange.event
  private previous = new Map<string, string>()

  constructor(private readonly controller: ReviewController) {
    this.previous = this.snapshot()
    controller.onDidChange(() => {
      const next = this.snapshot()
      const changed: vscode.Uri[] = []
      for (const key of new Set([...this.previous.keys(), ...next.keys()])) {
        if (this.previous.get(key) !== next.get(key)) changed.push(vscode.Uri.file(key))
      }
      this.previous = next
      if (changed.length > 0) this._onDidChange.fire(changed)
    })
  }

  private snapshot(): Map<string, string> {
    return new Map(
      this.controller.state().items.map((i) => [i.abs, `${i.status}\0${i.attribution}\0${i.reviewed}`]),
    )
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
