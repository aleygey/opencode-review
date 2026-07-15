import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  PROTOCOL_VERSION,
  instanceKey,
  instanceStore,
  pathsOverlap,
  reviewDataRoot,
  type CapturedPath,
  type ConflictCapture,
  type InstanceMeta,
  type JournalRecord,
  type PendingState,
  type ReviewAck,
  type SnapshotRef,
} from '../../protocol/src/index.ts'

export type PluginConfig = {
  shellPolicy: 'strict' | 'audit' | 'off'
  maxBlobBytes: number
}

type GitBlobRequest = { oid: string; modeText: string }

export type OpenMutationEpoch = {
  id: string
  sessionID: string
  changed: boolean
  gaps: number
  incomplete: {
    callID: string
    tool: string
    command?: string
    risk: 'exact' | 'git' | 'unknown'
    captures: CapturedPath[]
  }[]
}

const DEFAULT_CONFIG: PluginConfig = {
  shellPolicy: 'audit',
  maxBlobBytes: 20 * 1024 * 1024,
}

export class CaptureStorage {
  readonly instanceID: string
  readonly root: string
  readonly blobs: string
  readonly journal: string
  readonly pendingFile: string
  readonly ackFile: string
  readonly configFile: string
  private configCache: { at: number; value: PluginConfig } | undefined
  private metaWrittenAt = 0

  constructor(
    readonly directory: string,
    readonly worktree: string,
    readonly pluginVersion: string,
  ) {
    this.instanceID = instanceKey(directory)
    this.root = instanceStore(directory)
    // One CAS is shared by all OpenCode instances. The same file can be touched by
    // overlapping workspace instances, so an aggregate may reference snapshots written
    // by different journals.
    this.blobs = path.join(reviewDataRoot(), 'blobs')
    this.journal = path.join(this.root, 'journal.jsonl')
    this.pendingFile = path.join(this.root, 'pending.json')
    this.ackFile = path.join(this.root, 'review-ack.json')
    this.configFile = path.join(this.root, 'config.json')
    fs.mkdirSync(this.blobs, { recursive: true })
    this.writeMeta(true)
    this.maybeGc()
  }

  private writeMeta(force = false): void {
    const now = Date.now()
    if (!force && now - this.metaWrittenAt < 1000) return
    this.metaWrittenAt = now
    const meta: InstanceMeta = {
      v: PROTOCOL_VERSION,
      instanceID: this.instanceID,
      directory: path.resolve(this.directory),
      worktree: path.resolve(this.worktree),
      journal: this.journal,
      blobs: this.blobs,
      pluginVersion: this.pluginVersion,
      updatedAt: now,
    }
    this.atomicJson(path.join(this.root, 'instance.json'), meta)
  }

  config(): PluginConfig {
    const now = Date.now()
    if (this.configCache && now - this.configCache.at < 1000) return this.configCache.value
    const read = (file: string): any | undefined => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
    }
    try {
      const local = read(this.configFile)
      const global = read(path.join(reviewDataRoot(), 'defaults.json')) ?? {}
      const workspace = global.workspaces && typeof global.workspaces === 'object'
        ? Object.entries(global.workspaces as Record<string, unknown>)
            .filter(([root]) => pathsOverlap(root, this.directory))
            .sort(([left], [right]) => right.length - left.length)[0]?.[1]
        : undefined
      const raw: any = local ?? workspace ?? global.defaults ?? global
      const value: PluginConfig = {
        shellPolicy: raw.shellPolicy === 'strict' || raw.shellPolicy === 'off' ? raw.shellPolicy : 'audit',
        maxBlobBytes: Number.isFinite(raw.maxBlobBytes) && raw.maxBlobBytes > 0 ? raw.maxBlobBytes : DEFAULT_CONFIG.maxBlobBytes,
      }
      this.configCache = { at: now, value }
      return value
    } catch {
      this.configCache = { at: now, value: DEFAULT_CONFIG }
      return DEFAULT_CONFIG
    }
  }

  append(record: JournalRecord): void {
    fs.appendFileSync(this.journal, JSON.stringify(record) + '\n', 'utf8')
    this.writeMeta()
  }

  capture(inputPath: string): CapturedPath {
    const abs = path.resolve(this.directory, inputPath)
    const repoRoot = findRepoRoot(abs, this.worktree) ?? path.resolve(this.worktree || this.directory)
    const relativePath = path.relative(repoRoot, abs).replace(/\\/g, '/') || '.'
    return { path: abs, repoRoot, relativePath, snapshot: this.snapshotFile(abs) }
  }

  snapshotBuffer(buffer: Buffer, mode?: number): SnapshotRef {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    const target = path.join(this.blobs, hash)
    if (!fs.existsSync(target)) {
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, buffer)
      try {
        fs.renameSync(tmp, target)
      } catch {
        try { fs.rmSync(tmp, { force: true }) } catch {}
        if (!fs.existsSync(target)) throw new Error(`failed to persist snapshot ${hash}`)
      }
    }
    return { kind: 'file', hash, size: buffer.length, mode }
  }

  snapshotFile(abs: string): SnapshotRef {
    try {
      const stat = fs.lstatSync(abs)
      if (stat.isSymbolicLink()) {
        const data = Buffer.from(fs.readlinkSync(abs), 'utf8')
        const snap = this.snapshotBuffer(data)
        return { ...snap, kind: 'symlink' }
      }
      if (!stat.isFile()) return { kind: 'unreadable', error: 'not a regular file' }
      const max = this.config().maxBlobBytes
      const mode = process.platform === 'win32' ? undefined : stat.mode & 0o777
      if (stat.size > max) return { kind: 'oversized', size: stat.size, mode }
      return this.snapshotBuffer(fs.readFileSync(abs), mode)
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'unreadable', error: String(error?.message ?? error).slice(0, 240) }
    }
  }

  snapshotGitBlob(repoRoot: string, oid: string, mode?: number, symlink = false): SnapshotRef | undefined {
    try {
      const data = execFileSync('git', ['cat-file', 'blob', oid], { cwd: repoRoot, maxBuffer: this.config().maxBlobBytes + 1 })
      if (data.length > this.config().maxBlobBytes) return { kind: 'oversized', size: data.length }
      const snapshot = this.snapshotBuffer(data, symlink ? undefined : mode)
      return symlink ? { ...snapshot, kind: 'symlink' } : snapshot
    } catch {
      return undefined
    }
  }

  snapshotGitBlobs(repoRoot: string, requests: GitBlobRequest[]): Map<string, SnapshotRef> {
    const keyOf = (request: GitBlobRequest) => `${request.oid}:${request.modeText}`
    const result = new Map<string, SnapshotRef>()
    const uniqueOids = [...new Set(requests.map((request) => request.oid))]
    if (uniqueOids.length === 0) return result
    const sizes = new Map<string, number>()
    try {
      const check = execFileSync(
        'git',
        ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
        { cwd: repoRoot, input: uniqueOids.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      )
      for (const line of check.trim().split('\n')) {
        const match = line.match(/^([0-9a-f]+) blob (\d+)$/)
        if (match) sizes.set(match[1], Number(match[2]))
      }
    } catch {
      for (const request of requests) result.set(keyOf(request), { kind: 'unreadable', error: 'git cat-file --batch-check failed' })
      return result
    }

    const max = this.config().maxBlobBytes
    const buffers = new Map<string, Buffer>()
    let group: string[] = []
    let groupBytes = 0
    const flush = () => {
      if (group.length === 0) return
      try {
        const output = execFileSync('git', ['cat-file', '--batch'], {
          cwd: repoRoot,
          input: group.join('\n') + '\n',
          maxBuffer: groupBytes + group.length * 256 + 1024 * 1024,
        })
        let offset = 0
        for (const requestedOid of group) {
          const newline = output.indexOf(10, offset)
          if (newline < 0) throw new Error('truncated git cat-file header')
          const header = output.subarray(offset, newline).toString('utf8')
          const match = header.match(/^([0-9a-f]+) blob (\d+)$/)
          if (!match) throw new Error(`unexpected git cat-file header: ${header}`)
          const size = Number(match[2])
          const start = newline + 1
          const end = start + size
          if (end > output.length) throw new Error('truncated git cat-file content')
          buffers.set(requestedOid, output.subarray(start, end))
          offset = end + 1
        }
      } catch {
        // Missing buffers become unreadable refs below; other batches still proceed.
      }
      group = []
      groupBytes = 0
    }
    for (const oid of uniqueOids) {
      const size = sizes.get(oid)
      if (size === undefined || size > max) continue
      if (group.length >= 128 || groupBytes + size > 32 * 1024 * 1024) flush()
      group.push(oid)
      groupBytes += size
    }
    flush()

    for (const request of requests) {
      const size = sizes.get(request.oid)
      const mode = parseInt(request.modeText.slice(-3), 8)
      const symlink = request.modeText === '120000'
      let snapshot: SnapshotRef
      if (size === undefined) snapshot = { kind: 'unreadable', error: `cannot inspect ${request.oid}` }
      else if (size > max) snapshot = { kind: 'oversized', size, mode: symlink ? undefined : mode }
      else {
        const buffer = buffers.get(request.oid)
        if (!buffer) snapshot = { kind: 'unreadable', error: `cannot read ${request.oid}` }
        else {
          const stored = this.snapshotBuffer(buffer, symlink ? undefined : mode)
          snapshot = symlink ? { ...stored, kind: 'symlink' } : stored
        }
      }
      result.set(keyOf(request), snapshot)
    }
    return result
  }

  pending(): PendingState {
    return this.readJson<PendingState>(this.pendingFile) ?? { v: PROTOCOL_VERSION, updatedAt: 0, epochs: [] }
  }

  acknowledged(): ReviewAck {
    return this.readJson<ReviewAck>(this.ackFile) ?? {
      v: PROTOCOL_VERSION,
      updatedAt: 0,
      heartbeatAt: 0,
      acknowledgedEpochs: [],
    }
  }

  writePending(state: PendingState): void {
    this.atomicJson(this.pendingFile, state)
  }

  pruneAcknowledged(): PendingState {
    const state = this.pending()
    const ack = new Set(this.acknowledged().acknowledgedEpochs)
    const epochs = state.epochs.filter((epoch) => !ack.has(epoch.id))
    const next = { ...state, updatedAt: Date.now(), epochs }
    if (epochs.length !== state.epochs.length) this.writePending(next)
    if (ack.size > 0) {
      this.compactJournal(ack)
      this.atomicJson(this.ackFile, {
        v: PROTOCOL_VERSION,
        updatedAt: Date.now(),
        heartbeatAt: Date.now(),
        acknowledgedEpochs: [],
      } satisfies ReviewAck)
    }
    return next
  }

  private compactJournal(acknowledged: Set<string>): void {
    let lines: string[]
    try {
      lines = fs.readFileSync(this.journal, 'utf8').split('\n').filter(Boolean)
    } catch {
      return
    }
    const kept = lines.filter((line) => {
      try {
        const record = JSON.parse(line) as { epochID?: string }
        return !record.epochID || !acknowledged.has(record.epochID)
      } catch {
        return true
      }
    })
    if (kept.length === lines.length) return
    const tmp = `${this.journal}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8')
    fs.renameSync(tmp, this.journal)
  }

  discardEpoch(epochID: string): void {
    this.compactJournal(new Set([epochID]))
  }

  private maybeGc(): void {
    const marker = path.join(reviewDataRoot(), 'gc.json')
    const now = Date.now()
    try {
      const previous = JSON.parse(fs.readFileSync(marker, 'utf8')) as { at?: number }
      if (now - Number(previous.at ?? 0) < 24 * 60 * 60 * 1000) return
    } catch {}
    try {
      this.atomicJson(marker, { at: now })
      const referenced = new Set<string>()
      const instances = path.join(reviewDataRoot(), 'instances')
      for (const name of fs.readdirSync(instances)) {
        const journal = path.join(instances, name, 'journal.jsonl')
        let text = ''
        try { text = fs.readFileSync(journal, 'utf8') } catch { continue }
        for (const hash of text.matchAll(/"hash":"([0-9a-f]{64})"/g)) referenced.add(hash[1])
      }
      const cutoff = now - 7 * 24 * 60 * 60 * 1000
      for (const name of fs.readdirSync(this.blobs)) {
        if (referenced.has(name)) continue
        const file = path.join(this.blobs, name)
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true })
        } catch {}
      }
    } catch {
      // GC is best-effort and never participates in a tool call's correctness.
    }
  }

  conflictCaptures(repoRoot: string): ConflictCapture[] {
    let text: string
    try {
      text = execFileSync('git', ['ls-files', '-u', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    } catch {
      return []
    }
    const byPath = new Map<string, {
      base?: GitBlobRequest
      ours?: GitBlobRequest
      theirs?: GitBlobRequest
    }>()
    const requests: GitBlobRequest[] = []
    for (const item of text.split('\0')) {
      if (!item) continue
      const match = item.match(/^(\d+) ([0-9a-f]+) ([123])\t([\s\S]+)$/)
      if (!match) continue
      const rel = match[4].replace(/\\/g, '/')
      const entry = byPath.get(rel) ?? {}
      const request = { oid: match[2], modeText: match[1] }
      requests.push(request)
      if (match[3] === '1') entry.base = request
      if (match[3] === '2') entry.ours = request
      if (match[3] === '3') entry.theirs = request
      byPath.set(rel, entry)
    }
    const snapshots = this.snapshotGitBlobs(repoRoot, requests)
    const resolve = (request?: GitBlobRequest) => request
      ? snapshots.get(`${request.oid}:${request.modeText}`)
      : undefined
    return [...byPath].map(([relativePath, stages]) => ({
      path: path.join(repoRoot, relativePath),
      repoRoot,
      relativePath,
      base: resolve(stages.base),
      ours: resolve(stages.ours),
      theirs: resolve(stages.theirs),
    }))
  }

  openMutationEpochs(): OpenMutationEpoch[] {
    let records: JournalRecord[]
    try {
      records = fs
        .readFileSync(this.journal, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalRecord)
    } catch {
      return []
    }
    const epochs = new Map<string, OpenMutationEpoch>()
    const closed = new Set<string>()
    const begins = new Map<string, Extract<JournalRecord, { type: 'tool.begin' }>>()
    const ended = new Set<string>()
    const gapped = new Set<string>()
    const ensure = (epochID: string, sessionID: string): OpenMutationEpoch => {
      const epoch = epochs.get(epochID) ?? { id: epochID, sessionID, changed: false, gaps: 0, incomplete: [] }
      epochs.set(epochID, epoch)
      return epoch
    }
    for (const record of records) {
      if (record.type === 'epoch.closed') {
        closed.add(record.epochID)
        continue
      }
      if (record.type === 'tool.begin') {
        begins.set(record.callID, record)
        ensure(record.epochID, record.sessionID)
        continue
      }
      if (record.type === 'tool.end') ended.add(record.callID)
      if (record.type === 'tool.end' && record.changed) {
        const epoch = ensure(record.epochID, record.sessionID)
        epoch.changed = true
      }
      if (record.type === 'coverage.gap') {
        const epoch = ensure(record.epochID, record.sessionID)
        epoch.gaps += 1
        gapped.add(record.callID)
      }
    }
    for (const [callID, begin] of begins) {
      if (ended.has(callID) || gapped.has(callID)) continue
      ensure(begin.epochID, begin.sessionID).incomplete.push({
        callID,
        tool: begin.tool,
        command: begin.command,
        risk: begin.risk,
        captures: begin.captures,
      })
    }
    return [...epochs.values()].filter((epoch) => !closed.has(epoch.id))
  }

  private readJson<T>(file: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T
    } catch {
      return undefined
    }
  }

  private atomicJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
}

export function findRepoRoot(inputPath: string, boundary: string): string | undefined {
  let current = path.resolve(inputPath)
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current)
  } catch {
    current = path.dirname(current)
  }
  const stop = path.resolve(boundary || current)
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    if (current === stop) return undefined
    current = parent
  }
}

export function gitHead(repoRoot: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

export function gitTreeChangedPaths(repoRoot: string, before: string, after: string): string[] | undefined {
  try {
    return execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', before, after, '--'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    }).split('\0').filter(Boolean)
  } catch {
    return undefined
  }
}

export function gitBlobsAtPaths(
  storage: CaptureStorage,
  repoRoot: string,
  commit: string,
  inputPaths: string[],
): CapturedPath[] | undefined {
  const paths = [...new Set(inputPaths.map((item) => item.replace(/\\/g, '/')).filter(Boolean))]
  if (paths.length === 0) return []
  const entries = new Map<string, { oid: string; modeText: string }>()
  try {
    let chunk: string[] = []
    let chunkBytes = 0
    const flush = () => {
      if (chunk.length === 0) return
      const output = execFileSync(
        'git',
        ['ls-tree', '-z', '--full-tree', commit, '--', ...chunk.map((item) => `:(literal)${item}`)],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: Math.max(1024 * 1024, chunkBytes * 4) },
      )
      for (const record of output.split('\0')) {
        if (!record) continue
        const tab = record.indexOf('\t')
        if (tab < 0) continue
        const metadata = record.slice(0, tab).match(/^(\d+) blob ([0-9a-f]+)$/)
        if (!metadata) continue
        entries.set(record.slice(tab + 1).replace(/\\/g, '/'), {
          modeText: metadata[1],
          oid: metadata[2],
        })
      }
      chunk = []
      chunkBytes = 0
    }
    for (const relativePath of paths) {
      const bytes = Buffer.byteLength(relativePath, 'utf8') + 16
      if (chunk.length >= 128 || chunkBytes + bytes > 24 * 1024) flush()
      chunk.push(relativePath)
      chunkBytes += bytes
    }
    flush()
  } catch {
    return undefined
  }

  const requests = [...entries.values()]
  const snapshots = storage.snapshotGitBlobs(repoRoot, requests)
  return paths.map((relativePath) => {
    const entry = entries.get(relativePath)
    const snapshot = entry
      ? snapshots.get(`${entry.oid}:${entry.modeText}`) ?? { kind: 'unreadable' as const, error: `cannot read ${entry.oid}` }
      : { kind: 'missing' as const }
    return {
      path: path.join(repoRoot, relativePath),
      repoRoot,
      relativePath,
      snapshot,
    }
  })
}

export function gitDirtyPaths(repoRoot: string): string[] | undefined {
  try {
    const entries = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=no'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    ).split('\0')
    const paths = new Set<string>()
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (!entry || entry.length < 4) continue
      const status = entry.slice(0, 2)
      paths.add(entry.slice(3).replace(/\\/g, '/'))
      if (/[RC]/.test(status) && entries[index + 1]) {
        paths.add(entries[++index].replace(/\\/g, '/'))
      }
    }
    return [...paths]
  } catch {
    return undefined
  }
}
