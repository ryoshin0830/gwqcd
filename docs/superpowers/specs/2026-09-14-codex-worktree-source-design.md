# Codex App worktree discovery

Status: proposed for user review; implementation has not started.

## Investigation

The starting checkout was 8154f84 (0.2.3), behind origin/main. The design
targets origin/main at 77a2250, which merged PR #1 adding Claude and Herdr
sources. Live execution of that revision on 2026-09-14 returned 139 entries:
124 gwq, 14 claude, 1 herdr, and zero paths under ~/.codex.

Current discovery uses gwq's configured base directory, ghq roots (only to
find nested Claude worktrees), and ~/.herdr/worktrees. It does not inspect
~/.codex/worktrees and does not accept codex in --source.

Git registers /Users/shin-ryo/.codex/worktrees/4e86/general as a linked,
detached worktree of /Users/shin-ryo/ghq/github.com/shin-ryo_pepabo/general.
The current --local path already lists it; global discovery misses it.
There is no need to modify or recreate that worktree.

## Alternatives

1. Add a Codex root and source to the existing discovery pipeline (recommended).
   Reuses bounded walks, pruning, lazy metadata, and filtering with no new
   runtime dependency or per-repository Git discovery calls.
2. Enumerate git worktree list for every known repository. Finds arbitrary
   registered locations but adds subprocess cost and changes discovery scope.
3. Add a general configurable-root interface. More flexible, but requires
   manual setup and introduces configuration beyond this request.

## Proposed behavior

- Include ~/.codex/worktrees in default global discovery. Resolve a nonempty
  CODEX_HOME as the Codex home when explicitly configured; otherwise use
  ~/.codex. This is a proposed configuration contract, not a claim that this
  investigation verified every Codex App configuration.
- Add codex to --source, including comma-separated combinations and all.
- Emit source: codex in JSON for Codex paths in both global and local modes.
  Preserve schemaVersion 1 and the other existing fields. Detached worktrees
  retain branch: "" and their actual commit; isMain remains false.
- Reuse root canonicalization and path deduplication. Codex paths must keep
  the codex label if the gwq root overlaps the Codex root; nested Claude
  worktrees retain the more specific claude label in global and local output.
- Missing or unreadable Codex roots contribute nothing. Existing gwq fallback
  conditions and errors remain in force. Do not introduce a Codex CLI dependency.
- Reuse .git pruning and explicit .claude/worktrees peeks. Do not recursively
  scan checked-out source files, node_modules, Git object stores, or the home
  directory as a whole. Metadata remains lazy.

## Files and validation

Update bin/gwqcd.mjs, test/cli.test.mjs, README.md, CLAUDE.md, and the agent
usage contract .claude/skills/gwqcd/SKILL.md. Keep zero runtime dependencies
and Node >= 20.12.0. Do not modify prior historical design records.

Use real temporary Git worktrees in isolated test homes to cover the default
Codex root, explicit CODEX_HOME, detached and named branches, source filters,
local classification, nested Claude worktrees, overlapping and symlinked roots,
absent roots, and gwq fallback behavior. Clear inherited CODEX_HOME in the
test runner so the developer's actual worktrees cannot enter fixtures.

Run the full suite and npm pack --dry-run. Verify the reported general path
through --list --json, --source codex, and --quiet, and compare JSON metadata
with Git. Measure before/after discovery wall time with the same command and
report measured values rather than inferring component costs.

## Delivery

After design approval, write the implementation plan and execute it using
the requested writing-plans and executing-plans workflow. Commit changes on
codex/add-codex-worktree-source, create a PR against main, verify its contents,
and open it in Codex. Publishing and merging are outside this request.
