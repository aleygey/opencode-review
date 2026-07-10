import * as vscode from 'vscode'
import type { ReviewController, ReviewItem } from './controller.ts'

export const SCHEME = 'ocreview-base'

// Virtual documents serving the BASELINE content of a file, for the left side of vscode.diff.
export class BaselineDocProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this._onDidChange.event

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => {
      // A new baseline changes what these uris resolve to — refresh any open baseline tabs
      // so stale content doesn't masquerade as the current baseline.
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === SCHEME) this._onDidChange.fire(doc.uri)
      }
    })
  }

  static uriFor(item: ReviewItem, baselineId: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: '/' + item.path,
      query: JSON.stringify({ repoRoot: item.repoRoot, rel: item.path, id: baselineId }),
    })
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: { repoRoot: string; rel: string }
    try {
      q = JSON.parse(uri.query)
    } catch {
      return ''
    }
    const item = this.controller
      .state()
      .items.find((i) => i.repoRoot === q.repoRoot && i.path === q.rel)
    // For a deleted/renamed file the item may be gone after refresh — still try via engine.
    const probe = item ?? ({ repoRoot: q.repoRoot, path: q.rel } as ReviewItem)
    try {
      const res = await this.controller.baselineContent(probe)
      if (!res.exists) return '' // file did not exist at baseline (added file)
      if (res.binary) return '(binary file at baseline)'
      return res.text ?? ''
    } catch (e: any) {
      return `(failed to load baseline content: ${e?.message ?? e})`
    }
  }
}

export async function openDiff(controller: ReviewController, item: ReviewItem): Promise<void> {
  const state = controller.state()
  const left = BaselineDocProvider.uriFor(item, state.baselineId ?? 'none')
  const right = vscode.Uri.file(item.abs)
  const title = `${item.path} (baseline ↔ working)`
  if (item.status === 'del') {
    // Right side doesn't exist — open the baseline content read-only instead.
    const doc = await vscode.workspace.openTextDocument(left)
    await vscode.window.showTextDocument(doc, { preview: true })
    return
  }
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true })
}
