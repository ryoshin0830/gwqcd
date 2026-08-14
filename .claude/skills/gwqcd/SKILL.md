---
name: gwqcd
description: >
  Resolve the absolute path of an existing git worktree managed by gwq, by fuzzy
  query, or list every worktree with its real branch name. Use this skill when
  work must happen in a worktree that already exists — not for creating
  worktrees, cloning repositories, or locating a main clone.
when_to_use: |
  Use when the user says one of (or equivalent intent):
    - "go to the feat/login worktree / login のワークツリーに移動"
    - "which worktrees do I have? / worktree 一覧"
    - "run the tests in the fix-cache worktree"
    - "where is branch X checked out?"

  Do NOT use this skill when the user wants any of:
    - creating a worktree, or one for a branch that has none yet (use `gwqpull`)
    - cloning a repository that is not on disk (use `gwqpull` or `ghq get`)
    - the main clone rather than a linked worktree (use `ghqcd`)
    - creating a brand-new remote repo (use `ghnew`)
    - removing a worktree (`gwq remove` — destructive, ask the user first)
allowed-tools: Bash
---

# gwqcd — resolve a gwq worktree path

`gwqcd` wraps `gwq list --json` + `fzf` and prints the selected worktree path.
With `--json` it never opens a UI, so it is safe to call from an agent session.

## Prerequisites (verify before invoking)

1. `gwq --version`
2. `fzf --version`
3. `node --version` (must be `>= 20.12`)

If any is missing, tell the user to run `brew install fzf d-kuro/tap/gwq` rather
than calling gwqcd and reporting exit 127. `jq` is **not** required.

## Recommended call

Always use `--json`. Never call the bare command from an agent: without a TTY it
exits 3 (`E_AMBIGUOUS`), and with one it would block on the fzf UI.

If `gwqcd` is on PATH:

```bash
gwqcd --json <query>
```

Otherwise (pin to `^0.1`, NOT `@latest`, so a future major bump does not
silently break the flow):

```bash
npx -y gwqcd@^0.1 --json <query>
```

To enumerate instead of picking:

```bash
gwqcd --list --json                 # every worktree gwq knows about
gwqcd --list --json --no-main       # linked worktrees only
gwqcd --list --json --local         # only the current repository's
```

## Output (stdout, 1 line)

```json
{
  "schemaVersion": 1,
  "path":          "/Users/alice/worktrees/github.com/alice/api/feat-login",
  "branch":        "feat/login",
  "commit":        "8f2c1a9…",
  "isMain":        false,
  "matches":       1
}
```

`--list --json`:

```json
{
  "schemaVersion": 1,
  "count":         2,
  "worktrees":     [{ "path": "…", "branch": "…", "commit": "…", "isMain": false }]
}
```

Parse with `jq -r .path`. Tolerate unknown fields — the schema allows additive
growth.

## Match on `branch`, not on the directory name

The directory slug is lossy: branch `feat/login` lives in a directory called
`feat-login`. When the user names a branch, confirm against the `branch` field
of the result rather than assuming the path spells it. When you need an exact
branch, prefer `--list --json` and filter on `branch` yourself:

```bash
gwqcd --list --json | jq -r '.worktrees[] | select(.branch == "feat/login") | .path'
```

## `matches` is the ambiguity signal — check it

`matches > 1` means the query hit several worktrees and you received the
best-scoring one. Do not silently act on it: show the user the candidates
(`gwqcd --list --json <query>`) and ask which they meant. Acting on a best-guess
path can run commands against the wrong branch.

`matches == 1` is unambiguous; proceed.

## Errors (stderr, 1 line JSON, non-zero exit)

```json
{ "schemaVersion": 1, "error": { "code": "E_NO_MATCH", "message": "…" }, "exitCode": 2 }
```

| code            | exit | meaning                                        |
|-----------------|------|-------------------------------------------------|
| `E_VALIDATION`  | 1    | flag conflict or extra positional               |
| `E_GWQ`         | 1    | gwq failed, or emitted unparseable `--json`     |
| `E_FZF`         | 1    | fzf could not be run                            |
| `E_NO_MATCH`    | 2    | no worktrees, or the query matched none         |
| `E_AMBIGUOUS`   | 3    | called without a query and without a TTY        |
| `E_DEPS`        | 127  | `gwq` or `fzf` missing                          |
| `E_INTERRUPTED` | 130  | Esc / Ctrl-C                                    |

stderr *carries* that line; it is not exclusively JSON. Node warnings and child
diagnostics share the stream, so select the line starting with `{` —
`2>&1 >/dev/null | grep -m1 '^{' | jq -r .error.code` — rather than piping the
whole stream to `jq`.

On `E_NO_MATCH`, the worktree does not exist yet. Say so and offer `gwqpull`
(which creates one); do NOT retry with a mutated query, and do NOT run
`gwq add` without asking.

## Things the skill must NOT do

- Call `gwqcd` without `--json` and try to parse the box output.
- Treat a `matches > 1` result as a confirmed choice.
- Infer the branch from the directory name instead of reading `branch`.
- Run `gwqcd --init` to modify the user's shell config without being asked.
- Run `gwq remove` / `git worktree remove` as a follow-up. Deleting a worktree
  can destroy uncommitted work; that is the user's call.

## After success

`cd` to the returned path if the harness can change cwd; otherwise pass the path
explicitly to subsequent commands (`git -C "<path>" status`). Mention the branch
you landed on — worktrees are easy to confuse.
