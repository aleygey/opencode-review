// Pure line-blame across a sequence of agent write captures. No vscode imports — unit-tested.
//
// Given the baseline text and every capture the agent produced for a file (in order),
// attribute each line of the FINAL content to the session whose capture introduced it.
// This lets a revert of one hunk notify exactly the session that owns那个代码块.

const LCS_CELL_LIMIT = 1_000_000 // middle-window DP guard (lines² cells)

// Map each line of `b` to its originating line in `a`, or -1 when the line is new in b.
export function mapLines(a: string[], b: string[]): number[] {
  const m = a.length
  const n = b.length
  const map = new Array<number>(n).fill(-1)

  let p = 0
  while (p < m && p < n && a[p] === b[p]) {
    map[p] = p
    p++
  }
  let s = 0
  while (s < m - p && s < n - p && a[m - 1 - s] === b[n - 1 - s]) {
    map[n - 1 - s] = m - 1 - s
    s++
  }

  const aLo = p
  const aHi = m - s
  const bLo = p
  const bHi = n - s
  const am = aHi - aLo
  const bn = bHi - bLo
  if (am <= 0 || bn <= 0) return map
  if (am * bn > LCS_CELL_LIMIT) return map // too big — treat middle as all-new (degrades to newer owner)

  // Standard LCS DP over the middle window, then backtrack to recover kept lines.
  const width = bn + 1
  const dp = new Int32Array((am + 1) * width)
  for (let i = am - 1; i >= 0; i--) {
    for (let j = bn - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[aLo + i] === b[bLo + j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < am && j < bn) {
    if (a[aLo + i] === b[bLo + j]) {
      map[bLo + j] = aLo + i
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++
    else j++
  }
  return map
}

export type Capture = { sessionID?: string; content: string }

// Owner session per line of the LAST capture's content (undefined = present since baseline).
// `deletedMarker` captures (agent deleted the file) reset the timeline to empty.
export function blameLines(baseline: string, captures: Capture[], deletedMarker?: string): (string | undefined)[] {
  let prev = baseline.length ? baseline.split('\n') : []
  let owners: (string | undefined)[] = new Array(prev.length).fill(undefined)
  for (const cap of captures) {
    if (deletedMarker !== undefined && cap.content === deletedMarker) {
      prev = []
      owners = []
      continue
    }
    const lines = cap.content.split('\n')
    const map = mapLines(prev, lines)
    const next: (string | undefined)[] = new Array(lines.length)
    for (let k = 0; k < lines.length; k++) {
      next[k] = map[k] >= 0 ? owners[map[k]] : cap.sessionID
    }
    prev = lines
    owners = next
  }
  return owners
}

// Majority owner among the given 0-based line indexes; undefined when no owned line.
export function majorityOwner(owners: (string | undefined)[], lines: number[]): string | undefined {
  const count = new Map<string, number>()
  for (const l of lines) {
    const o = l >= 0 && l < owners.length ? owners[l] : undefined
    if (!o) continue
    count.set(o, (count.get(o) ?? 0) + 1)
  }
  let best: string | undefined
  let bestN = 0
  for (const [o, n] of count) {
    if (n > bestN) {
      best = o
      bestN = n
    }
  }
  return best
}
