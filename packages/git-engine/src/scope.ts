import type { RepoInfo } from './types.ts'

function clean(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'
}

function under(rel: string, parent: string): boolean {
  return parent === '.' || rel === parent || rel.startsWith(parent + '/')
}

export function isRepoPathInScope(repo: RepoInfo, rawPath: string): boolean {
  const rel = clean(rawPath)
  if (rel === '.git' || rel.startsWith('.git/')) return false
  if (repo.nestedChildren.some((p) => under(rel, clean(p)))) return false
  if ((repo.excludedPaths ?? []).some((p) => under(rel, clean(p)))) return false
  const excludedNames = new Set(repo.excludedDirNames ?? [])
  if (rel.split('/').some((segment) => excludedNames.has(segment))) return false
  const include = repo.includedPaths
  return include === undefined || include.some((p) => under(rel, clean(p)))
}

export function scopePositivePaths(repo: RepoInfo): string[] {
  return repo.includedPaths === undefined ? ['.'] : repo.includedPaths.map(clean)
}

// A watcher may fold deletion of `src/app` into an event for its ancestor `src`. Project
// that event onto the protected include roots instead of dropping it or scanning outside
// scope.
export function projectPathsToScope(repo: RepoInfo, paths: Iterable<string>): string[] {
  const projected: string[] = []
  for (const raw of paths) {
    const p = clean(raw)
    if (isRepoPathInScope(repo, p)) {
      projected.push(p)
      continue
    }
    for (const inc of repo.includedPaths ?? []) {
      const include = clean(inc)
      if (p === '.' || include.startsWith(p + '/')) {
        if (isRepoPathInScope(repo, include)) projected.push(include)
      }
    }
  }
  return coalesceRepoPaths(projected)
}

export function scopeBoundaryPaths(repo: RepoInfo): string[] {
  return [...new Set([...repo.nestedChildren, ...(repo.excludedPaths ?? [])].map(clean))]
}

export function literalPathspec(rel: string): string {
  const p = clean(rel)
  return p === '.' ? '.' : `:(top,literal)${p}`
}

export function excludeLiteralPathspec(rel: string): string {
  return `:(top,exclude,literal)${clean(rel)}`
}

// Removes redundant descendants: ["src", "src/a.ts"] -> ["src"]. This keeps command
// lines short during tool bursts and gives directory create/delete events the intended scope.
export function coalesceRepoPaths(paths: Iterable<string>): string[] {
  const sorted = [...new Set([...paths].map(clean).filter((p) => p !== '.git' && !p.startsWith('.git/')))].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )
  const out: string[] = []
  for (const p of sorted) if (!out.some((parent) => under(p, parent))) out.push(p)
  return out
}
