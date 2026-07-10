// Async facade over the forked engine worker (dist/engineHost.js).
import * as cp from 'node:child_process'
import * as path from 'node:path'
import type { Log } from './log.ts'

export type RepoInfo = { repoRoot: string; relToWorkspace: string; nestedChildren: string[] }
export type CheckpointRef = { repoRoot: string; commit: string; ref: string; hadHead: boolean }
export type Hunk = { header: string; body: string; agentAttributed: boolean }
export type ChangeStatus = 'add' | 'mod' | 'del' | 'rename'
export type ChangeItem = {
  repoRoot: string
  path: string
  oldPath?: string
  status: ChangeStatus
  isBinary: boolean
  modeChange?: { from: string; to: string }
  hunks: Hunk[]
  patchHeader: string
  coTouchedByUser?: boolean
}
export type BlobContent = { exists: boolean; binary?: boolean; text?: string }

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

export class EngineClient {
  private child: cp.ChildProcess | undefined
  private next = 1
  private pending = new Map<number, Pending>()

  constructor(
    private readonly hostJs: string,
    private readonly log: Log,
  ) {}

  private ensure(): cp.ChildProcess {
    if (this.child && this.child.connected) return this.child
    // fork() inside VSCode uses the bundled Node runtime (ELECTRON_RUN_AS_NODE) — no user Node needed.
    const child = cp.fork(this.hostJs, [], { silent: true, execArgv: [] })
    child.stdout?.on('data', (d) => this.log.debug(`[engine] ${String(d).trim()}`))
    child.stderr?.on('data', (d) => this.log.warn(`[engine] ${String(d).trim()}`))
    child.on('message', (msg: any) => {
      const p = this.pending.get(msg?.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error ?? 'engine error'))
    })
    child.on('exit', (code) => {
      this.log.warn(`engine worker exited (${code})`)
      const err = new Error(`engine worker exited (${code})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      if (this.child === child) this.child = undefined
    })
    this.child = child
    return child
  }

  private call<T>(op: string, args: any): Promise<T> {
    const child = this.ensure()
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.send({ id, op, args }, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  ping(): Promise<string> {
    return this.call('ping', {})
  }
  discover(workspaceRoot: string): Promise<RepoInfo[]> {
    return this.call('discover', { workspaceRoot })
  }
  checkpoint(repos: RepoInfo[], shadowDir: string, id: string): Promise<CheckpointRef[]> {
    return this.call('checkpoint', { repos, shadowDir, id })
  }
  collect(refs: CheckpointRef[], repos: RepoInfo[], shadowDir: string): Promise<ChangeItem[]> {
    return this.call('collect', { refs, repos, shadowDir })
  }
  revertFile(item: ChangeItem, refs: CheckpointRef[], repos: RepoInfo[], shadowDir: string, allowCoTouched: boolean): Promise<void> {
    return this.call('revertFile', { item, refs, repos, shadowDir, allowCoTouched })
  }
  revertHunk(item: ChangeItem, hunk: Hunk, repos: RepoInfo[]): Promise<void> {
    return this.call('revertHunk', { item, hunk, repos })
  }
  revertRepo(repoRoot: string, refs: CheckpointRef[], changes: ChangeItem[], repos: RepoInfo[], shadowDir: string, agentAdded: string[]): Promise<void> {
    return this.call('revertRepo', { repoRoot, refs, changes, repos, shadowDir, agentAdded })
  }
  baselineContent(repoRoot: string, relPath: string, refs: CheckpointRef[], shadowDir: string): Promise<BlobContent> {
    return this.call('baselineContent', { repoRoot, relPath, refs, shadowDir })
  }

  dispose(): void {
    this.child?.kill()
    this.child = undefined
  }
}

export function absOf(item: { repoRoot: string; path: string }): string {
  return path.join(item.repoRoot, item.path)
}
