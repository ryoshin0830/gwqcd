---
name: gwqcd
description: >
  Resolve the absolute path of an existing git worktree by fuzzy query, or list
  every worktree with its real branch name and the tool that created it —
  covering gwq worktrees, the ones `claude -w` puts at
  <repo>/.claude/worktrees/<slug>, and the ones herdr puts under
  ~/.herdr/worktrees. Use this skill when work must happen in a worktree that
  already exists — not for creating worktrees, cloning repositories, or
  locating a main clone.
when_to_use: |
  Use when the user says one of (or equivalent intent):
    - "go to the feat/login worktree / login のワークツリーに移動"
    - "which worktrees do I have? / worktree 一覧"
    - "run the tests in the fix-cache worktree"
    - "where is branch X checked out?"
    - "which agent worktrees are open? / claude -w のworktreeどれ?"

  Do NOT use this skill when the user wants any of:
    - creating a worktree, or one for a branch that has none yet (use `gwqpull`)
    - cloning a repository that is not on disk (use `gwqpull` or `ghq get`)
    - the main clone rather than a linked worktree (use `ghqcd`)
    - creating a brand-new remote repo (use `ghnew`)
    - removing a worktree (`gwq remove` — destructive, ask the user first)
allowed-tools: Bash
---

# gwqcd — resolve a gwq worktree path

`gwqcd` finds git worktrees in three places and prints the selected path. With
`--json` it never opens a UI, so it is safe to call from an agent session.

| `source` | location | created by |
| --- | --- | --- |
| `gwq` | `gwq config get worktree.basedir` | `gwq add` |
| `claude` | `<repo>/.claude/worktrees/<slug>` | `claude -w` |
| `herdr` | `~/.herdr/worktrees/<repo>/<slug>` | herdr |
| `other` | anywhere else | only seen with `--local` |

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

Otherwise (pin to `^0.3`, NOT `@latest`, so a future major bump does not
silently break the flow):

```bash
npx -y gwqcd@^0.3 --json <query>
```

`^0.3` is a floor as well as a ceiling: `source` and `--source` arrived in
0.3.0, and versions below 0.2 predate the fast discovery path entirely.

To enumerate instead of picking:

```bash
gwqcd --list --json                 # every worktree on the machine
gwqcd --list --json --no-main       # linked worktrees only
gwqcd --list --json --local         # only the current repository's
gwqcd --list --json --source gwq    # no agent worktrees
gwqcd --list --json --source claude # only `claude -w` worktrees
```

## Output (stdout, 1 line)

```json
{
  "schemaVersion": 1,
  "path":          "/Users/alice/worktrees/github.com/alice/api/feat-login",
  "branch":        "feat/login",
  "commit":        "8f2c1a9…",
  "isMain":        false,
  "source":        "gwq",
  "matches":       1
}
```

`--list --json`:

```json
{
  "schemaVersion": 1,
  "count":         2,
  "worktrees":     [{ "path": "…", "branch": "…", "commit": "…", "isMain": false, "source": "gwq" }]
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

## An agent worktree is somebody else's workspace

A `source` of `claude` or `herdr` means that worktree was handed to another
agent session. Running commands there, and especially committing there,
collides with work in progress that is not yours.

When you need a worktree to *work in*, ask for one that is not an agent's:

```bash
gwqcd --json --source gwq <query>
```

Read a `claude` or `herdr` worktree when the user asked about that specific
one — "what is the drifting-giggling-pond agent doing?" is a fair question.
Do not adopt it as your own working directory unless the user says so.

Their directory names are random and carry no branch information at all:
`drifting-giggling-pond` is on `fix/editor-chat-domain-guide`, and an
`agent-<hash>` worktree is often on a detached HEAD with `"branch": ""`.
Read `branch`, never the path.

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
- Start working in a `source` of `claude` or `herdr` without being asked to.
- Run `gwqcd --init` to modify the user's shell config without being asked.
- Run `gwq remove` / `git worktree remove` as a follow-up. Deleting a worktree
  can destroy uncommitted work; that is the user's call.

## After success

`cd` to the returned path if the harness can change cwd; otherwise pass the path
explicitly to subsequent commands (`git -C "<path>" status`). Mention the branch
you landed on — worktrees are easy to confuse.
