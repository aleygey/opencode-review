import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const PROTOCOL_VERSION = 1

export type SnapshotKind = 'file' | 'symlink' | 'missing' | 'oversized' | 'unreadable'

export type SnapshotRef = {
  kind: SnapshotKind
  hash?: string
  size?: number
  mode?: number
  error?: string
}

export type CapturedPath = {
  path: string
  repoRoot: string
  relativePath: string
  snapshot: SnapshotRef
}

export type ConflictCapture = {
  path: string
  repoRoot: string
  relativePath: string
  base?: SnapshotRef
  ours?: SnapshotRef
  theirs?: SnapshotRef
}

export type RepoTransition = {
  repoRoot: string
  beforeHead?: string
  afterHead?: string
}

type JournalBase = {
  v: typeof PROTOCOL_VERSION
  at: number
  instanceID: string
  directory: string
}

export type ToolBeginRecord = JournalBase & {
  type: 'tool.begin'
  epochID: string
  sessionID: string
  callID: string
  tool: string
  captures: CapturedPath[]
  command?: string
  risk: 'exact' | 'git' | 'unknown'
  repoTransitions?: RepoTransition[]
}

export type ToolEndRecord = JournalBase & {
  type: 'tool.end'
  epochID: string
  sessionID: string
  callID: string
  tool: string
  beforeCaptures?: CapturedPath[]
  captures: CapturedPath[]
  changed: boolean
  repoTransitions?: RepoTransition[]
  conflicts?: ConflictCapture[]
}

export type CoverageGapRecord = JournalBase & {
  type: 'coverage.gap'
  epochID: string
  sessionID: string
  callID: string
  tool: string
  reason: string
  command?: string
}

export type EpochClosedRecord = JournalBase & {
  type: 'epoch.closed'
  epochID: string
  sessionID: string
  changed: boolean
  gaps: number
}

export type JournalRecord = ToolBeginRecord | ToolEndRecord | CoverageGapRecord | EpochClosedRecord

export type InstanceMeta = {
  v: typeof PROTOCOL_VERSION
  instanceID: string
  directory: string
  worktree: string
  journal: string
  blobs: string
  pluginVersion: string
  updatedAt: number
}

export type PendingEpoch = {
  id: string
  sessionID: string
  closedAt: number
  changed: boolean
  gaps: number
}

export type PendingState = {
  v: typeof PROTOCOL_VERSION
  updatedAt: number
  epochs: PendingEpoch[]
}

export type ReviewAck = {
  v: typeof PROTOCOL_VERSION
  updatedAt: number
  heartbeatAt: number
  acknowledgedEpochs: string[]
}

export function normalizedRealPath(input: string): string {
  let value = path.resolve(input)
  try {
    value = fs.realpathSync.native(value)
  } catch {
    // A path may be created by the upcoming tool call.
  }
  value = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function instanceKey(directory: string): string {
  return crypto.createHash('sha256').update(normalizedRealPath(directory)).digest('hex').slice(0, 24)
}

export function reviewDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OC_REVIEW_HOME) return path.resolve(env.OC_REVIEW_HOME)
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'opencode-review')
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode-review')
}

export function instanceStore(directory: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(reviewDataRoot(env), 'instances', instanceKey(directory))
}

export function pathsOverlap(a: string, b: string): boolean {
  const left = normalizedRealPath(a)
  const right = normalizedRealPath(b)
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
}

export function stableReviewKey(input: {
  epochID: string
  path: string
  before?: string
  after?: string
}): string {
  return crypto
    .createHash('sha256')
    .update(`${input.epochID}\0${normalizedRealPath(input.path)}\0${input.before ?? '-'}\0${input.after ?? '-'}`)
    .digest('hex')
}
