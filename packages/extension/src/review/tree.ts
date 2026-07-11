import * as vscode from 'vscode'
import * as path from 'node:path'
import type { ReviewController, ReviewItem, ReviewState } from './controller.ts'

// ONE merged, workspace-rooted directory tree. Nested git repos render as ORDINARY
// folders at their real path (the repo boundary matters for revert scoping, not for
// reading the tree); files are leaves (no hunk children — hunk-level actions live in
// the editor: CodeLens + diff-editor arrows).
export type DirIndex = Map<string, { dirs: string[]; files: { item: ReviewItem; wsPath: string }[] }>

export type Node =
  | { kind: 'info'; label: string; desc?: string; warn?: boolean }
  | { kind: 'newRepo'; repoRoot: string; rel: string; agentCreated: boolean }
  | { kind: 'dir'; rel: string; repoRoot?: string; index: DirIndex } // repoRoot set when this dir IS a nested repo root
  | { kind: 'file'; item: ReviewItem; wsDir?: string }

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

function buildDirIndex(entries: { item: ReviewItem; wsPath: string }[]): DirIndex {
  const idx: DirIndex = new Map()
  const ensure = (d: string) => {
    let e = idx.get(d)
    if (!e) {
      e = { dirs: [], files: [] }
      idx.set(d, e)
    }
    return e
  }
  ensure('')
  for (const en of entries) {
    const parts = en.wsPath.split('/')
    let dir = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const child = dir ? `${dir}/${parts[i]}` : parts[i]
      const parent = ensure(dir)
      if (!parent.dirs.includes(child)) parent.dirs.push(child)
      ensure(child)
      dir = child
    }
    ensure(dir).files.push(en)
  }
  for (const e of idx.values()) {
    e.dirs.sort()
    e.files.sort((a, b) => a.wsPath.localeCompare(b.wsPath))
  }
  return idx
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

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  private treeMode(): boolean {
    return vscode.workspace.getConfiguration('ocReview').get<string>('viewMode', 'tree') === 'tree'
  }

  // workspace-relative path of an item = its repo's rel prefix + repo-relative path
  private wsPathOf(item: ReviewItem): string {
    const rel = this.state.repos.find((r) => r.repoRoot === item.repoRoot)?.relToWorkspace ?? ''
    return !rel || rel === '.' ? item.path : `${rel}/${item.path}`
  }

  private dirNodes(rel: string, index: DirIndex): Node[] {
    const e = index.get(rel)
    if (!e) return []
    return [
      ...e.dirs.map((d) => ({
        kind: 'dir' as const,
        rel: d,
        repoRoot: this.state.repos.find((r) => r.relToWorkspace === d)?.repoRoot,
        index,
      })),
      ...e.files.map((f) => ({ kind: 'file' as const, item: f.item })),
    ]
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
      case 'newRepo': {
        const t = new vscode.TreeItem(`⚠ 新仓库未纳入基线: ${node.rel}`)
        t.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
        t.description = node.agentCreated ? 'agent 创建 — 点击采纳(当前内容成为基线)' : '点击采纳(当前内容成为基线)'
        t.tooltip =
          '这个 git 仓库是在基线之后出现的,没有 checkpoint,里面的改动现在不可见。\n' +
          '点击把它以「当前内容」纳入基线 — 之后的改动才可审查/回滚。\n' +
          (node.agentCreated ? '⚠ 检测到它是 agent 创建的:采纳=接受 agent 当前的全部输出为基线。' : '')
        t.contextValue = 'newRepo'
        t.command = { command: 'ocReview.adoptRepo', title: 'Adopt Repo', arguments: [node] }
        return t
      }
      case 'dir': {
        const t = new vscode.TreeItem(
          vscode.Uri.file(path.join(this.controller.workspaceRoot, node.rel)),
          vscode.TreeItemCollapsibleState.Expanded,
        )
        t.iconPath = vscode.ThemeIcon.Folder // uniform folder icon — repo boundary is invisible
        t.contextValue = node.repoRoot ? 'repoDir' : 'dir'
        t.id = `dir:${node.rel}`
        if (node.repoRoot) t.tooltip = `${node.rel}\n(独立 git 仓库 — 可整仓库回退)`
        return t
      }
      case 'file': {
        const it = node.item
        const t = new vscode.TreeItem(vscode.Uri.file(it.abs), vscode.TreeItemCollapsibleState.None)
        // Explicit ThemeIcon.File is REQUIRED: with a falsy iconPath a COLLAPSIBLE item
        // gets the folder icon; leaves are safe but we stay explicit.
        t.iconPath = vscode.ThemeIcon.File
        const badges: string[] = []
        if (node.wsDir) badges.push(node.wsDir)
        if (it.status === 'rename' && it.oldPath) {
          badges.push(`moved ← ${it.oldPath}`)
        } else {
          const pm = plusMinus(it)
          if (pm) badges.push(pm)
        }
        if (it.attribution === 'co-touched') badges.push('⚠ co-touched')
        else if (it.attribution === 'unverified') badges.push('unverified')
        if (it.reviewed) badges.push('✓')
        t.description = badges.join(' · ')
        t.contextValue = 'file'
        t.id = `file:${it.repoRoot}:${it.path}`
        t.tooltip = new vscode.MarkdownString(
          `**${this.wsPathOf(it)}**  \nstatus: ${it.status}${it.isBinary ? ' (binary)' : ''}  \nattribution: ${it.attribution}${it.reviewed ? '  \n✓ reviewed' : ''}  \nrepo: ${it.repoRoot}`,
        )
        t.command = { command: 'ocReview.openDiff', title: 'Diff', arguments: [node] }
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
      const info: Node = s.baselineNote
        ? { kind: 'info', label: `📌 ${s.baselineNote}`, desc: when }
        : { kind: 'info', label: `Baseline ${s.baselineId}`, desc: when }
      const missing: Node[] = (s.missingRepos ?? []).map((m) => ({
        kind: 'info' as const,
        label: `⚠ repo deleted since baseline: ${m.rel}`,
        desc: 'worktree gone — baseline is safe in the shadow store; restore the folder (git init/clone), then Refresh',
        warn: true,
      }))
      const fresh: Node[] = (s.newRepos ?? []).map((m) => ({
        kind: 'newRepo' as const,
        repoRoot: m.repoRoot,
        rel: m.rel,
        agentCreated: m.agentCreated,
      }))
      if (s.items.length === 0) return [info, ...missing, ...fresh, { kind: 'info', label: 'No changes since baseline' }]

      const entries = s.items.map((item) => ({ item, wsPath: this.wsPathOf(item) }))
      if (!this.treeMode()) {
        const files: Node[] = entries
          .sort((a, b) => a.wsPath.localeCompare(b.wsPath))
          .map((e) => {
            const d = path.dirname(e.wsPath)
            return { kind: 'file' as const, item: e.item, wsDir: d === '.' ? undefined : d }
          })
        return [info, ...missing, ...fresh, ...files]
      }
      const index = buildDirIndex(entries)
      return [info, ...missing, ...fresh, ...this.dirNodes('', index)]
    }
    if (node.kind === 'dir') return this.dirNodes(node.rel, node.index)
    return [] // files are leaves — hunk actions live in the editor (CodeLens / diff arrows)
  }
}
