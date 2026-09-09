# Worktree sources: `claude -w` and herdr

Date: 2026-09-09
Status: approved, implemented in the same pull request
Supersedes nothing. Extends invariant I7b.

## Problem

`gwqcd` finds worktrees in exactly one place: the directory gwq is configured
to create them in. Two other tools now create worktrees on this machine and
neither uses that directory.

`claude -w` puts a worktree **inside the main worktree**, at
`<repo>/.claude/worktrees/<slug>`. herdr puts one at
`~/.herdr/worktrees/<repo>/<slug>`. Both are ordinary linked git worktrees,
registered in the main repository's `.git/worktrees/`, and neither is reachable
from gwq's base directory. Measured on this machine: eleven from `claude -w`
across four repositories, one from herdr.

So `gwqcd` shows a subset of the worktrees the user actually has, and the
missing ones are the freshest — they are where the agent work is happening.

## Constraints

The interactive picker is the hot path. `gwq list -g --json` now takes
**43.7 seconds** here, up from the 7.6 seconds recorded when I7b was written,
because it walks the base directory and shells out to git for every file it
finds. Anything this design adds has to stay in the tens of milliseconds, or it
recreates the bug I7b existed to fix.

Finding a `claude -w` worktree means looking inside a main worktree, which is
the one place I7b's walk deliberately refuses to enter. That is the tension the
design has to resolve.

## Approaches considered

**Ask each tool.** `gwq list`, `herdr worktree list`, and a Claude Code
equivalent. Rejected: `gwq list -g --json` is the 43-second call this project
already routes around, and `herdr worktree list` is scoped to the current
workspace rather than global, so it cannot enumerate anything. There is no
global lister to call.

**Walk each repository with git.** `git worktree list --porcelain` per ghq
repository. Correct and complete, and it finds worktrees in places nobody
predicted. Measured at 273ms for 44 repositories, against 10ms for the walk
below. Rejected on cost: it spawns one git process per repository to learn
something the filesystem already spells out.

**Walk the filesystem, peeking where we prune.** Recommended and chosen. The
existing walker already stops at the first `.git` it meets. One extra `readdir`
at that exact moment — of `<dir>/.claude/worktrees` — finds every `claude -w`
worktree without ever descending into the repository. Measured at 9ms for the
whole of `~/ghq`, 61 directories visited to cover 44 repositories.

## Design

### Sources

A worktree now carries a **source**, meaning the tool whose convention put it
where it is. Source is decided at discovery time, by construction, never
guessed from the path afterwards.

| source   | location                             | how it is found                        |
| -------- | ------------------------------------ | -------------------------------------- |
| `gwq`    | gwq's `worktree.basedir`             | walk, `emitAs: 'gwq'`                  |
| `claude` | `<repo>/.claude/worktrees/<slug>`    | peek at every prune point, every root  |
| `herdr`  | `~/.herdr/worktrees/<repo>/<slug>`   | walk, `emitAs: 'herdr'`                |
| `other`  | anything else                        | only reachable through `--local`       |

### Roots

Three roots are walked. The two that need a subprocess are resolved
concurrently, so the added wall-clock is the slower of the two rather than
their sum.

| root        | resolution                                                             | cost |
| ----------- | ---------------------------------------------------------------------- | ---- |
| gwq basedir | `gwq config get worktree.basedir`, tilde expanded by us. Unchanged.    | 11ms |
| ghq root    | `ghq root`; failing that `$GHQ_ROOT` split on `:`; failing that `~/ghq` | 52ms |
| herdr root  | `~/.herdr/worktrees`                                                   | 0    |

Concurrency buys less here than the framing suggests: 55ms together against
63ms in sequence, because the gwq lookup is nearly free. It is still the right
shape, and it costs nothing.

Roots that do not exist are dropped, and each one is resolved through
`realpath` before the walk so every path built from it is spelled one way.

Overlap between roots is handled at the output, with a first-writer-wins map
keyed by path, **not** by skipping a root that sits inside another. Skipping
looks tidier and is wrong: a `worktree.basedir` configured inside the ghq root
would be the root skipped, and every gwq worktree would vanish from the
listing. A root that contributes nothing new costs one wasted `readdir`, which
is the cheaper mistake by far.

`ghq root` is spawned for authority rather than reimplemented, because ghq
supports multiple roots and reads them from three places. The `$GHQ_ROOT` and
`~/ghq` fallbacks exist so the feature still works when ghq is not installed;
`~/ghq` is ghq's own documented default, not a guess of ours.

**ghq is an optional dependency and must not join the `ensureTool` checks.**
I1b requires git because without it gwq reports zero worktrees for a user who
has 44, which is a wrong answer delivered silently. Missing ghq is not that: it
means there is no ghq tree to search, so the `claude` source contributes
nothing and every other source still returns exactly what it returns today.
Degrading to today's correct behavior does not deserve exit 127.

### The walk

`walkWorktrees` gains one option, `emitAs`, and one behavior. (Drafted as a
boolean `includeRoots`; it became `emitAs` during implementation, because the
same argument has to carry *which* source labels the pruned directory, and two
fields where one will do rot apart.)

At a prune point — a directory containing `.git` — it now always peeks at
`<dir>/.claude/worktrees`, keeps the children that contain a `.git` of their
own, and recurses into each child's own `.claude/worktrees` under the same
depth guard, because an agent can start an agent. It still never descends into
the repository itself.

The pruned directory is pushed as a candidate only when `emitAs` is non-null.
The ghq root is walked with `emitAs: null`: those directories are main clones,
and a main clone is `ghqcd`'s job, not this tool's. Walking `~/ghq` without
that would add 44 entries nobody asked for and would silently turn `gwqcd`
into a worse `ghqcd`.

### Fallback

If all three roots together yield nothing, `gwqcd` falls back to
`gwq list -g --json` exactly as it does today, and I7's three-way split between
an empty list, a broken `--json` contract, and a genuine failure is untouched.

### Flags

```
--source <list>   limit to these sources: gwq | claude | herdr | other | all
                  comma-separated, default all
```

An unknown value is `E_VALIDATION` and the message lists the valid ones.
`--source` filters on the source property, so it composes with `--local`,
`--no-main`, `--list` and a query without any special cases.

`--source gwq` is the escape hatch for someone who finds a dozen agent
worktrees noisy in the picker. A shell alias makes it permanent, so no
environment variable is added for it.

### Schema

Both payloads gain a `source` field. I9 permits additive growth, so
`schemaVersion` stays at 1.

```json
{"schemaVersion":1,"path":"…","branch":"…","commit":"…","isMain":false,"source":"claude","matches":1}
```

```json
{"schemaVersion":1,"count":2,"worktrees":[{"path":"…","branch":"…","commit":"…","isMain":false,"source":"gwq"}]}
```

Source is resolved as lazily as metadata already is. Global discovery knows it
for free, by construction. `--local` learns its paths from git, which has no
notion of a source, so there the label has to be derived from the path against
the known roots. The herdr root and the `.claude/worktrees` test are free; the
`gwq` label costs the one `gwq config get` spawn. That spawn is paid only when
a source label is actually printed or filtered on, which means `--json` or an
explicit `--source`, and never for a plain `--local` or `--local --quiet`.

### What does not change

The fzf display stays one path per line. The path still encodes everything a
column would: `…/alchemy/.claude/worktrees/adaptive-hugging-horizon` and
`~/.herdr/worktrees/gwqcd/worktree-brave-meadow-2b28` both name their tool,
their repository and their slug. The rejection of a richer display in CLAUDE.md
survives this change intact.

Exit codes, I1's stdout discipline, the three-step binary resolver, `--no-main`
and the emitted shell functions are all untouched.

## The branch name is still not the directory name

I8 said the directory slug is lossy and the branch has to travel from the
payload. Both new sources make that sharper, and both were verified on real
worktrees:

- `claude -w` names a directory `drifting-giggling-pond` and checks out
  `fix/editor-chat-domain-guide`. There is no relationship between the two.
- One `agent-…` worktree is on a detached HEAD and has no branch at all.
- herdr names a directory `worktree-brave-meadow-2b28` and checks out
  `worktree/brave-meadow-2b28`. The slash is flattened to a dash, which is
  exactly I8's original failure re-run on a new tool.

Metadata still comes from one `git rev-parse` per worktree, sixteen at a time,
resolved only for what gets printed.

## Performance

Measured on this machine: 44 ghq repositories, 115 gwq worktrees, 11 from
`claude -w`, 1 from herdr.

These were the design-time estimates, taken from a standalone harness:

| step                                            | estimate  |
| ----------------------------------------------- | --------- |
| `gwq config get` and `ghq root`, concurrent     | 45ms      |
| walk `~/ghq`, prune at `.git`, peek `.claude`   | 9ms       |
| walk gwq basedir                                | 20ms      |
| walk `~/.herdr/worktrees`                       | 1ms       |
| **discovery, all three roots**                  | **75ms**  |
| for contrast: `gwq list -g --json`              | 43,756ms  |

**Measured afterwards, inside the real binary, they were wrong.** Probes around
`ensureTool` and `discoverWorktrees`, medians of six `--list` runs:

| step                                            | measured  |
| ----------------------------------------------- | --------- |
| root resolution, concurrent                     | 55ms      |
| the three walks, including the `.claude` peeks  | 50ms      |
| **discovery, all three roots**                  | **102ms** |
| `ensureTool`, three `--version` spawns          | 45ms      |
| a jump, `--quiet <query>`, end to end           | 180ms     |
| `--list --json`, 128 `rev-parse` 16 at a time   | 870ms     |

The estimates understated the walks by 20ms, because the standalone harness ran
with a warm cache and without the `existsSync` peek per candidate. The larger
mistake was a claim this document made and CLAUDE.md repeated: that
`ensureTool` dominated a jump at "about 120ms of 220ms". That figure was never
probed — it was the remainder after subtracting the estimates from a wall clock,
and it was off by 2.7×. Instrumented, discovery is the larger term in every
run.

The genuine finding, once measured, is narrower and more useful: **`ghq root`
alone is 52ms**, half of discovery, against 11ms for `gwq config get`. Not
spawning ghq at all — reading `$GHQ_ROOT`, then `git config --get-all
ghq.root`, then `~/ghq` — would cost about 11ms and was rejected above on
authority grounds. That is the trade to revisit, not `ensureTool`.

## Testing

The shim-based suite grows a real fixture rather than more shims, because the
peek, the pruning and the `includeRoots` distinction are all filesystem
behavior that a shim cannot express.

The fixture builds a real repository with a real linked worktree under each of
the three roots, plus a `claude -w` worktree nested inside a `claude -w`
worktree, plus the existing vendored-submodule decoy.

New cases:

1. `claude -w` worktrees are listed, and carry `source: "claude"`.
2. herdr worktrees are listed, and carry `source: "herdr"`.
3. Main clones under the ghq root are **not** listed. This is the regression
   that would turn `gwqcd` into a bad `ghqcd`.
4. A nested `claude -w` worktree inside a `claude -w` worktree is found.
5. `.claude/worktrees/<junk>` without a `.git` is not listed.
6. `--source gwq` excludes the other two; `--source claude,herdr` excludes gwq.
7. An unknown `--source` value is `E_VALIDATION` and names the valid values.
8. Overlapping roots list each worktree once.
9. herdr's `worktree-x-y` directory reports branch `worktree/x/y`, the I8 case.
10. With no `ghq` on PATH the gwq source still returns everything, and exit 127
    is not raised.

The interactive fzf UI stays in CLAUDE.md's manual matrix, which gains a row
for picking a `claude -w` worktree.

## Out of scope

- **Creating** worktrees in any of the new layouts. `gwqpull` creates; this
  navigates. The split in CLAUDE.md holds.
- **Removing** them, including the tempting "clean up finished agent
  worktrees". Destructive, and `--source claude` plus `git worktree remove` is
  the user's call to make deliberately.
- Repositories outside ghq's root. `gwqcd` is a ghq and gwq tool; a
  `~/dev/project` with agent worktrees inside is not found, and the help text
  says where the search happens.
- A configurable herdr directory. herdr exposes no setting for it, so there is
  nothing to read. If it grows one, this becomes a one-line change.

## Incidental fixes carried by this change

Two real bugs in files this work already touches:

- `.claude/skills/gwqcd/SKILL.md` tells agents to run `npx -y gwqcd@^0.1`.
  That range cannot resolve anything above 0.1.x, so every agent following the
  skill has been running a version from before I7b's fast path existed. Pinned
  to `^0.3`.
- `.claude/worktrees/` is not in `.gitignore`, so every `claude -w` worktree
  shows up as untracked in `git status` in this repository. Added.
