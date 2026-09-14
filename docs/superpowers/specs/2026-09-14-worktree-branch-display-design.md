# Branch names in the interactive worktree picker

Status: revised after the user's request to improve the UX and implement/push.

## Problem and evidence

Codex paths such as ~/.codex/worktrees/4e86/general do not encode a branch.
The current fzfPick() receives paths only; main() resolves selected metadata
after the picker exits. PR #2 remains open at ccf1f0c.

One live measurement on 2026-09-14 with 142 candidates: --list took 338ms,
and --list --json took 845ms. These whole-command samples illustrate the cost
of resolving metadata, not a predicted or isolated UI timing.

## Options

1. Show branch and path for every interactive candidate (recommended).
   Consistent comparison, at the cost of metadata lookup before showing fzf.
2. Show branch only in the selected candidate's preview.
   Preserves initial discovery latency, but users cannot compare branches in the list.
3. Add labels only for Codex candidates.
   Fewer lookups, but an inconsistent list and the same blind spot for other tools.

## Proposed interface

Each interactive row starts with the actual branch label, then the worktree path:

```text
codex/named          /home/verify/.codex/worktrees/b123/general
detached@89af2901    /home/verify/.codex/worktrees/4e86/general
```

- Read names from Git, never infer them from directory names.
- Use detached@<first-eight-commit-characters> for a detached HEAD.
- If metadata cannot be read, display (unavailable), not a fabricated branch
  or detached state. Keep the path selectable as in the existing behavior.
- Apply labels to every source and --local, including the interactive --quiet
  mode used by the shell function.
- Resolve candidate metadata through the existing bounded parallel resolver
  after source/no-main filtering. Reuse already-resolved local metadata.
- Search both visible branch labels and paths in the interactive UI. Keep
  noninteractive path matching unchanged for script compatibility.
- Shorten only the home prefix to ~/ in displayed paths; do not truncate
  branch names or use directory IDs as branch labels. Use color as secondary
  emphasis, with complete textual labels when color is disabled.
- Use the full list width and place the preview below it, showing full
  branch, path, commit and recent Git history. Ctrl-/ toggles the preview.
- Use 70% terminal height, a compact header with keyboard hints, and hide the
  preview initially on terminals shorter than 24 rows. This avoids reducing
  the candidate list to a sliver on small terminals.
- Decode the selected display row to the exact original path. Git-log preview
  must also receive only that path; neither labels nor delimiters may reach cd.
- Carry the original path and metadata in an opaque base64url field hidden
  from display/search. The preview helper invokes Git with an argument array,
  so paths containing quotes, shell metacharacters or tabs remain data.
- Preserve JSON/list output schemas, noninteractive matching, cancellation
  exit codes, and stdout/stderr discipline.

The user's request supersedes CLAUDE.md's old decision not to add branch
columns. Update that guidance and the old zero-metadata interactive claim to
describe the new behavior. No dependency additions are needed.

## Delivery and validation

After design review, write the implementation plan and extend PR #2.
Add regression coverage for branch/detached/unavailable labels, exact selected
paths, preview argument handling, source filters, local behavior, and existing
machine output contracts. Include spaces and non-ASCII paths/branch names.

Run the full suite and real fzf in the dedicated Docker container. Verify
selection and Escape with the generated shell function, measure picker startup,
capture the branch-column UI, and post the updated screenshot to PR #2.
