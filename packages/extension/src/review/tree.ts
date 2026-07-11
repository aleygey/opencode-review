import * as vscode from 'vscode'
import * as path from 'node:path'
import type { ReviewController, ReviewItem, ReviewState } from './controller.ts'
import { hunkFirstLine } from '../lib/hunkmap.ts'

export type Node =
  | { kind: 'info'; label: string; desc?: string; warn?: boolean }
  | { kind: 'newRepo'; repoRoot: string; rel: string; agentCreated: boolean }
  | { kind: 'repo'; repoRoot: string; rel: string; items: ReviewItem[]; index: DirIndex }
  | { kind: 'dir'; repoRoot: string; rel: string; index: DirIndex }
  | { kind: 'file'; item: ReviewItem; showDir: boolean }
  | { kind: 'hunk'; item: ReviewItem; index: number }

// Directory index per repo: dir rel-path ('' = repo root) -> immediate child dirs + files.
export type DirIndex = Map<string, { dirs: string[]; files: ReviewItem[] }>

function buildDirIndex(items: ReviewItem[]): DirIndex {
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
  for (const it of items) {
    const parts = it.path.split('/')
    let dir = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const child = dir ? `${dir}/${parts[i]}` : parts[i]
      const parent = ensure(dir)
      if (!parent.dirs.includes(child)) parent.dirs.push(child)
      ensure(child)
      dir = child
    }
    ensure(dir).files.push(it)
  }
  for (const e of idx.values()) {
    e.dirs.sort()
    e.files.sort((a, b) => a.path.localeCompare(b.path))
  }
  return idx
}

function dirEntries(node: { repoRoot: string; rel: string; index: DirIndex }): Node[] {
  const e = node.index.get(node.rel)
  if (!e) return []
  return [
    ...e.dirs.map((rel) => ({ kind: 'dir' as const, repoRoot: node.repoRoot, rel, index: node.index })),
    ...e.files.map((item) => ({ kind: 'file' as const, item, showDir: false })),
  ]
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

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  private treeMode(): boolean {
    return vscode.workspace.getConfiguration('ocReview').get<string>('viewMode', 'tree') === 'tree'
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'dir': {
        const t = new vscode.TreeItem(
          vscode.Uri.file(path.join(node.repoRoot, node.rel)),
          vscode.TreeItemCollapsibleState.Expanded,
        )
        t.iconPath = vscode.ThemeIcon.Folder // folder icon from the active icon theme
        t.contextValue = 'dir'
        t.id = `dir:${node.repoRoot}:${node.rel}`
        return t
      }
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
        // SCM-list convention: label = filename with the ICON THEME's file-type icon
        // (resourceUri + no iconPath), M/A/D + color rendered by the FileDecorationProvider,
        // and the directory path as the dimmed description — same-named files in different
        // OEM directories stay distinguishable.
        const t = new vscode.TreeItem(
          vscode.Uri.file(it.abs),
          it.hunks.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        )
        // Explicit ThemeIcon.File is REQUIRED: with a falsy iconPath a COLLAPSIBLE item
        // gets the folder icon, not the file-type icon derived from resourceUri.
        t.iconPath = vscode.ThemeIcon.File
        const dir = path.dirname(it.path)
        const badges: string[] = []
        if (node.showDir && dir && dir !== '.') badges.push(dir)
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
          `**${it.path}**  \nstatus: ${it.status}${it.isBinary ? ' (binary)' : ''}  \nattribution: ${it.attribution}${it.reviewed ? '  \n✓ reviewed' : ''}  \nrepo: ${it.repoRoot}`,
        )
        t.command = { command: 'ocReview.openDiff', title: 'Diff', arguments: [node] }
        return t
      }
      case 'hunk': {
        const it = node.item
        const h = it.hunks[node.index]
        const line = hunkFirstLine(h.header, h.body)
        let adds = 0
        let dels = 0
        let snippet = ''
        for (const l of h.body.split('\n')) {
          if (l.startsWith('+')) {
            adds++
            if (!snippet) snippet = l.slice(1).trim()
          } else if (l.startsWith('-')) {
            dels++
            if (!snippet) snippet = l.slice(1).trim()
          }
        }
        const t = new vscode.TreeItem(`L${line + 1} · ${adds ? `+${adds}` : ''}${adds && dels ? ' ' : ''}${dels ? `−${dels}` : ''}`)
        t.iconPath = new vscode.ThemeIcon('list-selection')
        t.description = snippet.slice(0, 40)
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
      // The baseline row carries the INTENT of this batch (the turn's user prompt / manual note).
      const info: Node = s.baselineNote
        ? { kind: 'info', label: `📌 ${s.baselineNote}`, desc: when }
        : { kind: 'info', label: `Baseline ${s.baselineId}`, desc: when }
      // A baseline repo whose worktree disappeared is possible data loss — never hide it.
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
          index: buildDirIndex(items),
        }))
      return [info, ...missing, ...fresh, ...repoNodes]
    }
    if (node.kind === 'repo') {
      // Hierarchical (default): repo -> folders -> files, like the SCM tree view.
      if (this.treeMode()) return dirEntries({ repoRoot: node.repoRoot, rel: '', index: node.index })
      return node.items.map((item) => ({ kind: 'file' as const, item, showDir: true }))
    }
    if (node.kind === 'dir') return dirEntries(node)
    if (node.kind === 'file') return node.item.hunks.map((_, index) => ({ kind: 'hunk' as const, item: node.item, index }))
    return []
  }
}
