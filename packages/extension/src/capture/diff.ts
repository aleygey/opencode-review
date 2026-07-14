import { execFile } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { ChangeItem, Hunk } from '../engineClient.ts'
import type { SnapshotRef } from '../../../protocol/src/index.ts'

const execFileAsync = promisify(execFile)

export type MaterializedChange = ChangeItem & {
  abs: string
  epochIDs: string[]
  sessionIDs: string[]
  tools: string[]
  reviewKey: string
  instanceRoots: string[]
  beforeSnapshot: SnapshotRef
  afterSnapshot: SnapshotRef
  beforeBlob?: string
  conflict?: {
    base?: SnapshotRef
    ours?: SnapshotRef
    theirs?: SnapshotRef
    blobs: string
  }
}

export function sameCapturedSnapshot(left: SnapshotRef, right: SnapshotRef): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'missing') return true
  if (!left.hash || !right.hash || left.hash !== right.hash) return false
  return left.mode === undefined || right.mode === undefined || left.mode === right.mode
}

function binary(buffer: Buffer | null): boolean {
  return buffer !== null && buffer.subarray(0, 8000).includes(0)
}

function splitPatch(text: string): { header: string; hunks: Hunk[] } {
  const lines = text.split('\n')
  const hunks: Hunk[] = []
  let i = 0
  while (i < lines.length && !lines[i].startsWith('@@')) i++
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) {
      i++
      continue
    }
    const header = lines[i++]
    const body: string[] = []
    while (i < lines.length && !lines[i].startsWith('@@')) body.push(lines[i++])
    hunks.push({ header, body: body.join('\n'), agentAttributed: true })
  }
  return { header: '', hunks }
}

function patchHeader(rel: string, status: ChangeItem['status']): string {
  const normalized = rel.replace(/\\/g, '/')
  const a = JSON.stringify(`a/${normalized}`)
  const b = JSON.stringify(`b/${normalized}`)
  const lines = [`diff --git ${a} ${b}`]
  if (status === 'add') lines.push('new file mode 100644', '--- /dev/null', `+++ ${b}`)
  else if (status === 'del') lines.push('deleted file mode 100644', `--- ${a}`, '+++ /dev/null')
  else lines.push(`--- ${a}`, `+++ ${b}`)
  return lines.join('\n') + '\n'
}

function snapshotBuffer(ref: SnapshotRef, blobs: string): Buffer | null | undefined {
  if (ref.kind === 'missing') return null
  if (!ref.hash) return undefined
  try {
    return fs.readFileSync(path.join(blobs, ref.hash))
  } catch {
    return undefined
  }
}

function currentContent(abs: string, skipRead: boolean): {
  buffer: Buffer | null | undefined
  exists: boolean
  kind: 'file' | 'symlink' | 'other' | 'missing'
  contentHash?: string
  mode?: number
  fingerprint: string
} {
  try {
    const stat = fs.lstatSync(abs)
    const mode = process.platform === 'win32' ? undefined : stat.mode & 0o777
    if (stat.isSymbolicLink()) {
      const buffer = Buffer.from(fs.readlinkSync(abs), 'utf8')
      const contentHash = hash(buffer)!
      return { buffer, exists: true, kind: 'symlink', contentHash, mode, fingerprint: `${contentHash}:${mode}:symlink` }
    }
    if (!stat.isFile()) {
      return { buffer: undefined, exists: true, kind: 'other', mode, fingerprint: `non-file:${mode}:${stat.mtimeMs}` }
    }
    if (skipRead) {
      return { buffer: undefined, exists: true, kind: 'file', mode, fingerprint: `oversized:${stat.size}:${stat.mtimeMs}:${mode}` }
    }
    const buffer = fs.readFileSync(abs)
    const contentHash = hash(buffer)!
    return { buffer, exists: true, kind: 'file', contentHash, mode, fingerprint: `${contentHash}:${mode}:file` }
  } catch {
    return { buffer: null, exists: false, kind: 'missing', fingerprint: 'missing' }
  }
}

function hash(buffer: Buffer | null): string | undefined {
  return buffer === null ? undefined : crypto.createHash('sha256').update(buffer).digest('hex')
}

export async function materializeChange(input: {
  abs: string
  repoRoot: string
  relativePath: string
  before: SnapshotRef
  recordedAfter: SnapshotRef
  blobs: string
  epochIDs: string[]
  sessionIDs: string[]
  tools: string[]
  reviewKey: string
  instanceRoots: string[]
  interveningCoTouch?: boolean
  conflict?: MaterializedChange['conflict']
}): Promise<MaterializedChange | undefined> {
  const before = snapshotBuffer(input.before, input.blobs)
  const current = currentContent(input.abs, input.recordedAfter.kind === 'oversized')
  const after = current.buffer
  const status: ChangeItem['status'] = input.before.kind === 'missing' ? 'add' : !current.exists ? 'del' : 'mod'
  const modeMatches = input.before.mode === undefined || current.mode === undefined || input.before.mode === current.mode
  if (
    before !== undefined &&
    after !== undefined &&
    modeMatches &&
    input.before.kind === current.kind &&
    Buffer.compare(before ?? Buffer.alloc(0), after ?? Buffer.alloc(0)) === 0
  ) {
    return undefined
  }

  const unavailable = before === undefined || input.before.kind === 'oversized' || input.recordedAfter.kind === 'oversized'
  const isBinary = unavailable || binary(before ?? null) || binary(after ?? null)
  let hunks: Hunk[] = []
  let additions = 0
  let deletions = 0
  const header = patchHeader(input.relativePath, status)

  if (!isBinary) {
    const empty = path.join(path.dirname(input.blobs), 'empty')
    if (!fs.existsSync(empty)) fs.writeFileSync(empty, '')
    const left = before === null ? empty : path.join(input.blobs, input.before.hash!)
    const right = after === null ? empty : input.abs
    let output = ''
    try {
      const result = await execFileAsync(
        'git',
        ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-renames', '--unified=1', '--', left, right],
        { cwd: input.repoRoot, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
      )
      output = result.stdout
    } catch (error: any) {
      if (error?.code !== 1 && error?.status !== 1) throw error
      output = String(error?.stdout ?? '')
    }
    const parsed = splitPatch(output)
    hunks = parsed.hunks
    for (const hunk of hunks) {
      for (const line of hunk.body.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++
        if (line.startsWith('-') && !line.startsWith('---')) deletions++
      }
    }
  }

  return {
    repoRoot: input.repoRoot,
    path: input.relativePath,
    status,
    isBinary,
    hunks,
    patchHeader: header,
    additions,
    deletions,
    modeChange:
      input.before.mode !== undefined && current.mode !== undefined && input.before.mode !== current.mode
        ? {
            from: `100${input.before.mode.toString(8).padStart(3, '0')}`,
            to: `100${current.mode.toString(8).padStart(3, '0')}`,
          }
        : undefined,
    oldOid: input.before.hash,
    newOid: current.contentHash,
    coTouchedByUser:
      Boolean(input.interveningCoTouch) ||
      (input.recordedAfter.kind === 'missing') !== !current.exists ||
      (input.recordedAfter.kind === 'symlink' && current.kind !== 'symlink') ||
      (input.recordedAfter.kind === 'file' && current.kind !== 'file') ||
      (input.recordedAfter.hash !== undefined && input.recordedAfter.hash !== current.contentHash) ||
      (input.recordedAfter.mode !== undefined && current.mode !== undefined && input.recordedAfter.mode !== current.mode) ||
      input.recordedAfter.kind === 'oversized' ||
      input.recordedAfter.kind === 'unreadable',
    abs: input.abs,
    epochIDs: input.epochIDs,
    sessionIDs: input.sessionIDs,
    tools: input.tools,
    reviewKey: crypto.createHash('sha256').update(`${input.reviewKey}\0${current.fingerprint}`).digest('hex'),
    instanceRoots: input.instanceRoots,
    beforeSnapshot: input.before,
    afterSnapshot: input.recordedAfter,
    beforeBlob: input.before.hash ? path.join(input.blobs, input.before.hash) : undefined,
    conflict: input.conflict,
  }
}

export function readSnapshotText(ref: SnapshotRef, blobs: string): { exists: boolean; binary?: boolean; text?: string } {
  const content = snapshotBuffer(ref, blobs)
  if (content === null) return { exists: false }
  if (content === undefined) return { exists: false, binary: true }
  if (binary(content)) return { exists: true, binary: true }
  return { exists: true, binary: false, text: content.toString('utf8') }
}
