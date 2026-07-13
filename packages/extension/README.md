# OC Review — opencode change review for VSCode

Review, navigate and roll back what the [opencode](https://opencode.ai) agent changed — across **multiple independent git repos nested inside one workspace** — plus quick-ask about any selection.

## What it does

- **Changes view** (activity bar → OC Review): every file opencode changed since the baseline, grouped per git repo, with +/− stats and per-hunk children.
- **Diff**: click a file → baseline ↔ working diff. Prefer single-column? Toggle the diff editor's inline mode (gear icon in the diff editor, or set `"diffEditor.renderSideBySide": false`).
- **Inline marks** in the real editor: added lines tinted, deletion anchors with hover showing removed lines. Toggle: `OC Review: Toggle Inline Change Marks`.
- **Navigation**: `Ctrl+Alt+PageDown/PageUp` jump across all changed hunks in all files.
- **Revert**: per hunk / per file / per repo — byte-exact restore from the baseline, boundary-guarded so a workspace-level revert can never leak into a nested repo.
- **Quick-ask** (`Ctrl+Alt+A` or right-click → *Ask opencode About Selection*): ask why a change was made — or about ANY code, changed or not. Streams the answer into a side panel.
- **Auto-checkpoint**: a baseline snapshot of every repo is taken when an opencode turn starts (via the server's event stream), so the review is always against "before the agent touched it".

## Requirements

- `git` on PATH.
- An **opencode server** reachable from this machine: run `opencode serve` (default `127.0.0.1:4096`) in/above your workspace, or set `ocReview.serverUrl`.
- Recommended opencode config for the non-blocking flow:

```jsonc
// opencode.jsonc
{
  "permission": { "edit": "allow" },
  "snapshot": false
}
```

## Getting started

1. Install the `.vsix` (Extensions view → ⋯ → *Install from VSIX*). On Remote-SSH/WSL, do this in the **remote** window so the extension runs next to the server and your files.
2. Open your workspace folder. The status bar shows `OC: …`; run `OC Review: Connect to opencode Server` if it says disconnected.
3. Run `OC Review: Checkpoint Now` once (afterwards auto-checkpoint handles it), let opencode work, then review in the OC Review panel.
4. `OC Review: Diagnose` prints server/engine/repo state into the output channel — start there if anything looks off.

## Large workspaces

OC Review keeps a persistent per-repo review index and refreshes only paths reported by
opencode/VSCode file events. Manual Refresh remains an authoritative full audit.

For very large monorepos, scope protection explicitly:

```jsonc
{
  "ocReview.includePaths": ["src", "packages/app"],
  "ocReview.excludeDirs": ["generated", "third_party_cache"]
}
```

Paths outside this scope are not checkpointed, reviewed, or revertible. Only exclude content
that the agent must never modify. Built-in generated/cache directories are excluded as well.

## Safety model (honest edition)

- Reverts restore **byte-exact** baseline content and never run `git clean` / touch your real index; nested repos are their own rollback units.
- If a file's current content doesn't match what the agent wrote (you edited it too), it is flagged **co-touched** and revert requires an explicit "Revert anyway".
- Changes the extension never saw the agent write (e.g. it wasn't running during the turn) are flagged **unverified** and treated as possibly user-owned by default (`ocReview.strictAttribution: true`): reverting them requires explicit confirmation, and hunk-revert is reserved for verified agent output. Start the extension (and its server connection) before running opencode for full attribution.
- Repo-level revert only deletes added files that are positively attributed to the agent.
