import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RepoInfo } from './types.ts'
import { norm, relPosix, isStrictlyUnder } from './paths.ts'

// Generated/vendored dirs never hold reviewable source and can be enormous — skipping the
// WALK into them keeps discover cheap on a huge workspace. (These are also gitignored in
// practice, so the parent `add -A` skips them too and there's no T6 gitlink risk.)
const DEFAULT_SKIP = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__',
  '.cache', '.next', '.turbo', 'vendor', 'coverage', '.oc-review',
]

// A repo boundary is ANY `.git` entry — FILE or directory. `git init --separate-git-dir`
// produces a `.git` FILE (a gitdir pointer); a directory-only scan silently misses it and
// the outer add -A then embeds it as a 160000 gitlink, dropping all its files (SPEC T6).
function hasGitEntry(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

export function discoverRepos(workspaceRoot: string, opts?: { skip?: string[]; include?: string[] }): RepoInfo[] {
  const root = norm(workspaceRoot)
  const skip = new Set([...DEFAULT_SKIP, ...(opts?.skip ?? [])])
  const includeConfigured = (opts?.include ?? []).length > 0
  const includes = (opts?.include ?? [])
    .map((p) => norm(path.isAbsolute(p) ? p : path.join(root, p)))
    .filter((p) => p === root || isStrictlyUnder(p, root))
  const roots: string[] = []
  const excluded: string[] = []

  // Only descend into branches that intersect an explicit include. Ancestor repos are still
  // discovered so a workspace-root repo can own an included subtree safely.
  const intersectsInclude = (dir: string): boolean =>
    !includeConfigured || includes.some((inc) => inc === dir || isStrictlyUnder(inc, dir) || isStrictlyUnder(dir, inc))

  const walk = (dir: string): void => {
    if (hasGitEntry(dir)) roots.push(norm(dir))
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const child = norm(path.join(dir, e.name))
      if (skip.has(e.name)) {
        if (e.name !== '.git') excluded.push(child)
        continue
      }
      if (intersectsInclude(child)) walk(child)
    }
  }
  walk(root)

  roots.sort() // enables longest-prefix routing later
  return roots.map((repoRoot) => {
    const nestedChildren = roots
      .filter((other) => other !== repoRoot && isStrictlyUnder(other, repoRoot))
      .map((other) => relPosix(repoRoot, other))
      .sort()
    const excludedPaths = excluded
      .filter((other) => isStrictlyUnder(other, repoRoot))
      .map((other) => relPosix(repoRoot, other))
      .filter((rel) => !nestedChildren.some((child) => rel === child || rel.startsWith(child + '/')))
      .sort()
    let includedPaths: string[] | undefined
    if (includeConfigured) {
      if (includes.some((inc) => inc === repoRoot || isStrictlyUnder(repoRoot, inc))) includedPaths = ['.']
      else {
        includedPaths = includes
          .filter((inc) => isStrictlyUnder(inc, repoRoot))
          .map((inc) => relPosix(repoRoot, inc))
          .sort()
      }
    }
    return {
      repoRoot,
      relToWorkspace: relPosix(root, repoRoot) || '.',
      nestedChildren,
      includedPaths,
      excludedPaths,
      excludedDirNames: [...skip].filter((name) => name !== '.git'),
    }
  })
}
