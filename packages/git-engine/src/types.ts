export type RepoInfo = {
  repoRoot: string // absolute, normalized, forward-slash
  relToWorkspace: string
  nestedChildren: string[] // repo-relative paths of every discovered repo strictly under this one
  // undefined = whole repo. An array scopes the review to these repo-relative subtrees.
  // Empty means this repo is only an ancestor/container for an included nested repo.
  includedPaths?: string[]
  // Concrete repo-relative directories skipped during discovery. They are load-bearing:
  // checkpoint/collect remove them from the review index, not merely from the watcher.
  excludedPaths?: string[]
  // Directory names skipped at any depth (used by the extension's fast scope check).
  excludedDirNames?: string[]
}

export type CheckpointRef = {
  repoRoot: string
  commit: string // sha of the checkpoint commit (dangling in the repo, durable in the shadow)
  ref: string // refs/opencode/cp/<id> — lives in the SHADOW bare repo, never the real repo
  hadHead: boolean
}

export type ChangeStatus = 'add' | 'mod' | 'del' | 'rename'

export type Hunk = {
  header: string // the @@ line
  body: string // the +/-/context lines after the @@ line
  agentAttributed: boolean
}

export type ChangeItem = {
  repoRoot: string
  path: string // repo-relative
  oldPath?: string
  status: ChangeStatus
  isBinary: boolean
  modeChange?: { from: string; to: string }
  hunks: Hunk[] // text hunks only
  patchHeader: string // diff --git / index / --- / +++ lines
  additions?: number
  deletions?: number
  oldOid?: string
  newOid?: string
  coTouchedByUser?: boolean // requires an AgentWriteRecord to detect; see SPEC open risk #1
}

// opencode's record of what IT wrote (absPath -> last-written content). Supplied by the
// P1 integration layer from the /event SSE edit/write tool events. Without it the engine
// cannot distinguish agent edits from concurrent user edits (see SPEC open risk #1).
export type AgentWriteRecord = Map<string, string>
