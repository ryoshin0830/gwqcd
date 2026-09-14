# gwqcd

Pick a git worktree with [fzf](https://github.com/junegunn/fzf) and `cd` into it — the ones
[gwq](https://github.com/d-kuro/gwq), `claude -w`,
[herdr](https://herdr.dev), and Codex App make.

```console
$ gwqcd
  worktree>
  ▌ /Users/you/worktrees/github.com/you/api/feat-login
    /Users/you/worktrees/github.com/you/api/fix-cache
    /Users/you/ghq/github.com/you/api/.claude/worktrees/drifting-giggling-pond
    /Users/you/.herdr/worktrees/api/worktree-brave-meadow-2b28
    /Users/you/.codex/worktrees/4e86/api
  ╭───────────────────────────────────────╮
  │ 8f2c1a9 Add the login form            │
  │ 3b7d004 Wire up the session store     │
  ╰───────────────────────────────────────╯
$ pwd
/Users/you/worktrees/github.com/you/api/feat-login
```

## Install

```sh
npm install -g gwqcd
```

Then add the shell integration:

```sh
# zsh  — ~/.zshrc
eval "$(command gwqcd --init zsh)"

# bash — ~/.bashrc
eval "$(command gwqcd --init bash)"

# fish — ~/.config/fish/config.fish
command gwqcd --init fish | source
```

`command` matters: each tool defines a shell function with its own name, so on a
second `source ~/.zshrc` the *function* would answer, capture the `--init` output
and try to `cd` into it. `command` skips functions and goes to the binary.

Reload the shell and `gwqcd` moves it.

Prefer a different name? `eval "$(gwqcd --init zsh --cmd wcd)"` gives you `wcd`.

### Without installing

```sh
eval "$(npx -y gwqcd --init zsh)"
```

The emitted function resolves its binary in three steps — `gwqcd` on `PATH`,
then the script that generated the snippet, then `npx -y gwqcd@<version>` — so
it keeps working after npm garbage-collects the npx cache. It is still worth a
global install: `npx` adds about a second to every jump.

Requires `git`, `gwq` and `fzf` on `PATH` (`brew install git fzf d-kuro/tap/gwq`),
and Node >= 20.12. **No `jq`.** `ghq` is optional — see below.

## Where it looks

| source | location | created by |
| --- | --- | --- |
| `gwq` | `gwq config get worktree.basedir` | `gwq add` |
| `claude` | `<repo>/.claude/worktrees/<slug>` | `claude -w` |
| `herdr` | `~/.herdr/worktrees/<repo>/<slug>` | `herdr worktree create` |
| `codex` | `$CODEX_HOME/worktrees/<id>/<repo>` (default `~/.codex/worktrees`) | Codex App |
| `other` | anywhere else | only ever seen with `--local` |

`--source` takes a comma-separated list, so `--source claude,herdr,codex`
selects all discovered agent worktrees. Use `--source codex` for Codex alone.

Codex discovery uses a nonempty `CODEX_HOME` when set (including `~/…`),
otherwise `~/.codex`. It searches the `worktrees` child of that directory.
Missing or unreadable roots are skipped; no Codex CLI is required. Codex paths
keep their `codex` source even when the gwq base directory contains that root.
Claude worktrees nested inside them retain the `claude` source.

`claude -w` puts its worktree *inside* the repository it belongs to, so `gwqcd`
looks inside every repository under `ghq root` — and inside every worktree it
already found, because an agent can start an agent. It never descends into a
repository past that one directory, keeping discovery independent of the size
of checked-out source files and dependencies.

`ghq` is optional. Roots come from `ghq root --all`, falling back to `GHQ_ROOT`
and then `~/ghq`. Claude worktrees are also found inside worktrees under the
gwq, Herdr, and Codex roots. A repository somewhere else entirely, say
`~/dev/project`, is not searched globally; `--local` asks Git for all worktrees
of the current repository regardless of location.

`--source gwq` gives you a picker with no agent worktrees in it.

### Speed

`gwq list -g` shells out to git for every entry it finds under the base
directory, including files inside worktrees: **43.7 seconds** on 115 worktrees
here, up from 7.6 seconds when that was last measured in August as worktrees
accumulated. `gwqcd` walks its configured roots instead and stops at each worktree,
then asks git for branch and commit only for the entries it is about to print.
The following measurements predate Codex support (2026-09-09): about **150ms**
for a jump — roughly 94ms of discovery, 38ms of
checking that git, gwq and fzf exist, and 33ms of node starting up.

`--list --json` is the expensive mode, near 640ms, because it pays one
`git rev-parse` per worktree (sixteen at a time) to fill in every branch and
commit. Interactive picking resolves metadata only for the one worktree it
prints.

With Codex support on 2026-09-14, six runs of `node bin/gwqcd.mjs --list`
had a median of **196.5ms** for 141 worktrees, compared with **224.5ms** for
139 entries before the change. These are whole-command measurements on one
machine; cache and scheduling variation mean this is not a speedup guarantee.

## Why `--init` exists

A child process cannot change its parent shell's working directory. `npx gwqcd`
therefore can only *print* where you wanted to go — which it does, in a
copyable box:

```console
$ npx gwqcd login
   branch: feat/login
╭─ next ──────────────────────────────────────────────────╮
│                                                         │
│  cd "/Users/you/worktrees/github.com/you/api/feat-login" │
│                                                         │
╰─────────────────────────────────────────────────────────╯
   press c to copy · any other key to exit
```

`--init` emits a shell *function*, and a function runs inside your shell, so it
can `cd`. This is the same mechanism [zoxide](https://github.com/ajeetdsouza/zoxide)
and [starship](https://starship.rs) use.

## Usage

```
gwqcd [options] [<query>]
```

| Option | Meaning |
| --- | --- |
| `--init <shell>` | print shell integration for `zsh` \| `bash` \| `fish` |
| `--cmd <name>` | function name emitted by `--init` (default: `gwqcd`) |
| `--query <q>` | initial fzf query (same as the positional) |
| `--local` | only the current repository's worktrees (default: all) |
| `--no-main` | hide main worktrees, leaving only linked ones |
| `--source <list>` | comma-separated `gwq` \| `claude` \| `herdr` \| `codex` \| `other` \| `all` (default: `all`) |
| `--list` | print every candidate instead of picking one |
| `--json` | stdout = 1-line JSON, never opens the fzf UI |
| `--quiet` | stdout = path only |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |
| `-h`, `--help` | show help |
| `-V`, `--version` | show version |

A query pre-filters fzf and auto-selects a unique match, so `gwqcd login`
usually lands without a keystroke.

## For scripts and AI agents

`--json` never opens a UI, so it is safe in a pipeline or an agent session.

```console
$ gwqcd --json login
{"schemaVersion":1,"path":"/Users/you/worktrees/github.com/you/api/feat-login","branch":"feat/login","commit":"8f2c1a9…","isMain":false,"source":"gwq","matches":1}

$ gwqcd --list --json --no-main
{"schemaVersion":1,"count":2,"worktrees":[{"path":"…","branch":"…","commit":"…","isMain":false,"source":"claude"}]}
```

`branch` is the real ref name, which the directory slug does not always carry —
`feat/login` lives in a directory called `feat-login`, and `claude -w` named a
directory `drifting-giggling-pond` for a branch called
`fix/editor-chat-domain-guide`. Codex App can create detached worktrees:
their `branch` is `""`, while `commit` is the actual Git commit hash.

`source` names the tool whose convention created the worktree. A `claude`,
`herdr`, or `codex` worktree was handed to another agent session, so `--source gwq` is the
safer request when you need somewhere to work.

`matches` tells you whether the query was unique — `> 1` means the best-scoring
candidate was returned but the query was ambiguous.

Errors go to stderr as JSON, and stdout stays empty:

```console
$ gwqcd --json nope
{"schemaVersion":1,"error":{"code":"E_NO_MATCH","message":"no worktree matched 'nope'"},"exitCode":2}
```

| Exit | Code | Meaning |
| --- | --- | --- |
| 0 | — | success |
| 1 | `E_VALIDATION`, `E_GWQ`, `E_FZF` | bad flags, or an upstream command failed |
| 2 | `E_NO_MATCH` | no worktrees, or the query matched none |
| 3 | `E_AMBIGUOUS` | non-interactive with no query — pass one, or use `--list` |
| 127 | `E_DEPS` | `git`, `gwq` or `fzf` not installed |
| 130 | `E_INTERRUPTED` | Esc or Ctrl-C in fzf |

Cancelling the picker exits 130 silently — no error line lands above your next
prompt.

## Related

- [`ghqcd`](https://github.com/ryoshin0830/ghqcd) — same idea for [ghq](https://github.com/x-motemen/ghq) repositories
- [`gwqpull`](https://github.com/ryoshin0830/gwqpull) — clone with ghq, add a gwq worktree, and cd into it
- [`gwqadd`](https://github.com/ryoshin0830/gwqadd) — create a branch and its gwq worktree in the repo you are in
- [`ghnew`](https://github.com/ryoshin0830/ghnew) — create a GitHub repo, ghq-get it, and cd into it

## License

MIT © ryoshin0830
