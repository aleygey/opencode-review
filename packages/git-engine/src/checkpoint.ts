import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { RepoInfo, CheckpointRef } from './types.ts'
import { runGit, gitText, gitOk, NO_CRLF, ADD_QUIET } from './git.ts'
import { repoKey } from './paths.ts'

let counter = 0
function tmpIndexPath(key: string): string {
  counter += 1
  return path.join(os.tmpdir(), `oc-cp-${key}-${process.pid}-${Date.now()}-${counter}`)
}

function excludePathspecs(nestedChildren: string[]): string[] {
  // ':(exclude,literal)<child>' — literal (not glob) so it covers the whole subtree AND
  // never over-matches a sibling like `moda/` when a nested repo is `mod[a]/` (SPEC T7).
  return nestedChildren.map((c) => `:(exclude,literal)${c}`)
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

export function checkpoint(
  repos: RepoInfo[],
  opts: { shadowDir: string; id: string },
): Map<string, CheckpointRef> {
  const out = new Map<string, CheckpointRef>()
  fs.mkdirSync(opts.shadowDir, { recursive: true })

  for (const repo of repos) {
    const cwd = repo.repoRoot
    const hadHead = gitOk(['rev-parse', '--verify', '-q', 'HEAD'], cwd)
    const idx = tmpIndexPath(repoKey(repo.repoRoot))
    try {
      try { fs.rmSync(idx, { force: true }) } catch {}
      const env = { GIT_INDEX_FILE: idx }
      const excl = excludePathspecs(repo.nestedChildren)

      // Temp index starts EMPTY; `add -A -- .` therefore snapshots the whole worktree
      // (tracked+untracked, honoring .gitignore) without ever opening the real index.
      const add = runGit([...NO_CRLF, ...ADD_QUIET, 'add', '-A', '--', '.', ...excl], cwd, env)
      if (add.status !== 0) throw new Error(`checkpoint add failed in ${cwd}: ${add.stderr.trim()}`)

      const tree = gitText([...NO_CRLF, 'write-tree'], cwd, env).trim()
      const commitArgs = hadHead
        ? ['commit-tree', tree, '-p', 'HEAD', '-m', 'opencode checkpoint']
        : ['commit-tree', tree, '-m', 'opencode checkpoint']
      const commit = gitText(commitArgs, cwd, IDENTITY).trim()

      // Store the commit + reachable objects in an EXTERNAL shadow bare repo, so the baseline
      // survives even if the agent later `rm -rf`s this worktree (SPEC T24).
      const shadow = shadowRepoPath(opts.shadowDir, repo.repoRoot)
      if (!fs.existsSync(shadow)) gitText(['init', '--bare', shadow], os.tmpdir())
      const ref = `refs/opencode/cp/${opts.id}`
      const shadowUrl = shadow.split(path.sep).join('/')
      const push = runGit(['push', '-q', '--force', shadowUrl, `${commit}:${ref}`], cwd)
      if (push.status !== 0) throw new Error(`checkpoint push failed in ${cwd}: ${push.stderr.trim()}`)

      out.set(repo.repoRoot, { repoRoot: repo.repoRoot, commit, ref, hadHead })
    } finally {
      try { fs.rmSync(idx, { force: true }) } catch {}
    }
  }
  return out
}
