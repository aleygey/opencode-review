import * as vscode from 'vscode'
import type { ReviewController, ReviewItem } from './controller.ts'

export const SCHEME = 'ocreview-base'
export const SNAPSHOT_SCHEME = 'ocreview-snapshot'

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

export class SnapshotDocProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly controller: ReviewController) {}

  static uriFor(item: ReviewItem, side: 'base' | 'ours' | 'theirs'): vscode.Uri {
    return vscode.Uri.from({
      scheme: SNAPSHOT_SCHEME,
      path: '/' + item.path,
      query: JSON.stringify({ abs: item.abs, side, hash: item.conflict?.[side]?.hash }),
    })
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    try {
      const query = JSON.parse(uri.query) as { abs: string; side: 'base' | 'ours' | 'theirs' }
      const item = this.controller.itemFor(query.abs)
      if (!item) return '(conflict capture is no longer pending)'
      const result = this.controller.conflictContent(item, query.side)
      if (!result.exists) return `(no ${query.side} stage)`
      if (result.binary) return `(binary ${query.side} stage)`
      return result.text ?? ''
    } catch (error: any) {
      return `(failed to load conflict stage: ${error?.message ?? error})`
    }
  }
}

export async function openDiff(controller: ReviewController, item: ReviewItem): Promise<void> {
  if (item.isBinary) {
    // A text diff of a compiled artifact is meaningless — say so instead of opening
    // a diff whose baseline side is just a placeholder string.
    void vscode.window.showInformationMessage(
      `「${item.path}」是二进制文件(如编译产物),没有文本 diff。建议把构建产物加进 .gitignore,它们就不会进入审查列表。`,
    )
    return
  }
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

export async function openConflictDiff(
  controller: ReviewController,
  item: ReviewItem,
  side: 'base' | 'ours' | 'theirs',
): Promise<void> {
  if (!item.conflict?.[side]) {
    void vscode.window.showInformationMessage(`OC Review: no ${side} stage exists for ${item.path}.`)
    return
  }
  const left = SnapshotDocProvider.uriFor(item, side)
  const right = vscode.Uri.file(item.abs)
  await vscode.commands.executeCommand('vscode.diff', left, right, `${item.path} (${side} ↔ working conflict)`, { preview: true })
}
