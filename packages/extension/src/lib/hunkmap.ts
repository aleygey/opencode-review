// Pure hunk-to-editor-lines mapping. No vscode imports — unit-tested with node --test.

export type HunkPos = { oldStart: number; oldCount: number; newStart: number; newCount: number }

export function parseHunkHeader(header: string): HunkPos | undefined {
  const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!m) return undefined
  return {
    oldStart: parseInt(m[1], 10),
    oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
    newStart: parseInt(m[3], 10),
    newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
  }
}

export type DeletionAnchor = {
  line: number // 0-based line in the CURRENT file the deletion sits above; -1 = above line 0
  text: string[] // the removed lines
}

export type LineMarks = {
  added: number[] // 0-based lines in the CURRENT file that are '+' in the hunk
  deletions: DeletionAnchor[]
}

// Map one hunk body onto current-file coordinates.
// Walk with a 1-based `newLine` cursor starting at newStart; '+' marks that line and advances,
// context advances, '-' lines group into a deletion anchored above the current cursor line.
export function mapHunkToNewFile(header: string, body: string): LineMarks {
  const pos = parseHunkHeader(header)
  const marks: LineMarks = { added: [], deletions: [] }
  if (!pos) return marks

  // For a pure-deletion hunk git reports +c,0 meaning "after old line c maps before new line c+1";
  // starting the cursor at c+1 anchors the deletion correctly. General walk handles the rest.
  let newLine = pos.newCount === 0 ? pos.newStart + 1 : pos.newStart

  let pendingDel: string[] | null = null
  const flushDel = () => {
    if (pendingDel && pendingDel.length) {
      marks.deletions.push({ line: newLine - 2, text: pendingDel }) // above current line => sits after line (newLine-2)
    }
    pendingDel = null
  }

  for (const raw of body.split('\n')) {
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    const c = raw[0]
    if (c === '+') {
      flushDel()
      marks.added.push(newLine - 1)
      newLine++
    } else if (c === '-') {
      ;(pendingDel ??= []).push(raw.slice(1))
    } else if (c === ' ' || raw === '') {
      // context (empty string can appear from a trailing split artifact — treat as context only
      // when it is genuinely a context line; a trailing '' after final \n is skipped)
      if (c === ' ') {
        flushDel()
        newLine++
      }
    }
  }
  flushDel()
  return marks
}

// Aggregate marks for a whole file from its hunks.
export function mapFileMarks(hunks: { header: string; body: string }[]): LineMarks {
  const out: LineMarks = { added: [], deletions: [] }
  for (const h of hunks) {
    const m = mapHunkToNewFile(h.header, h.body)
    out.added.push(...m.added)
    out.deletions.push(...m.deletions)
  }
  return out
}

// First current-file line a hunk touches — used for navigation and hunk tree labels.
export function hunkFirstLine(header: string, body: string): number {
  const m = mapHunkToNewFile(header, body)
  if (m.added.length) return m.added[0]
  if (m.deletions.length) return Math.max(0, m.deletions[0].line)
  const pos = parseHunkHeader(header)
  return pos ? Math.max(0, pos.newStart - 1) : 0
}
