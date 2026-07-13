import * as path from 'node:path'
import * as fs from 'node:fs'
import type { RepoInfo, CheckpointRef } from './types.ts'
import { runGit, gitText, gitOk, NO_CRLF, ADD_QUIET, type GitEnv } from './git.ts'
import { repoKey, reviewIndexPath } from './paths.ts'
import { excludeLiteralPathspec, isRepoPathInScope, literalPathspec, scopeBoundaryPaths, scopePositivePaths } from './scope.ts'

// ':(exclude,literal)<child>' — literal (not glob) so it covers the whole subtree AND
// never over-matches a sibling like `moda/` when a nested repo is `mod[a]/` (SPEC T7).
// A child that is itself gitignored gets NO pathspec at all: `git add` treats any
// command-line pathspec naming an ignored path — even an exclude — as an explicit
// request, prints "The following paths are ignored by one of your .gitignore files"
// and exits 1. Ignored directories are skipped by `add -A -- .` wholesale, so the
// exclude is redundant for them anyway (SPEC T25).
export function excludePathspecsForAdd(boundaries: string[], cwd: string, env?: GitEnv): string[] {
  return boundaries
    // -q: exit 0 = ignored, drop the exclude; 1 (not ignored) or 128 (error) keep it,
    // so an odd failure degrades to the old behavior, never toward T6 gitlink embedding.
    .filter((c) => runGit(['check-ignore', '-q', '--', c], cwd, env).status !== 0)
    .map(excludeLiteralPathspec)
}

export function shadowRepoPath(shadowDir: string, repoRoot: string): string {
  return path.join(shadowDir, `${repoKey(repoRoot)}.git`)
}

// Fixed identity so commit-tree works regardless of the user's git config.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'opencode',
  GIT_AUTHOR_EMAIL: 'opencode@local',
  GIT_COMMITTER_NAME: 'opencode',
  GIT_COMMITTER_EMAIL: 'opencode@local',
}

function realIndexPath(cwd: string): string | undefined {
  const raw = gitText(['rev-parse', '--git-path', 'index'], cwd).trim()
  const abs = path.isAbsolute(raw) ? raw : path.join(cwd, raw)
  return fs.existsSync(abs) ? abs : undefined
}

// A copied real index gives us Git's warm stat cache without touching the user's staging
// area. `git add -A` below reconciles staged entries to WORKTREE bytes. If copying an exotic
// split/sparse index fails, read-tree HEAD is a safe (slower) fallback.
function seedReviewIndex(repo: RepoInfo, idx: string, hadHead: boolean): GitEnv {
  fs.mkdirSync(path.dirname(idx), { recursive: true })
  try { fs.rmSync(idx, { force: true }) } catch {}
  const real = realIndexPath(repo.repoRoot)
  // A real index created with autocrlf=true can cache a normalized LF blob while the
  // worktree contains CRLF. Reusing its stat tuple would skip hashing and violate the
  // engine's byte-exact baseline contract, so use a cold HEAD seed in that configuration.
  const autocrlfResult = runGit(['config', '--bool', '--get', 'core.autocrlf'], repo.repoRoot)
  const autocrlf = autocrlfResult.status === 0 && autocrlfResult.stdout.toString('utf8').trim() === 'true'
  if (real && !autocrlf) {
    try { fs.copyFileSync(real, idx) } catch {}
  }
  const env = { GIT_INDEX_FILE: idx }
  if (!fs.existsSync(idx)) gitText(hadHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], repo.repoRoot, env)
  return env
}

// A copied index may contain tracked files below a newly-created nested repo or outside an
// explicit review scope. Remove them before add: negative pathspecs alone do not remove an
// entry already present in the seed index.
export function pruneIndexToScope(repo: RepoInfo, env: GitEnv): void {
  const listed = gitText(['ls-files', '-z'], repo.repoRoot, env).split('\0').filter(Boolean)
  const remove = listed.filter((p) => !isRepoPathInScope(repo, p))
  if (remove.length === 0) return
  const input = Buffer.from(remove.join('\0') + '\0')
  const r = runGit(['update-index', '--force-remove', '-z', '--stdin'], repo.repoRoot, env, input)
  if (r.status !== 0) throw new Error(`scope prune failed in ${repo.repoRoot}: ${r.stderr.trim()}`)
}

export function reconcileWholeWorktree(repo: RepoInfo, env: GitEnv): void {
  const positive = scopePositivePaths(repo)
  if (positive.length === 0) return
  const args = [
    ...NO_CRLF,
    ...ADD_QUIET,
    'add',
    '-A',
    '--',
    ...positive.map(literalPathspec),
    ...excludePathspecsForAdd(scopeBoundaryPaths(repo), repo.repoRoot, env),
  ]
  const add = runGit(args, repo.repoRoot, env)
  if (add.status !== 0) throw new Error(`checkpoint add failed in ${repo.repoRoot}: ${add.stderr.trim()}`)
}

export function checkpoint(
  repos: RepoInfo[],
  opts: { shadowDir: string; id: string },
): Map<string, CheckpointRef> {
  const out = new Map<string, CheckpointRef>()
  fs.mkdirSync(opts.shadowDir, { recursive: true })

  for (const repo of repos) {
    const cwd = repo.repoRoot
    const hadHead = gitOk(['rev-parse', '--verify', '-q', 'HEAD'], cwd)
    const idx = reviewIndexPath(opts.shadowDir, repo.repoRoot)
    {
      let env = seedReviewIndex(repo, idx, hadHead)
      try {
        pruneIndexToScope(repo, env)
        reconcileWholeWorktree(repo, env)
      } catch {
        // Self-heal copied split/sparse/corrupt indexes via a plain checkpoint-tree seed.
        try { fs.rmSync(idx, { force: true }) } catch {}
        env = { GIT_INDEX_FILE: idx }
        gitText(hadHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], cwd, env)
        pruneIndexToScope(repo, env)
        reconcileWholeWorktree(repo, env)
      }
      const tree = gitText([...NO_CRLF, 'write-tree'], cwd, env).trim()
      // Deliberately a ROOT commit. A `-p HEAD` checkpoint makes the first push copy the
      // repository's entire history into shadow. Rollback only needs this tree closure.
      const commit = gitText(['commit-tree', tree, '-m', 'opencode checkpoint'], cwd, IDENTITY).trim()

      // Store the commit + reachable objects in an EXTERNAL shadow bare repo, so the baseline
      // survives even if the agent later `rm -rf`s this worktree (SPEC T24).
      const shadow = shadowRepoPath(opts.shadowDir, repo.repoRoot)
      if (!fs.existsSync(shadow)) gitText(['init', '--bare', shadow], opts.shadowDir)
      const ref = `refs/opencode/cp/${opts.id}`
      const shadowUrl = shadow.split(path.sep).join('/')
      const push = runGit(['push', '-q', '--force', shadowUrl, `${commit}:${ref}`], cwd)
      if (push.status !== 0) throw new Error(`checkpoint push failed in ${cwd}: ${push.stderr.trim()}`)

      out.set(repo.repoRoot, { repoRoot: repo.repoRoot, commit, ref, hadHead })
    }
  }
  return out
}
