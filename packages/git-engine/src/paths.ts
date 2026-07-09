import * as path from 'node:path'
import * as crypto from 'node:crypto'

export function norm(p: string): string {
  return path.resolve(p).split(path.sep).join('/')
}

export function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}

// child is strictly under parent (not equal, not escaping via ..)
export function isStrictlyUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function repoKey(repoRoot: string): string {
  const n = norm(repoRoot)
  const h = crypto.createHash('sha1').update(n).digest('hex').slice(0, 16)
  const base = n.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-40)
  return `${base}-${h}`
}

// A repo-relative path must not escape the repo and must not fall under any nested child.
// This is the boundary guard: `git -C <repo>` does NOT enforce repo boundaries (SPEC T23).
export function assertSafeRelPath(relPath: string, nestedChildren: string[]): void {
  const clean = relPath.split(path.sep).join('/')
  if (clean.startsWith('/') || clean.split('/').includes('..') || path.isAbsolute(clean)) {
    throw new Error(`unsafe path: ${relPath}`)
  }
  for (const child of nestedChildren) {
    if (clean === child || clean.startsWith(child + '/')) {
      throw new Error(`boundary violation: '${relPath}' is inside nested repo '${child}'`)
    }
  }
}
