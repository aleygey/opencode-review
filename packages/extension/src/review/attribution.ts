import type { ReviewController, ReviewItem } from './controller.ts'
import { DELETED_MARKER, type AgentWriteStore } from '../opencode/agentWrites.ts'
import { blameLines, majorityOwner } from '../lib/blame.ts'
import { mapHunkToNewFile } from '../lib/hunkmap.ts'
import type { Log } from '../log.ts'

// Block-level session attribution: which session owns WHICH lines of a changed file.
// Sound only when (a) the file's current content equals the agent's last capture
// (attribution === 'agent'), (b) the capture history did not overflow, (c) text file.
// Anything else degrades gracefully to "every session that wrote the file".
export class Attribution {
  private cache = new Map<string, (string | undefined)[] | null>() // abs -> line owners (null = blame unusable)

  constructor(
    private readonly controller: ReviewController,
    private readonly agentWrites: AgentWriteStore,
    private readonly log: Log,
  ) {
    controller.onDidChange(() => this.cache.clear())
  }

  private async blameFile(item: ReviewItem): Promise<(string | undefined)[] | null> {
    const key = item.abs
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    let out: (string | undefined)[] | null = null
    try {
      const { captures, truncated } = this.agentWrites.historyFor(item.abs)
      if (captures.length > 0 && !truncated && item.attribution === 'agent' && !item.isBinary) {
        const base = await this.controller.baselineContent(item)
        if (!base.binary) {
          out = blameLines(base.exists ? (base.text ?? '') : '', captures, DELETED_MARKER)
        }
      }
    } catch (e: any) {
      this.log.warn(`blame failed for ${item.path}: ${e?.message ?? e}`)
    }
    this.cache.set(key, out)
    return out
  }

  // Sessions owning THIS hunk (usually exactly one); falls back to every writer.
  async ownersForHunk(item: ReviewItem, hunkIndex: number): Promise<string[]> {
    const all = this.agentWrites.sessionsFor(item.abs)
    if (all.length <= 1) return all
    const owners = await this.blameFile(item)
    const h = item.hunks[hunkIndex]
    if (!owners || !h) return all
    const marks = mapHunkToNewFile(h.header, h.body)
    const own = majorityOwner(owners, marks.added)
    return own ? [own] : all // deletion-only hunk: the deleter isn't visible in final lines -> all writers
  }

  // Union of owners across the file's hunks; conservative: any unattributable part -> all writers.
  async ownersForFile(item: ReviewItem): Promise<string[]> {
    const all = this.agentWrites.sessionsFor(item.abs)
    if (all.length <= 1) return all
    const owners = await this.blameFile(item)
    if (!owners) return all
    const set = new Set<string>()
    let unowned = false
    for (const h of item.hunks) {
      const marks = mapHunkToNewFile(h.header, h.body)
      if (marks.added.length === 0) {
        unowned = true // pure deletion — deleter unknown from final content
        continue
      }
      for (const l of marks.added) {
        const o = owners[l]
        if (o) set.add(o)
        else unowned = true
      }
    }
    if (set.size === 0 || unowned) return all
    return [...set]
  }

  // Quick-ask routing: owner of the SELECTED lines in the current file.
  async ownerForLines(abs: string, lines: number[]): Promise<string | undefined> {
    const all = this.agentWrites.sessionsFor(abs)
    if (all.length === 0) return undefined
    if (all.length === 1) return all[0]
    const item = this.controller.itemFor(abs)
    if (!item) return this.agentWrites.sessionFor(abs)
    const owners = await this.blameFile(item)
    if (!owners) return this.agentWrites.sessionFor(abs)
    return majorityOwner(owners, lines) ?? this.agentWrites.sessionFor(abs)
  }
}
