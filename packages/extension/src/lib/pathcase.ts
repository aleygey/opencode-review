import * as path from 'node:path'

// Canonical key for path comparisons/Map keys. Windows filesystems are case-insensitive,
// and opencode/VSCode disagree on drive-letter (and sometimes dir) casing — keying maps
// case-sensitively silently disabled agent-write attribution there (review finding #14).
// Never use the folded value for actual file I/O; keep the original path for that.
export function normcase(p: string): string {
  const n = path.normalize(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}
