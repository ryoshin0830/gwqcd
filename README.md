# gwqcd

Pick a git worktree managed by [gwq](https://github.com/d-kuro/gwq) with [fzf](https://github.com/junegunn/fzf) and `cd` into it.

```console
$ gwqcd
  worktree>
  ▌ /Users/you/worktrees/github.com/you/api/feat-login
    /Users/you/worktrees/github.com/you/api/fix-cache
    /Users/you/worktrees/github.com/you/web/main
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
eval "$(gwqcd --init zsh)"

# bash — ~/.bashrc
eval "$(gwqcd --init bash)"

# fish — ~/.config/fish/config.fish
gwqcd --init fish | source
```

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

Requires `gwq` and `fzf` on `PATH` (`brew install fzf d-kuro/tap/gwq`), and
Node >= 20.12. **No `jq`** — `gwq --json` is parsed in-process.

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
{"schemaVersion":1,"path":"/Users/you/worktrees/github.com/you/api/feat-login","branch":"feat/login","commit":"8f2c1a9…","isMain":false,"matches":1}

$ gwqcd --list --json --no-main
{"schemaVersion":1,"count":2,"worktrees":[{"path":"…","branch":"…","commit":"…","isMain":false}]}
```

`branch` is the real ref name, which the directory slug does not always carry —
`feat/login` lives in a directory called `feat-login`.

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
| 127 | `E_DEPS` | `gwq` or `fzf` not installed |
| 130 | `E_INTERRUPTED` | Esc or Ctrl-C in fzf |

Cancelling the picker exits 130 silently — no error line lands above your next
prompt.

## Related

- [`ghqcd`](https://github.com/ryoshin0830/ghqcd) — same idea for [ghq](https://github.com/x-motemen/ghq) repositories
- [`gwqget`](https://github.com/ryoshin0830/gwqget) — clone with ghq, add a gwq worktree, and cd into it
- [`ghnew`](https://github.com/ryoshin0830/ghnew) — create a GitHub repo, ghq-get it, and cd into it

## License

MIT © ryoshin0830
