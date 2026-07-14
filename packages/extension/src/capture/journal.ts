import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  PROTOCOL_VERSION,
  normalizedRealPath,
  pathsOverlap,
  reviewDataRoot,
  stableReviewKey,
  type CapturedPath,
  type ConflictCapture,
  type InstanceMeta,
  type JournalRecord,
  type ReviewAck,
  type SnapshotRef,
  type ToolBeginRecord,
} from '../../../protocol/src/index.ts'
import type { Log } from '../log.ts'
import { materializeChange, readSnapshotText, sameCapturedSnapshot, type MaterializedChange } from './diff.ts'

export type JournalGap = {
  instanceRoot: string
  epochID: string
  sessionID: string
  callID: string
  reason: string
  command?: string
}

type ParsedInstance = {
  root: string
  meta: InstanceMeta
  acknowledged: Set<string>
  records: JournalRecord[]
}

type Aggregate = {
  abs: string
  repoRoot: string
  relativePath: string
  before: SnapshotRef
  after: SnapshotRef
  blobs: string
  epochIDs: Set<string>
  sessionIDs: Set<string>
  tools: Set<string>
  instanceRoots: Set<string>
  firstAt: number
  lastAt: number
  segments: { before: SnapshotRef; after: SnapshotRef; firstAt: number; lastAt: number }[]
  conflict?: ConflictCapture
}

async function mapLimit<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await map(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

export class JournalCaptureStore implements vscode.Disposable {
  private itemsValue: MaterializedChange[] = []
  private gapsValue: JournalGap[] = []
  private closedEpochsValue = new Set<string>()
  private mutationEpochsValue = new Set<string>()
  private instances = new Map<string, ParsedInstance>()
  private timer: NodeJS.Timeout | undefined
  private refreshing: Promise<void> | undefined
  private forceRequested = false
  private stateSignature = ''
  private readonly journalCache = new Map<string, { size: number; mtimeMs: number; ino: number; records: JournalRecord[]; tail: string }>()
  private readonly materializedCache = new Map<string, { signature: string; item: MaterializedChange | undefined }>()
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.emitter.event

  constructor(
    readonly workspaceRoot: string,
    private readonly log: Log,
  ) {}

  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), 1000)
  }

  items(): MaterializedChange[] {
    return this.itemsValue
  }

  gaps(): JournalGap[] {
    return this.gapsValue
  }

  closedEpochs(): Set<string> {
    return new Set(this.closedEpochsValue)
  }

  mutationEpochs(): Set<string> {
    return new Set(this.mutationEpochsValue)
  }

  matchedInstances(): InstanceMeta[] {
    return [...this.instances.values()].map((item) => item.meta)
  }

  refresh(force = false): Promise<void> {
    this.forceRequested ||= force
    if (this.refreshing) {
      return this.refreshing.then(() => {
        if (!this.forceRequested) return
        const queuedForce = this.forceRequested
        this.forceRequested = false
        return this.refresh(queuedForce)
      })
    }
    const runForced = this.forceRequested
    this.forceRequested = false
    this.refreshing = this.doRefresh(runForced).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async doRefresh(force: boolean): Promise<void> {
    const started = Date.now()
    const parsed = this.readInstances()
    const aggregates = new Map<string, Aggregate>()
    const gaps: JournalGap[] = []
    const closedEpochs = new Set<string>()
    const mutationEpochs = new Set<string>()

    for (const instance of parsed.values()) {
      const begins = new Map<string, ToolBeginRecord>()
      const conflicts = new Map<string, ConflictCapture>()
      for (const record of instance.records) {
        if (instance.acknowledged.has((record as any).epochID)) continue
        if (record.type === 'epoch.closed') {
          closedEpochs.add(record.epochID)
          continue
        }
        if (record.type === 'tool.begin') {
          begins.set(record.callID, record)
          continue
        }
        if (record.type === 'coverage.gap') {
          mutationEpochs.add(record.epochID)
          gaps.push({
            instanceRoot: instance.root,
            epochID: record.epochID,
            sessionID: record.sessionID,
            callID: record.callID,
            reason: record.reason,
            command: record.command,
          })
          continue
        }
        if (record.type !== 'tool.end' || !record.changed) continue
        mutationEpochs.add(record.epochID)
        for (const conflict of record.conflicts ?? []) conflicts.set(conflict.path, conflict)
        const begin = begins.get(record.callID)
        const before = record.beforeCaptures ?? begin?.captures ?? []
        const beginAt = begin?.at ?? record.at
        const beforeByPath = new Map(before.map((item) => [normalizedRealPath(item.path), item]))
        for (const after of record.captures) {
          if (!pathsOverlap(after.path, this.workspaceRoot)) continue
          const key = normalizedRealPath(after.path)
          const first = beforeByPath.get(key)
          if (!first) continue
          const aggregate = aggregates.get(key)
          if (aggregate) {
            aggregate.segments.push({ before: first.snapshot, after: after.snapshot, firstAt: beginAt, lastAt: record.at })
            if (beginAt < aggregate.firstAt) {
              aggregate.before = first.snapshot
              aggregate.firstAt = beginAt
            }
            if (record.at >= aggregate.lastAt) {
              aggregate.after = after.snapshot
              aggregate.repoRoot = after.repoRoot
              aggregate.relativePath = after.relativePath
              aggregate.lastAt = record.at
              aggregate.conflict = conflicts.get(after.path) ?? aggregate.conflict
            }
            aggregate.epochIDs.add(record.epochID)
            aggregate.sessionIDs.add(record.sessionID)
            aggregate.tools.add(record.tool)
            aggregate.instanceRoots.add(instance.root)
          } else {
            aggregates.set(key, {
              abs: after.path,
              repoRoot: after.repoRoot,
              relativePath: after.relativePath,
              before: first.snapshot,
              after: after.snapshot,
              blobs: instance.meta.blobs,
              epochIDs: new Set([record.epochID]),
              sessionIDs: new Set([record.sessionID]),
              tools: new Set([record.tool]),
              instanceRoots: new Set([instance.root]),
              firstAt: beginAt,
              lastAt: record.at,
              segments: [{ before: first.snapshot, after: after.snapshot, firstAt: beginAt, lastAt: record.at }],
              conflict: conflicts.get(after.path),
            })
          }
        }
      }
    }

    const activeKeys = new Set(aggregates.keys())
    for (const key of this.materializedCache.keys()) {
      if (!activeKeys.has(key)) this.materializedCache.delete(key)
    }
    const materialized = await mapLimit(
      [...aggregates.values()],
      4,
      async (item) => {
        const epochIDs = [...item.epochIDs].sort()
        const segments = [...item.segments].sort((left, right) => left.firstAt - right.firstAt || left.lastAt - right.lastAt)
        const interveningCoTouch = segments.some((segment, index) =>
          index > 0 && !sameCapturedSnapshot(segments[index - 1].after, segment.before),
        )
        const reviewKey = stableReviewKey({
          epochID: epochIDs.join(','),
          path: item.abs,
          before: item.before.hash ?? item.before.kind,
          after: `${item.after.hash ?? item.after.kind}:${interveningCoTouch ? 'co-touched' : 'continuous'}`,
        })
        const disk = this.diskFingerprint(item.abs)
        const signature = stableReviewKey({
          epochID: epochIDs.join(','),
          path: item.abs,
          before: `${item.before.kind}:${item.before.hash ?? item.before.size ?? '-'}`,
          after: `${item.after.kind}:${item.after.hash ?? item.after.size ?? '-'}:${disk}:${interveningCoTouch}`,
        })
        const cacheKey = normalizedRealPath(item.abs)
        const cached = this.materializedCache.get(cacheKey)
        if (!force && cached?.signature === signature) return cached.item
        const value = await materializeChange({
          abs: item.abs,
          repoRoot: item.repoRoot,
          relativePath: item.relativePath,
          before: item.before,
          recordedAfter: item.after,
          blobs: item.blobs,
          epochIDs,
          sessionIDs: [...item.sessionIDs],
          tools: [...item.tools],
          reviewKey,
          instanceRoots: [...item.instanceRoots],
          interveningCoTouch,
          conflict: item.conflict
            ? { base: item.conflict.base, ours: item.conflict.ours, theirs: item.conflict.theirs, blobs: item.blobs }
            : undefined,
        })
        this.materializedCache.set(cacheKey, { signature, item: value })
        return value
      },
    )
    this.instances = parsed
    this.itemsValue = materialized.filter((item): item is MaterializedChange => item !== undefined)
    this.gapsValue = gaps
    this.closedEpochsValue = closedEpochs
    this.mutationEpochsValue = mutationEpochs
    const nextSignature = JSON.stringify({
      items: this.itemsValue.map((item) => [item.reviewKey, item.coTouchedByUser]),
      gaps: gaps.map((gap) => [gap.epochID, gap.reason, gap.command]),
      closed: [...closedEpochs].sort(),
      mutations: [...mutationEpochs].sort(),
      instances: [...parsed.keys()].sort(),
    })
    if (force || nextSignature !== this.stateSignature) {
      this.stateSignature = nextSignature
      this.emitter.fire()
    }
    if (this.itemsValue.length || gaps.length) {
      this.log.debug(`journal refresh ${Date.now() - started}ms: ${this.itemsValue.length} files, ${gaps.length} gaps`)
    }
  }

  private readInstances(): Map<string, ParsedInstance> {
    const out = new Map<string, ParsedInstance>()
    const root = path.join(reviewDataRoot(), 'instances')
    let names: string[] = []
    try {
      names = fs.readdirSync(root)
    } catch {
      return out
    }
    for (const name of names) {
      const instanceRoot = path.join(root, name)
      let meta: InstanceMeta
      try {
        meta = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'instance.json'), 'utf8'))
      } catch {
        continue
      }
      if (meta.v !== PROTOCOL_VERSION || !pathsOverlap(meta.directory, this.workspaceRoot)) continue
      let ack: ReviewAck | undefined
      try {
        ack = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'review-ack.json'), 'utf8'))
      } catch {}
      const acknowledged = new Set(ack?.acknowledgedEpochs ?? [])
      const records = this.readJournal(meta.journal)
      out.set(instanceRoot, { root: instanceRoot, meta, acknowledged, records })
    }
    return out
  }

  private readJournal(file: string): JournalRecord[] {
    let size: number
    let mtimeMs: number
    let ino: number
    try {
      const stat = fs.statSync(file)
      size = stat.size
      mtimeMs = stat.mtimeMs
      ino = stat.ino
    } catch {
      return []
    }
    const cached = this.journalCache.get(file)
    if (cached?.size === size && cached.mtimeMs === mtimeMs && cached.ino === ino) return cached.records
    let records: JournalRecord[] = []
    let text = ''
    let tail = ''
    try {
      if (cached && cached.ino === ino && size > cached.size) {
        const length = size - cached.size
        const buffer = Buffer.allocUnsafe(length)
        const fd = fs.openSync(file, 'r')
        try {
          fs.readSync(fd, buffer, 0, length, cached.size)
        } finally {
          fs.closeSync(fd)
        }
        records = [...cached.records]
        text = cached.tail + buffer.toString('utf8')
      } else {
        text = fs.readFileSync(file, 'utf8')
      }
      const lines = text.split('\n')
      if (!text.endsWith('\n')) tail = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        try {
          const record = JSON.parse(line) as JournalRecord
          if (record.v === PROTOCOL_VERSION) records.push(record)
        } catch {
          this.log.warn(`ignored malformed journal line in ${file}`)
        }
      }
    } catch {
      return cached?.records ?? []
    }
    this.journalCache.set(file, { size, mtimeMs, ino, records, tail })
    return records
  }

  private diskFingerprint(file: string): string {
    try {
      const stat = fs.lstatSync(file)
      return `${stat.size}:${stat.mtimeMs}:${stat.mode}:${stat.isSymbolicLink() ? fs.readlinkSync(file) : ''}`
    } catch {
      return 'missing'
    }
  }

  async acknowledge(epochIDs: string[]): Promise<void> {
    const wanted = new Set(epochIDs)
    for (const instance of this.instances.values()) {
      const local = new Set(instance.acknowledged)
      try {
        const current = JSON.parse(fs.readFileSync(path.join(instance.root, 'review-ack.json'), 'utf8')) as ReviewAck
        for (const epochID of current.acknowledgedEpochs ?? []) local.add(epochID)
      } catch {}
      for (const record of instance.records) {
        const epochID = (record as any).epochID
        if (typeof epochID === 'string' && wanted.has(epochID)) local.add(epochID)
      }
      instance.acknowledged = local
      this.atomicJson(path.join(instance.root, 'review-ack.json'), {
        v: PROTOCOL_VERSION,
        updatedAt: Date.now(),
        heartbeatAt: Date.now(),
        acknowledgedEpochs: [...local],
      } satisfies ReviewAck)
    }
    await this.refresh(true)
  }

  baselineContent(item: MaterializedChange): { exists: boolean; binary?: boolean; text?: string } {
    const root = item.instanceRoots[0]
    const meta = this.instances.get(root)?.meta
    if (!meta) return { exists: false }
    return readSnapshotText(item.beforeSnapshot, meta.blobs)
  }

  conflictContent(
    item: MaterializedChange,
    side: 'base' | 'ours' | 'theirs',
  ): { exists: boolean; binary?: boolean; text?: string } {
    const ref = item.conflict?.[side]
    if (!ref || !item.conflict) return { exists: false }
    return readSnapshotText(ref, item.conflict.blobs)
  }

  restoreFile(item: MaterializedChange): void {
    const root = item.instanceRoots[0]
    const meta = this.instances.get(root)?.meta
    if (!meta) throw new Error('journal instance is unavailable')
    const before = item.beforeSnapshot
    if (before.kind === 'missing') {
      fs.rmSync(item.abs, { force: true })
      return
    }
    if (!before.hash) throw new Error(`cannot restore ${before.kind} snapshot`)
    const data = fs.readFileSync(path.join(meta.blobs, before.hash))
    fs.mkdirSync(path.dirname(item.abs), { recursive: true })
    if (before.kind === 'symlink') {
      try {
        const current = fs.lstatSync(item.abs)
        if (current.isDirectory() && !current.isSymbolicLink()) throw new Error(`refusing to replace directory: ${item.abs}`)
        fs.rmSync(item.abs, { force: true })
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
      fs.symlinkSync(data.toString('utf8'), item.abs)
    } else {
      try {
        const current = fs.lstatSync(item.abs)
        if (current.isDirectory() && !current.isSymbolicLink()) throw new Error(`refusing to replace directory: ${item.abs}`)
        if (current.isSymbolicLink()) fs.rmSync(item.abs, { force: true })
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
      fs.writeFileSync(item.abs, data)
      if (before.mode) {
        try { fs.chmodSync(item.abs, before.mode) } catch {}
      }
    }
  }

  private atomicJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.emitter.dispose()
  }
}
