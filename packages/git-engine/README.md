# opencode-git-engine

Multi-repo **git checkpoint / diff / rollback** engine — the correctness-critical core of the opencode VSCode review extension. Pure Node, **zero runtime dependencies**.

Built for a workspace that is one top-level directory containing **multiple independent git repositories at nested subdirectory levels**. opencode's own snapshot and other extensions use a single flat shadow-git worktree and silently miss files inside nested repos; this engine treats every repo as its own rollback unit.

Every git recipe here was empirically hardened against data-loss, wrong-result and nested-boundary bugs — see [SPEC.md](SPEC.md) (API, verified commands, 25-case test matrix, open risks).

## Requirements

- **Node ≥ 24 recommended** — runs the `.ts` sources natively.
- Node 22.6–23.5 also works but add the flag: `node --experimental-strip-types src/cli.ts demo`.
- `git` on `PATH`.

## Try it in one command (safe — builds a throwaway workspace in your temp dir)

```bash
cd packages/git-engine
npm run demo          # or:  node src/cli.ts demo
```

The demo builds a top repo with an independent nested repo inside it, checkpoints, simulates an opencode turn (modify + add + delete + edit-in-nested + ignored + user-untracked), prints the change list, then reverts — asserting at each step that:

- the nested repo is excluded from the top checkpoint (no gitlink swallow),
- nested-repo edits are attributed to the nested repo, not the parent,
- `.gitignore`d files are omitted,
- a single file reverts **byte-exact**,
- a whole-repo revert restores modified/deleted files, deletes only the agent-added file, and **preserves the user's untracked file and the nested repo**.

## Run the test matrix

```bash
npm test              # node --test  (9 hardened scenarios: T1/T3/T9/T14/T17/T21/T23/T24)
```

## Commands

```bash
node src/cli.ts discover    <workspace>
node src/cli.ts checkpoint  <workspace> [shadowDir] [id]
node src/cli.ts status      <workspace> [shadowDir] [id]
node src/cli.ts revert-file <workspace> <path>              [shadowDir] [id]
node src/cli.ts revert-repo <workspace> <repoRelToWorkspace> [shadowDir] [id] [--delete-added]
```

Defaults: `shadowDir = <tmp>/oc-shadow`, `id = default`. Typical loop on your real workspace:

```bash
node src/cli.ts checkpoint .           # baseline before an opencode turn
# ... let opencode edit files ...
node src/cli.ts status .               # see what changed, per repo
node src/cli.ts revert-file . path/to/file.ts
```

## API

`discoverRepos` · `checkpoint` · `collectChanges` · `revertFile` · `revertHunk` · `revertRepo`. Signatures and behavior in [SPEC.md](SPEC.md).

## Known limitations (v0.1)

- **Safe per-file / per-hunk revert needs an `AgentWriteRecord`** (what opencode itself wrote). Without it the engine can't distinguish agent edits from concurrent user edits, so it conservatively refuses co-touched files and won't auto-delete "added" files on a repo revert (a user's untracked file also looks like an add). This record is wired in the P1 integration layer from opencode's `/event` tool events.
- File-mode and symlink fidelity depend on the git platform (preserved on Linux/WSL; lossy on native-Windows git). Content is byte-exact everywhere.
