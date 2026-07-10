import * as vscode from 'vscode'
import * as path from 'node:path'
import type { ReviewController, ReviewItem, ReviewState } from './controller.ts'
import { hunkFirstLine } from '../lib/hunkmap.ts'

export type Node =
  | { kind: 'info'; label: string; desc?: string; warn?: boolean }
  | { kind: 'repo'; repoRoot: string; rel: string; items: ReviewItem[] }
  | { kind: 'file'; item: ReviewItem }
  | { kind: 'hunk'; item: ReviewItem; index: number }

function statusIcon(item: ReviewItem): vscode.ThemeIcon {
  if (item.status === 'add') return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'))
  if (item.status === 'del') return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'))
  return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'))
}

function plusMinus(item: ReviewItem): string {
  let a = 0
  let d = 0
  for (const h of item.hunks) {
    for (const line of h.body.split('\n')) {
      if (line.startsWith('+')) a++
      else if (line.startsWith('-')) d++
    }
  }
  if (item.isBinary) return 'bin'
  return `${a ? `+${a}` : ''}${d ? ` -${d}` : ''}`.trim() || (item.status === 'del' ? 'deleted' : '')
}

export class ChangesTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  private state: ReviewState

  constructor(private readonly controller: ReviewController) {
    this.state = controller.state()
    controller.onDidChange((s) => {
      this.state = s
      this._onDidChangeTreeData.fire()
    })
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'info': {
        const t = new vscode.TreeItem(node.label)
        t.description = node.desc
        t.iconPath = node.warn
          ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
          : new vscode.ThemeIcon('info')
        t.contextValue = 'info'
        if (node.warn) t.tooltip = node.desc
        return t
      }
      case 'repo': {
        const t = new vscode.TreeItem(node.rel === '.' ? '(workspace root)' : node.rel, vscode.TreeItemCollapsibleState.Expanded)
        t.iconPath = new vscode.ThemeIcon('repo')
        t.description = `${node.items.length} file(s)`
        t.contextValue = 'repo'
        t.id = `repo:${node.repoRoot}`
        return t
      }
      case 'file': {
        const it = node.item
        const t = new vscode.TreeItem(it.path, it.hunks.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        t.iconPath = statusIcon(it)
        const badges: string[] = [plusMinus(it)]
        if (it.attribution === 'co-touched') badges.push('⚠ co-touched')
        else if (it.attribution === 'unverified') badges.push('unverified')
        if (it.reviewed) badges.push('✓ reviewed')
        t.description = badges.filter(Boolean).join('  ')
        t.contextValue = 'file'
        t.id = `file:${it.repoRoot}:${it.path}`
        t.resourceUri = vscode.Uri.file(it.abs)
        t.tooltip = new vscode.MarkdownString(
          `**${it.path}**  \nstatus: ${it.status}${it.isBinary ? ' (binary)' : ''}  \nattribution: ${it.attribution}  \nrepo: ${it.repoRoot}`,
        )
        t.command = { command: 'ocReview.openDiff', title: 'Open Diff', arguments: [node] }
        if (it.reviewed) t.iconPath = new vscode.ThemeIcon('check')
        return t
      }
      case 'hunk': {
        const it = node.item
        const h = it.hunks[node.index]
        const line = hunkFirstLine(h.header, h.body)
        const t = new vscode.TreeItem(`@@ line ${line + 1}`)
        t.iconPath = new vscode.ThemeIcon('list-selection')
        t.description = h.header.replace(/^@@ | @@.*$/g, '')
        t.contextValue = 'hunk'
        t.id = `hunk:${it.repoRoot}:${it.path}:${node.index}`
        const md = new vscode.MarkdownString()
        md.appendCodeblock(`${h.header}\n${h.body}`.slice(0, 2000), 'diff')
        t.tooltip = md
        t.command = {
          command: 'ocReview.gotoHunk',
          title: 'Go to Hunk',
          arguments: [it.abs, line],
        }
        return t
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const s = this.state
      if (!s.baselineId) {
        return [{ kind: 'info', label: 'No baseline yet', desc: 'Run "OC Review: Checkpoint Now"' }]
      }
      const when = s.baselineAt ? new Date(s.baselineAt).toLocaleTimeString() : ''
      const info: Node = { kind: 'info', label: `Baseline ${s.baselineId}`, desc: when }
      // A baseline repo whose worktree disappeared is possible data loss — never hide it.
      const missing: Node[] = (s.missingRepos ?? []).map((m) => ({
        kind: 'info' as const,
        label: `⚠ repo deleted since baseline: ${m.rel}`,
        desc: 'worktree gone — baseline is safe in the shadow store; restore the folder (git init/clone), then Refresh',
        warn: true,
      }))
      if (s.items.length === 0) return [info, ...missing, { kind: 'info', label: 'No changes since baseline' }]
      const byRepo = new Map<string, ReviewItem[]>()
      for (const it of s.items) {
        const list = byRepo.get(it.repoRoot) ?? []
        list.push(it)
        byRepo.set(it.repoRoot, list)
      }
      const repoNodes: Node[] = [...byRepo.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([repoRoot, items]) => ({
          kind: 'repo' as const,
          repoRoot,
          rel: s.repos.find((r) => r.repoRoot === repoRoot)?.relToWorkspace ?? path.basename(repoRoot),
          items: items.sort((a, b) => a.path.localeCompare(b.path)),
        }))
      return [info, ...missing, ...repoNodes]
    }
    if (node.kind === 'repo') return node.items.map((item) => ({ kind: 'file' as const, item }))
    if (node.kind === 'file') return node.item.hunks.map((_, index) => ({ kind: 'hunk' as const, item: node.item, index }))
    return []
  }
}
