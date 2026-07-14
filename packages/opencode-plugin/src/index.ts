import * as path from 'node:path'
import {
  PROTOCOL_VERSION,
  type CapturedPath,
  type CoverageGapRecord,
  type EpochClosedRecord,
  type RepoTransition,
  type ToolBeginRecord,
  type ToolEndRecord,
} from '../../protocol/src/index.ts'
import { classifyShell } from './shell.ts'
import { CaptureStorage, findRepoRoot, gitBlobsAtPaths, gitDirtyPaths, gitHead, gitTreeChangedPaths } from './storage.ts'

const VERSION = '0.12.0'
const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const FILE_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit'])
const READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'list', 'lsp', 'webfetch', 'websearch', 'codesearch',
  'question', 'skill', 'task', 'todoread', 'todowrite', 'invalid',
])

type CallState = {
  epochID: string
  sessionID: string
  callID: string
  tool: string
  paths: string[]
  before: CapturedPath[]
  risk: 'exact' | 'git' | 'unknown'
  command?: string
  repoTransitions?: RepoTransition[]
  gap?: string
}

type EpochState = {
  id: string
  sessionID: string
  changed: boolean
  gaps: number
}

function patchPaths(text: string): string[] {
  const out: string[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/)
    if (match) out.push(match[1].trim())
    const move = line.match(/^\*\*\* Move to:\s*(.+)$/)
    if (move) out.push(move[1].trim())
  }
  return [...new Set(out)]
}

function directPaths(tool: string, args: any): string[] {
  const one = args?.filePath ?? args?.file_path ?? args?.path
  const out = typeof one === 'string' && one ? [one] : []
  if (tool === 'patch' || tool === 'apply_patch') {
    const text = args?.patchText ?? args?.patch ?? ''
    if (typeof text === 'string') out.push(...patchPaths(text))
  }
  if (Array.isArray(args?.edits)) {
    for (const edit of args.edits) {
      const p = edit?.filePath ?? edit?.file_path ?? edit?.path
      if (typeof p === 'string' && p) out.push(p)
    }
  }
  return [...new Set(out)]
}

function sameSnapshot(a: CapturedPath | undefined, b: CapturedPath | undefined): boolean {
  if (!a || !b) return false
  if (a.snapshot.kind !== b.snapshot.kind) return false
  if (a.snapshot.kind === 'missing') return true
  if (a.snapshot.hash && b.snapshot.hash) {
    const sameMode = a.snapshot.mode === undefined || b.snapshot.mode === undefined || a.snapshot.mode === b.snapshot.mode
    return a.snapshot.hash === b.snapshot.hash && sameMode
  }
  // Oversized/unreadable captures have no content hash. Treat a touched path as changed;
  // otherwise a same-size rewrite would disappear from the review journal.
  return false
}

function captureGap(captures: CapturedPath[]): string | undefined {
  const problem = captures.find((item) => item.snapshot.kind === 'oversized' || item.snapshot.kind === 'unreadable')
  if (!problem) return undefined
  return `${problem.relativePath} could not be captured exactly (${problem.snapshot.kind})`
}

export const OpencodeReviewPlugin = async (ctx: any) => {
  const directory = path.resolve(String(ctx.directory ?? ctx.worktree ?? process.cwd()))
  const worktree = path.resolve(String(ctx.worktree ?? directory))
  const storage = new CaptureStorage(directory, worktree, VERSION)
  const calls = new Map<string, CallState>()
  const epochs = new Map<string, EpochState>()

  const recordBase = () => ({
    v: PROTOCOL_VERSION,
    at: Date.now(),
    instanceID: storage.instanceID,
    directory,
  }) as const

  const startupPending = storage.pruneAcknowledged()
  const recovered = storage.openMutationEpochs()
  if (recovered.length) {
    const pending = startupPending
    for (const epoch of recovered) {
      for (const incomplete of epoch.incomplete) {
        let reason = 'tool execution ended without an after hook; write coverage is unknown'
        if (incomplete.risk === 'exact' && incomplete.captures.length > 0) {
          const after = incomplete.captures.map((capture) => storage.capture(capture.path))
          const changed = after.some((item) =>
            !sameSnapshot(incomplete.captures.find((before) => before.path === item.path), item),
          )
          epoch.changed ||= changed
          storage.append({
            ...recordBase(),
            type: 'tool.end',
            epochID: epoch.id,
            sessionID: epoch.sessionID,
            callID: incomplete.callID,
            tool: incomplete.tool,
            captures: after,
            changed,
          } satisfies ToolEndRecord)
          const problem = captureGap([...incomplete.captures, ...after])
          if (!problem) continue
          reason = problem
        }
        epoch.gaps += 1
        storage.append({
          ...recordBase(),
          type: 'coverage.gap',
          epochID: epoch.id,
          sessionID: epoch.sessionID,
          callID: incomplete.callID,
          tool: incomplete.tool,
          reason,
          command: incomplete.command,
        } satisfies CoverageGapRecord)
      }
      if (!epoch.changed && epoch.gaps === 0) {
        storage.discardEpoch(epoch.id)
        continue
      }
      const closedAt = Date.now()
      storage.append({
        ...recordBase(),
        type: 'epoch.closed',
        epochID: epoch.id,
        sessionID: epoch.sessionID,
        changed: epoch.changed,
        gaps: epoch.gaps,
      } satisfies EpochClosedRecord)
      if (!pending.epochs.some((item) => item.id === epoch.id)) {
        pending.epochs.push({
          id: epoch.id,
          sessionID: epoch.sessionID,
          changed: epoch.changed,
          gaps: epoch.gaps,
          closedAt,
        })
      }
    }
    pending.updatedAt = Date.now()
    storage.writePending(pending)
  }

  const epochFor = (sessionID: string): EpochState => {
    const current = epochs.get(sessionID)
    if (current) return current
    const created = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, sessionID, changed: false, gaps: 0 }
    epochs.set(sessionID, created)
    return created
  }

  const assertReviewed = (sessionID: string): void => {
    if (!storage.config().enforceReview) return
    const pending = storage.pruneAcknowledged().epochs.filter((item) => item.sessionID === sessionID && (item.changed || item.gaps > 0))
    if (pending.length === 0) return
    throw new Error(
      `[oc-review] ${pending.length} previous mutation epoch(s) still require VS Code review. ` +
        `Open OC Review, review every changed hunk, then run "Accept Reviewed Epoch".`,
    )
  }

  const begin = (input: any, output: any): void => {
    const tool = String(input.tool ?? '')
    const sessionID = String(input.sessionID ?? '')
    const callID = String(input.callID ?? `${Date.now()}-${tool}`)
    let paths: string[] = []
    let risk: CallState['risk'] = 'exact'
    let command: string | undefined
    let gap: string | undefined
    let repoTransitions: RepoTransition[] | undefined

    if (FILE_TOOLS.has(tool)) {
      paths = directPaths(tool, output.args)
      if (paths.length === 0) {
        risk = 'unknown'
        gap = `${tool} did not expose a recognizable file path`
      }
    } else if (tool === 'bash' || tool === 'shell') {
      command = String(output.args?.command ?? '')
      const classified = classifyShell(command)
      command = classified.command
      if (classified.kind === 'read-only') return
      if (classified.kind === 'declared') {
        paths = classified.paths
        output.args.command = classified.command
      } else if (classified.kind === 'git-transition') {
        risk = 'git'
        const commandDirectory = (classified.gitDirectories ?? []).reduce(
          (current, next) => path.resolve(current, next),
          directory,
        )
        const repoRoot = findRepoRoot(commandDirectory, worktree)
        if (repoRoot) {
          repoTransitions = [{ repoRoot, beforeHead: gitHead(repoRoot) }]
          const dirty = gitDirtyPaths(repoRoot)
          if (dirty) paths = dirty.map((relativePath) => path.join(repoRoot, relativePath))
          else if (storage.config().shellPolicy === 'strict') {
            throw new Error('[oc-review] Could not inspect pre-transition Git status; refusing in strict mode.')
          } else gap = 'could not inspect pre-transition Git status'
        }
        else gap = 'git transition executed outside a discovered repository'
      } else if (classified.kind === 'mutation') {
        throw new Error(
          `[oc-review] Mutating shell command is not auditable without declared outputs. ` +
            `Retry with a first line like: # oc-review-writes: ["relative/path"]`,
        )
      } else {
        const policy = storage.config().shellPolicy
        if (policy === 'strict') {
          throw new Error(
            `[oc-review] Shell command is not provably read-only. Retry with ` +
              `# oc-review-writes: ["path"] or set shellPolicy to audit/off.`,
          )
        }
        if (policy === 'off') return
        risk = 'unknown'
        gap = classified.reason
      }
    } else if (READ_ONLY_TOOLS.has(tool)) {
      return
    } else {
      const policy = storage.config().shellPolicy
      if (policy === 'strict') {
        throw new Error(
          `[oc-review] Tool "${tool}" has no declared write contract. ` +
            `Add it to the read-only allowlist or set shellPolicy to audit/off.`,
        )
      }
      if (policy === 'off') return
      risk = 'unknown'
      gap = `tool "${tool}" has no declared write contract`
    }

    assertReviewed(sessionID)
    const epoch = epochFor(sessionID)
    const before = paths.map((item) => storage.capture(item))
    gap ??= captureGap(before)
    const state: CallState = { epochID: epoch.id, sessionID, callID, tool, paths, before, risk, command, repoTransitions, gap }
    calls.set(callID, state)
    const record: ToolBeginRecord = {
      ...recordBase(),
      type: 'tool.begin',
      epochID: epoch.id,
      sessionID,
      callID,
      tool,
      captures: before,
      command,
      risk,
      repoTransitions,
    }
    storage.append(record)
    if (gap) {
      epoch.gaps += 1
      const gapRecord: CoverageGapRecord = {
        ...recordBase(),
        type: 'coverage.gap',
        epochID: epoch.id,
        sessionID,
        callID,
        tool,
        reason: gap,
        command,
      }
      storage.append(gapRecord)
    }
  }

  const end = (input: any): void => {
    const callID = String(input.callID ?? '')
    const state = calls.get(callID)
    if (!state) return
    calls.delete(callID)
    let beforeCaptures: CapturedPath[] | undefined
    let after = state.paths.map((item) => storage.capture(item))
    let transitions = state.repoTransitions
    let transitionGap: string | undefined
    const conflicts = [] as ReturnType<CaptureStorage['conflictCaptures']>

    if (state.risk === 'git' && transitions) {
      beforeCaptures = [...state.before]
      after = []
      transitions = transitions.map((transition) => {
        const afterHead = gitHead(transition.repoRoot)
        const dirty = gitDirtyPaths(transition.repoRoot)
        if (!dirty) transitionGap = 'could not inspect post-transition Git status'
        const changedPaths = new Set(dirty ?? [])
        for (const capture of state.before) {
          if (path.resolve(capture.repoRoot) === path.resolve(transition.repoRoot)) {
            changedPaths.add(capture.relativePath)
          }
        }
        if (afterHead && transition.beforeHead !== afterHead) {
          const treePaths = gitTreeChangedPaths(
            transition.repoRoot,
            transition.beforeHead ?? EMPTY_GIT_TREE,
            afterHead,
          )
          if (!treePaths) transitionGap = 'could not enumerate commit-tree changes'
          else for (const rel of treePaths) changedPaths.add(rel)
        }
        const missingBaselinePaths = [...changedPaths].filter((rel) => {
          const abs = path.join(transition.repoRoot, rel)
          return !beforeCaptures!.some((item) => path.resolve(item.path) === path.resolve(abs))
        })
        const treeBaselines = transition.beforeHead
          ? gitBlobsAtPaths(storage, transition.repoRoot, transition.beforeHead, missingBaselinePaths)
          : missingBaselinePaths.map((rel) => ({
              path: path.join(transition.repoRoot, rel),
              repoRoot: transition.repoRoot,
              relativePath: rel,
              snapshot: { kind: 'missing' as const },
            }))
        if (transition.beforeHead && !treeBaselines) {
          transitionGap = 'could not read pre-transition Git objects'
        }
        const treeBaselineByPath = new Map(
          (treeBaselines ?? []).map((item) => [path.resolve(item.path), item]),
        )
        for (const rel of changedPaths) {
          const abs = path.join(transition.repoRoot, rel)
          if (!beforeCaptures!.some((item) => path.resolve(item.path) === path.resolve(abs))) {
            beforeCaptures!.push(
              treeBaselineByPath.get(path.resolve(abs)) ?? {
                path: abs,
                repoRoot: transition.repoRoot,
                relativePath: rel,
                snapshot: { kind: 'unreadable', error: 'no readable pre-transition Git baseline' },
              },
            )
          }
          after.push(storage.capture(abs))
        }
        conflicts.push(...storage.conflictCaptures(transition.repoRoot))
        for (const conflict of conflicts.filter((item) => item.repoRoot === transition.repoRoot)) {
          if (!beforeCaptures!.some((item) => item.path === conflict.path)) {
            beforeCaptures!.push({
              path: conflict.path,
              repoRoot: conflict.repoRoot,
              relativePath: conflict.relativePath,
              snapshot: conflict.ours ?? { kind: 'missing' },
            })
            after.push(storage.capture(conflict.path))
          }
        }
        return { ...transition, afterHead }
      })
    }

    const baseline = beforeCaptures ?? state.before
    const endGap = state.gap ? undefined : (transitionGap ?? captureGap([...baseline, ...after]))
    if (endGap) {
      const epoch = epochs.get(state.sessionID)
      if (epoch) epoch.gaps += 1
      storage.append({
        ...recordBase(),
        type: 'coverage.gap',
        epochID: state.epochID,
        sessionID: state.sessionID,
        callID,
        tool: state.tool,
        reason: endGap,
        command: state.command,
      } satisfies CoverageGapRecord)
    }
    const changed = after.some((item) => !sameSnapshot(baseline.find((before) => before.path === item.path), item)) || conflicts.length > 0
    const epoch = epochs.get(state.sessionID)
    if (epoch && changed) epoch.changed = true
    const record: ToolEndRecord = {
      ...recordBase(),
      type: 'tool.end',
      epochID: state.epochID,
      sessionID: state.sessionID,
      callID,
      tool: state.tool,
      beforeCaptures,
      captures: after,
      changed,
      repoTransitions: transitions,
      conflicts: conflicts.length ? conflicts : undefined,
    }
    storage.append(record)
  }

  const closeEpoch = (sessionID: string): void => {
    const epoch = epochs.get(sessionID)
    if (!epoch) return
    // OpenCode normally emits tool.execute.after before session idle. Recover here as
    // well so an event-ordering race cannot silently drop an already-applied mutation.
    for (const [callID, call] of [...calls]) {
      if (call.sessionID === sessionID) end({ callID })
    }
    epochs.delete(sessionID)
    const record: EpochClosedRecord = {
      ...recordBase(),
      type: 'epoch.closed',
      epochID: epoch.id,
      sessionID,
      changed: epoch.changed,
      gaps: epoch.gaps,
    }
    storage.append(record)
    if (!epoch.changed && epoch.gaps === 0) {
      storage.discardEpoch(epoch.id)
      return
    }
    const pending = storage.pruneAcknowledged()
    pending.epochs.push({
      id: epoch.id,
      sessionID,
      closedAt: Date.now(),
      changed: epoch.changed,
      gaps: epoch.gaps,
    })
    pending.updatedAt = Date.now()
    storage.writePending(pending)
  }

  return {
    'tool.definition': async (input: any, output: any) => {
      if (input.toolID !== 'bash' && input.toolID !== 'shell') return
      output.description +=
        '\n\nOC Review: when this command can modify files, put a first line ' +
        '`# oc-review-writes: ["path/one", "path/two"]`. Git merge/rebase/cherry-pick/revert/pull are tracked automatically.'
    },
    'tool.execute.before': async (input: any, output: any) => begin(input, output),
    'tool.execute.after': async (input: any) => end(input),
    event: async ({ event }: any) => {
      if (event?.type === 'session.idle') closeEpoch(String(event.properties?.sessionID ?? ''))
      if (event?.type === 'session.status') {
        const status = event.properties?.status?.type ?? event.properties?.status
        if (status === 'idle') closeEpoch(String(event.properties?.sessionID ?? ''))
      }
    },
  }
}
