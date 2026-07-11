import * as vscode from 'vscode'
import * as path from 'node:path'
import { Log } from './log.ts'
import { EngineClient } from './engineClient.ts'
import { discoverServer } from './opencode/discovery.ts'
import { OpencodeClient } from './opencode/client.ts'
import { AgentWriteStore } from './opencode/agentWrites.ts'
import { ReviewController, type ReviewItem } from './review/controller.ts'
import { ChangesTree, type Node } from './review/tree.ts'
import { BaselineDocProvider, SCHEME, openDiff } from './review/diffdoc.ts'
import { InlineMarks } from './review/decorations.ts'
import { RevertLensProvider } from './review/codelens.ts'
import { ChangedFileDecorations } from './review/filedecor.ts'
import { Attribution } from './review/attribution.ts'
import { nextChange, gotoStop } from './review/navigation.ts'
import { AskThreads } from './quickask/ask.ts'
import { extractToolEvent } from './lib/sse.ts'

let client: OpencodeClient | undefined

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const log = new Log('OC Review')
  ctx.subscriptions.push(log)

  const wsFolder = vscode.workspace.workspaceFolders?.[0]
  if (!wsFolder || wsFolder.uri.scheme !== 'file') {
    // Register stubs so contributed commands don't error with "command not found".
    const stubs = [
      'connect', 'checkpoint', 'refresh', 'acceptAll', 'openDiff', 'revertFile', 'revertHunk',
      'revertRepo', 'markReviewed', 'nextChange', 'prevChange', 'toggleInline', 'quickAsk', 'diagnose', 'gotoHunk',
      'adoptRepo', 'explainPath', 'askSubmit', 'revertAll', 'baselines', 'undoRevert', 'redoRevert', 'clearAskThreads',
    ]
    for (const c of stubs) {
      ctx.subscriptions.push(
        vscode.commands.registerCommand(`ocReview.${c}`, () =>
          vscode.window.showInformationMessage('OC Review requires an open local folder (file scheme).'),
        ),
      )
    }
    log.info('no file workspace folder — OC Review inactive')
    return
  }
  const workspaceRoot = wsFolder.uri.fsPath

  const cfg = () => vscode.workspace.getConfiguration('ocReview')
  const shadowDir = cfg().get<string>('shadowDir', '') || path.join(ctx.globalStorageUri.fsPath, 'shadow')

  // ---- engine (forked worker) ----
  const engine = new EngineClient(ctx.asAbsolutePath('dist/engineHost.js'), log)
  ctx.subscriptions.push({ dispose: () => engine.dispose() })

  const agentWrites = new AgentWriteStore(workspaceRoot, log)
  const controller = new ReviewController(workspaceRoot, shadowDir, engine, agentWrites, ctx.workspaceState, log)
  ctx.subscriptions.push(controller)

  // ---- UI ----
  const tree = new ChangesTree(controller)
  ctx.subscriptions.push(vscode.window.createTreeView('ocReview.changes', { treeDataProvider: tree, showCollapseAll: true }))
  const baselineDocs = new BaselineDocProvider(controller)
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, baselineDocs))
  const marks = new InlineMarks(controller)
  ctx.subscriptions.push(marks)
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new RevertLensProvider(controller)))
  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider(new ChangedFileDecorations(controller)))
  const attribution = new Attribution(controller, agentWrites, log)
  const askThreads = new AskThreads(() => client, agentWrites, workspaceRoot, ctx.workspaceState, log, (abs, lines) =>
    attribution.ownerForLines(abs, lines),
  )
  ctx.subscriptions.push(askThreads)

  // Keep the agent's world-model in sync: after the user reverts/undoes files, tell the
  // owning session (context-only, no model turn) so it re-reads before further edits.
  // Explicit feedback so the user can CONFIRM delivery: status bar on success, warning on
  // failure or when no owning session is known.
  const notifyAgent = (paths: string[], action: string, targets?: Map<string, string[]>): void => {
    if (!client || paths.length === 0) return
    if (!cfg().get<boolean>('notifyAgent', true)) return
    const bySession = new Map<string, string[]>()
    const orphans: string[] = []
    for (const p of paths) {
      // Precise block/file-level targets when the caller computed them (line blame);
      // otherwise every session that wrote this file — never fewer than the truth needs.
      let sids = targets?.get(p) ?? []
      if (sids.length === 0) sids = agentWrites.sessionsFor(p)
      if (sids.length === 0) {
        const last = agentWrites.lastSession()
        if (last) sids = [last]
      }
      const rel = vscode.workspace.asRelativePath(p, false)
      if (sids.length === 0) {
        orphans.push(rel)
        continue
      }
      for (const sid of sids) {
        const list = bySession.get(sid) ?? []
        list.push(rel)
        bySession.set(sid, list)
      }
    }
    void (async () => {
      let ok = 0
      let fail = 0
      for (const [sid, rels] of bySession) {
        const sent = await client!.notify(
          sid,
          `[oc-review] 用户在 VSCode 中${action}了这些文件,磁盘内容已变化(不要假设你之前的编辑仍然存在,修改前请重新读取): ${rels.join(', ')}`,
        )
        if (sent) {
          ok++
          log.info(`notify ok -> session ${sid}: ${rels.join(', ')}`)
        } else fail++
      }
      if (ok > 0 && fail === 0) {
        void vscode.window.setStatusBarMessage(`$(check) OC Review: 已同步给 opencode(${ok} 个 session)`, 5000)
      }
      if (fail > 0) {
        void vscode.window.showWarningMessage(
          'OC Review: 未能把回退信息同步给 opencode(server 可能不支持 noReply)— agent 可能仍认为旧内容在盘上。详见输出面板。',
        )
      }
      if (orphans.length > 0 && bySession.size === 0) {
        log.warn(`notify skipped — no known session for: ${orphans.join(', ')}`)
        void vscode.window.setStatusBarMessage('OC Review: 未知归属 session,回退未同步给 agent', 5000)
      }
    })()
  }

  // Context key so Explorer context-menu entries only appear on files that actually changed.
  controller.onDidChange((s) => {
    void vscode.commands.executeCommand('setContext', 'ocReview.changedPaths', s.items.map((i) => i.abs))
  })

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  status.command = 'ocReview.changes.focus'
  ctx.subscriptions.push(status)
  const renderStatus = () => {
    const s = controller.state()
    const conn = client?.connected ? '$(plug)' : '$(debug-disconnect)'
    if (!s.baselineId) status.text = `${conn} OC: no baseline`
    else status.text = `${conn} OC: ${s.items.length} file(s)`
    status.tooltip = `OC Review — server: ${client ? client.info.baseUrl : 'not connected'}\nbaseline: ${s.baselineId ?? 'none'}`
    status.show()
  }
  controller.onDidChange(renderStatus)

  // ---- opencode connection + event wiring ----
  const turnSeen = new Set<string>() // sessionIDs whose turn-start we already checkpointed

  const wireEvents = (c: OpencodeClient) => {
    c.onEvent((evt) => {
      agentWrites.handleEvent(evt)

      // Turn start: session goes busy, or the first file-tool activity appears.
      if (evt.type === 'session.status') {
        const busy =
          evt.props?.status?.type === 'busy' ||
          evt.props?.status === 'busy' ||
          evt.props?.info?.status === 'busy'
        const sid = evt.props?.sessionID ?? evt.props?.info?.id
        if (busy && sid && !turnSeen.has(sid)) {
          turnSeen.add(sid)
          if (cfg().get<string>('autoCheckpoint', 'turn') === 'turn') void controller.onTurnStart()
        }
        return
      }
      if (evt.type === 'message.part.updated') {
        const t = extractToolEvent(evt.props)
        if (t && (t.status === 'pending' || t.status === 'running') && cfg().get<string>('autoCheckpoint', 'turn') === 'turn') {
          if (!controller.hasBaseline()) void controller.onTurnStart()
        }
        return
      }
      if (evt.type === 'session.idle') {
        const sid = evt.props?.sessionID
        if (sid) turnSeen.delete(sid)
        controller.scheduleRefresh(500)
        return
      }
      if (evt.type === 'file.edited' || evt.type === 'file.watcher.updated') {
        controller.scheduleRefresh(1500)
        return
      }
      // Permission prompts (only fire if the user kept some permission on "ask").
      if (evt.type === 'permission.asked' || evt.type === 'permission.updated') {
        const p = evt.props
        const pid = p?.id
        if (!pid) return
        const title = p?.title ?? p?.type ?? 'permission'
        void vscode.window
          .showWarningMessage(`opencode asks: ${title}`, 'Allow once', 'Always', 'Deny')
          .then((choice) => {
            if (!choice || !client) return
            const map = { 'Allow once': 'once', Always: 'always', Deny: 'reject' } as const
            void client.replyPermission(p?.sessionID, pid, map[choice as keyof typeof map])
          })
      }
    })
    c.startEvents(workspaceRoot)
  }

  const connect = async (verbose: boolean): Promise<void> => {
    const conf = cfg()
    const info = await discoverServer(
      workspaceRoot,
      {
        serverUrl: conf.get<string>('serverUrl', ''),
        serverPassword: conf.get<string>('serverPassword', ''),
        probePorts: conf.get<number[]>('probePorts', [4096]),
      },
      log,
    )
    client?.dispose()
    client = undefined
    if (!info) {
      if (verbose)
        void vscode.window.showWarningMessage(
          'OC Review: no opencode server found. Start one with `opencode serve` (default port 4096) or set ocReview.serverUrl.',
        )
      log.warn('no opencode server discovered')
      renderStatus()
      return
    }
    client = new OpencodeClient(info, log)
    wireEvents(client)
    log.info(`connected: ${info.baseUrl} (${info.source})`)
    if (verbose) void vscode.window.showInformationMessage(`OC Review: connected to ${info.baseUrl}`)
    renderStatus()
  }

  // ---- commands ----
  const reg = (cmd: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(cmd, fn))

  reg('ocReview.connect', () => connect(true))

  reg('ocReview.checkpoint', () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'OC Review: checkpointing…' }, async () => {
      await controller.newBaseline('manual')
      await controller.refresh()
    }),
  )

  reg('ocReview.refresh', () => controller.refresh())

  reg('ocReview.acceptAll', async () => {
    const n = controller.state().items.length
    const yes = await vscode.window.showInformationMessage(`Accept all ${n} change(s) and start a new baseline?`, { modal: true }, 'Accept All')
    if (yes !== 'Accept All') return
    await controller.newBaseline('accept-all')
    await controller.refresh()
  })

  const itemOf = (node: Node | ReviewItem | vscode.Uri | undefined): ReviewItem | undefined => {
    if (!node) return undefined
    if (node instanceof vscode.Uri) return controller.itemFor(node.fsPath) // Explorer context menu
    if ((node as any).kind === 'file') return (node as Extract<Node, { kind: 'file' }>).item
    if ((node as any).kind === 'hunk') return (node as Extract<Node, { kind: 'hunk' }>).item
    if ((node as any).abs) return node as ReviewItem
    return undefined
  }

  reg('ocReview.openDiff', async (node?: Node | vscode.Uri) => {
    const item = itemOf(node) ?? controller.itemFor(vscode.window.activeTextEditor?.document.uri.fsPath ?? '')
    if (!item) return
    await openDiff(controller, item)
  })

  reg('ocReview.revertFile', async (node?: Node | vscode.Uri) => {
    const item = itemOf(node)
    if (!item) return
    let allowCoTouched = false
    if (item.coTouchedByUser) {
      const yes = await vscode.window.showWarningMessage(
        `"${item.path}" has edits NOT attributed to opencode (attribution: ${item.attribution}). Reverting will also lose those edits.`,
        { modal: true },
        'Revert anyway',
      )
      if (yes !== 'Revert anyway') return
      allowCoTouched = true
    } else {
      const verb = item.status === 'add' ? 'Delete this agent-added file' : 'Revert to baseline'
      const yes = await vscode.window.showWarningMessage(`${verb}: ${item.path}?`, { modal: true }, 'Revert')
      if (yes !== 'Revert') return
    }
    try {
      const targets = new Map([[item.abs, await attribution.ownersForFile(item)]])
      const paths = await controller.revertFile(item, allowCoTouched)
      notifyAgent(paths, '回退(revert)', targets)
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Revert failed: ${e?.message ?? e}`)
    }
  })

  reg('ocReview.revertHunk', async (a?: any, b?: number) => {
    // Accepts a tree hunk node OR (item, index) from a CodeLens / inline icon.
    let h: { item: ReviewItem; index: number } | undefined
    if (a?.kind === 'hunk') h = { item: a.item, index: a.index }
    else if (a?.abs && typeof b === 'number') h = { item: a as ReviewItem, index: b }
    if (!h) return
    const attr = h.item.attribution
    const msg =
      attr === 'agent'
        ? `Revert this hunk in "${h.item.path}"? This rewrites the file on disk (not undoable from the editor).`
        : `This hunk in "${h.item.path}" is ${attr} — it may be YOUR edit, not opencode's. Hunk revert only applies to verified agent output.`
    const yes = await vscode.window.showWarningMessage(msg, { modal: true }, 'Revert hunk')
    if (yes !== 'Revert hunk') return
    try {
      // Block-precise: only the session that WROTE this hunk gets told (falls back to all writers).
      const targets = new Map([[h.item.abs, await attribution.ownersForHunk(h.item, h.index)]])
      const paths = await controller.revertHunk(h.item, h.index)
      notifyAgent(paths, '回退(revert)其中一个改动块于', targets)
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Hunk revert failed: ${e?.message ?? e}`)
    }
  })

  reg('ocReview.revertRepo', async (node?: Node) => {
    if (!node || (node as any).kind !== 'repo') return
    const r = node as Extract<Node, { kind: 'repo' }>
    const adds = r.items.filter((i) => i.status === 'add' && i.attribution === 'agent').length
    // Disclose files whose edits are NOT verified agent output — a repo revert will
    // overwrite those edits too (only non-adds are overwritten; unattributed adds are kept).
    const risky = r.items.filter((i) => i.status !== 'add' && i.attribution !== 'agent')
    const riskWarn = risky.length
      ? ` ⚠ ${risky.length} file(s) have edits NOT attributed to opencode and those edits will be LOST: ${risky
          .slice(0, 3)
          .map((i) => i.path)
          .join(', ')}${risky.length > 3 ? ', …' : ''}.`
      : ''
    const choice = await vscode.window.showWarningMessage(
      `Revert ENTIRE repo "${r.rel}" to baseline? Modified/deleted files are restored byte-exact.` +
        riskWarn +
        (adds ? ` ${adds} agent-added file(s) can also be deleted.` : ''),
      { modal: true },
      adds ? 'Revert + delete agent-added' : 'Revert',
      ...(adds ? ['Revert (keep added files)'] : []),
    )
    if (!choice) return
    try {
      const targets = new Map<string, string[]>()
      for (const it of r.items) targets.set(it.abs, await attribution.ownersForFile(it))
      const paths = await controller.revertRepo(r.repoRoot, choice === 'Revert + delete agent-added')
      notifyAgent(paths, '整仓库回退(revert)', targets)
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Repo revert failed: ${e?.message ?? e}`)
    }
  })

  reg('ocReview.markReviewed', (node?: Node) => {
    const item = itemOf(node)
    if (item) controller.toggleReviewed(item)
  })

  // Batch rollback: everything in every repo back to the current review baseline.
  const confirmRevertAll = async (): Promise<boolean> => {
    const s = controller.state()
    const risky = s.items.filter((i) => i.status !== 'add' && i.attribution !== 'agent')
    const adds = s.items.filter((i) => i.status === 'add' && i.attribution === 'agent').length
    const msg =
      `把整个工作区回退到基线 ${s.baselineId}?共 ${s.items.length} 个文件的改动将被撤销` +
      (adds ? `,其中 ${adds} 个 agent 新增文件会被删除` : '') +
      `。非 agent 新增的文件会保留。` +
      (risky.length
        ? ` ⚠ ${risky.length} 个文件含未归属为 opencode 的改动,也会被覆盖: ${risky.slice(0, 3).map((i) => i.path).join(', ')}${risky.length > 3 ? ', …' : ''}`
        : '')
    const yes = await vscode.window.showWarningMessage(msg, { modal: true }, '全部回退')
    return yes === '全部回退'
  }

  reg('ocReview.revertAll', async () => {
    await controller.refresh()
    if (controller.state().items.length === 0) {
      void vscode.window.showInformationMessage('OC Review: 没有可回退的改动。')
      return
    }
    if (!(await confirmRevertAll())) return
    try {
      const targets = new Map<string, string[]>()
      for (const it of controller.state().items) targets.set(it.abs, await attribution.ownersForFile(it))
      const paths = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'OC Review: 批量回退中…' },
        () => controller.revertAll(),
      )
      notifyAgent(paths, '批量回退(revert)', targets)
    } catch (e: any) {
      void vscode.window.showErrorMessage(`批量回退失败: ${e?.message ?? e}`)
    }
  })

  reg('ocReview.undoRevert', async () => {
    const r = await controller.undoRevert()
    if (!r) {
      void vscode.window.showInformationMessage('OC Review: 没有可撤销的回退操作。')
      return
    }
    notifyAgent(r.paths, `撤销了此前的回退(undo「${r.label}」),恢复到回退前的内容,涉及`)
    void vscode.window.setStatusBarMessage(`OC Review: 已撤销「${r.label}」`, 3000)
  })

  reg('ocReview.redoRevert', async () => {
    const r = await controller.redoRevert()
    if (!r) {
      void vscode.window.showInformationMessage('OC Review: 没有可重做的回退操作。')
      return
    }
    notifyAgent(r.paths, `重做了回退(redo「${r.label}」),涉及`)
    void vscode.window.setStatusBarMessage(`OC Review: 已重做「${r.label}」`, 3000)
  })

  reg('ocReview.clearAskThreads', async () => {
    const yes = await vscode.window.showWarningMessage('清除所有「问 opencode」线程记录?', { modal: true }, '清除')
    if (yes === '清除') askThreads.clearAll()
  })

  // Baseline history: pick one -> view cumulative diff since it, or revert workspace to it.
  reg('ocReview.baselines', async () => {
    const s = controller.state()
    const hist = controller.history()
    const items: (vscode.QuickPickItem & { id?: string })[] = [
      ...(s.baselineId
        ? [{ label: `$(circle-filled) ${new Date(s.baselineAt ?? 0).toLocaleString()}`, description: `${s.baselineId} · 当前审查基线`, id: undefined }]
        : []),
      ...hist.map((b) => ({
        label: `$(history) ${new Date(b.at).toLocaleString()}`,
        description: `${b.id} · ${b.refs.length} repo(s)`,
        id: b.id,
      })),
    ]
    if (items.length === 0) {
      void vscode.window.showInformationMessage('OC Review: 还没有任何基线。')
      return
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '基线历史 — 选一个基线' })
    if (!picked || !picked.id) return
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(eye) 设为审查基线', detail: '不动磁盘 — 变更列表切换为「自该基线以来的累计改动」,可逐项审查或再批量回退', act: 'switch' },
        { label: '$(discard) 回退工作区到此基线', detail: '先切换审查基线,再把所有仓库批量恢复到该基线内容(有确认)', act: 'revert' },
      ] as (vscode.QuickPickItem & { act: string })[],
      { placeHolder: `对基线 ${picked.id} 做什么?` },
    )
    if (!action) return
    await controller.switchBaseline(picked.id)
    if (action.act === 'revert') {
      if (!(await confirmRevertAll())) return
      try {
        const targets = new Map<string, string[]>()
        for (const it of controller.state().items) targets.set(it.abs, await attribution.ownersForFile(it))
        const paths = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'OC Review: 回退到历史基线…' },
          () => controller.revertAll(),
        )
        notifyAgent(paths, '回退(revert)到历史基线,涉及', targets)
      } catch (e: any) {
        void vscode.window.showErrorMessage(`回退失败: ${e?.message ?? e}`)
      }
    }
  })

  reg('ocReview.gotoHunk', (abs: string, line: number) => gotoStop({ abs, line }))
  reg('ocReview.nextChange', () => nextChange(controller, 1))
  reg('ocReview.prevChange', () => nextChange(controller, -1))

  reg('ocReview.toggleInline', () => {
    const on = marks.toggle()
    void vscode.window.setStatusBarMessage(`OC Review inline marks: ${on ? 'on' : 'off'}`, 2000)
  })

  reg('ocReview.quickAsk', () => askThreads.openAtSelection())
  reg('ocReview.askSubmit', (reply: vscode.CommentReply) => askThreads.submit(reply))

  reg('ocReview.adoptRepo', async (node?: any) => {
    const repoRoot: string | undefined = node?.repoRoot
    if (!repoRoot) return
    const rel: string = node?.rel ?? repoRoot
    const msg = node?.agentCreated
      ? `仓库 "${rel}" 是 agent 在基线之后创建的。采纳=接受它当前的全部内容为基线(采纳前的内容无法回滚)。继续?`
      : `把新仓库 "${rel}" 以当前内容纳入基线?(之后的改动才可审查/回滚)`
    const yes = await vscode.window.showWarningMessage(msg, { modal: true }, '纳入基线')
    if (yes !== '纳入基线') return
    try {
      await controller.adoptRepo(repoRoot)
    } catch (e: any) {
      void vscode.window.showErrorMessage(`采纳失败: ${e?.message ?? e}`)
    }
  })

  reg('ocReview.explainPath', async () => {
    const ed = vscode.window.activeTextEditor
    const abs = ed?.document.uri.scheme === 'file' ? ed.document.uri.fsPath : undefined
    if (!abs) {
      void vscode.window.showInformationMessage('OC Review: 先打开一个文件再运行 Explain Path。')
      return
    }
    try {
      await controller.ensureRepos()
      const x = await controller.explainPath(abs)
      const lines = [`路径: ${abs}`]
      if (!x.owned) lines.push('❌ 不属于任何已发现的 git 仓库(不在审查范围内)')
      else {
        lines.push(`所属仓库: ${x.repoRoot}(相对路径 ${x.rel})`)
        if (x.underNestedChild) lines.push(`⚠ 位于嵌套子仓库 "${x.underNestedChild}" 内 — 由那个仓库负责,不算此仓库的改动`)
        if (x.ignored) lines.push(`⚠ 被 .gitignore 忽略 → 引擎不会跟踪它: ${x.ignored}`)
        lines.push(x.repoHasBaseline ? '仓库有基线 ✓' : '⚠ 该仓库没有基线(基线之后才出现?) → 改动不可见,树里应有“新仓库”警告,点击采纳')
        if (x.inBaseline !== undefined) lines.push(x.inBaseline ? '文件存在于基线中(改动会显示为 mod/del)' : '文件不在基线中(改动会显示为 add)')
      }
      const item = controller.itemFor(abs)
      lines.push(item ? `当前变更列表: 有(${item.status}, ${item.attribution})` : '当前变更列表: 无')
      log.show()
      log.info('--- explain path ---')
      for (const l of lines) log.info(l)
      void vscode.window.showInformationMessage(lines.join('\n'), { modal: true })
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Explain Path 失败: ${e?.message ?? e}`)
    }
  })

  reg('ocReview.diagnose', async () => {
    log.show()
    log.info('--- diagnose ---')
    log.info(`workspace: ${workspaceRoot}`)
    log.info(`shadowDir: ${shadowDir}`)
    try {
      log.info(`engine: ${await engine.ping()}`)
      const repos = await controller.ensureRepos()
      log.info(`repos (${repos.length}):`)
      for (const r of repos) log.info(`  ${r.relToWorkspace}${r.nestedChildren.length ? `  [nested: ${r.nestedChildren.join(', ')}]` : ''}`)
    } catch (e: any) {
      log.error(`engine check failed: ${e?.message ?? e}`)
    }
    log.info(`server: ${client ? `${client.info.baseUrl} (connected=${client.connected})` : 'NOT CONNECTED'}`)
    if (client) {
      try {
        const sessions = await client.listSessions()
        log.info(`sessions: ${sessions.length}; latest: ${sessions[0]?.title ?? sessions[0]?.id ?? 'n/a'}`)
      } catch (e: any) {
        log.error(`session list failed: ${e?.message ?? e}`)
      }
    }
    const s = controller.state()
    log.info(`baseline: ${s.baselineId ?? 'none'}; pending changes: ${s.items.length}; agentWrites: ${agentWrites.size}`)
    log.info('--- end diagnose ---')
  })

  // ---- filesystem fallback ----
  // When opencode work happens on a server we are NOT connected to (e.g. a standalone TUI
  // with its own port), no SSE events arrive. A workspace watcher keeps the change list
  // fresh anyway — degraded mode is then: manual "Checkpoint Now" before the task,
  // automatic refresh after (attribution shows "unverified", which is accurate).
  const watcher = vscode.workspace.createFileSystemWatcher('**/*')
  const onFs = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return
    const p = uri.fsPath
    if (p.includes(`${path.sep}.git${path.sep}`) || p.endsWith(`${path.sep}.git`)) return
    if (p.includes(`${path.sep}node_modules${path.sep}`)) return
    if (!controller.hasBaseline()) return
    controller.scheduleRefresh(2000)
  }
  watcher.onDidChange(onFs)
  watcher.onDidCreate(onFs)
  watcher.onDidDelete(onFs)
  ctx.subscriptions.push(watcher)

  // ---- startup ----
  renderStatus()
  void connect(false)
  if (controller.hasBaseline()) void controller.refresh()
  log.info('OC Review activated')
}

export function deactivate(): void {
  client?.dispose()
}
