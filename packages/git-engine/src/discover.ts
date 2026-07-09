import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RepoInfo } from './types.ts'
import { norm, relPosix, isStrictlyUnder } from './paths.ts'

const SKIP_DIRS = new Set(['.git', 'node_modules'])

// A repo boundary is ANY `.git` entry — FILE or directory. `git init --separate-git-dir`
// produces a `.git` FILE (a gitdir pointer); a directory-only scan silently misses it and
// the outer add -A then embeds it as a 160000 gitlink, dropping all its files (SPEC T6).
function hasGitEntry(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

export function discoverRepos(workspaceRoot: string): RepoInfo[] {
  const root = norm(workspaceRoot)
  const roots: string[] = []

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
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name))
    }
  }
  walk(root)

  roots.sort() // enables longest-prefix routing later
  return roots.map((repoRoot) => {
    const nestedChildren = roots
      .filter((other) => other !== repoRoot && isStrictlyUnder(other, repoRoot))
      .map((other) => relPosix(repoRoot, other))
      .sort()
    return { repoRoot, relToWorkspace: relPosix(root, repoRoot) || '.', nestedChildren }
  })
}
