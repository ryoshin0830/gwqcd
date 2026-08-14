# CLAUDE.md

Guidance for any AI agent (Claude Code, Codex, opencode, etc.) that works
**inside** this repository.

This file is for **maintainers of `gwqcd`**. To USE gwqcd from an agent session,
see `.claude/skills/gwqcd/SKILL.md` and the "For scripts and AI agents" section
of `README.md` instead.

---

## What this package does

A small Node.js CLI (~650 lines, zero runtime dependencies) that:

1. Runs `gwq list -g --json` (or `gwq list --json` with `--local`) and parses it
   in-process.
2. Picks one worktree — interactively via `fzf`, or non-interactively via
   `fzf --filter`.
3. Prints the chosen path: as a `cd "…"` box (default), one bare line
   (`--quiet`), or one line of JSON (`--json`).
4. Emits a shell function on `--init <shell>` so the *shell* performs the `cd`.

Single source of behavior: `bin/gwqcd.mjs`.

Sibling packages built to the same contract: `ghqcd`, `gwqpull`, `ghnew`. The
invariants below are deliberately near-identical to `ghqcd`'s; when you change
one, check whether the other needs the same change.

---

## Invariants (do not break)

### I1. stdout / stderr discipline

- **stdout** is for machine-readable output **only**: the `--quiet` path, the
  `--json` payload, the `--list` lines, the `--init` shell snippet, and the
  `--help`/`--version` body.
- **stderr** is for everything else: the branch line, the `cd` box, the keypress
  prompt, ANSI cursor restore, every error message.
- `gwqcd > out.txt` MUST leave the human-facing box on the terminal and
  `out.txt` empty.

This is not cosmetic. `--quiet` stdout is consumed by `$(…)` inside the
generated shell function; anything else on that stream becomes part of the path
the shell tries to `cd` into.

### I2. `--init` is a flag, not a subcommand

`gwqcd init zsh` would be ambiguous in the sibling `gwqpull`, whose positional is
a repository spec. All four tools in this family therefore spell it
`--init <shell>`. Do not "fix" this to match zoxide.

### I3. The generated function resolves its binary in three steps

`PATH` → the absolute path of the script that generated the snippet →
`npx -y gwqcd@<version>`. Each step exists for a reason:

- **PATH first** so a global install wins and picks up upgrades.
- **Baked path second** so `eval "$(npx -y gwqcd --init zsh)"` works at all.
- **npx last** because npm garbage-collects `~/.npm/_npx/<hash>/`, and without
  this step the user's shell silently loses the command.

The lookup MUST be PATH-only (`whence -p` / `type -P` / `command -s`). The
emitted function shares its name with the binary by default, so a
function-aware lookup (`command -v`, `which` in some shells) finds the function
and recurses until the shell dies.

### I4. fzf's UI does not travel on stdout

`fzf` draws on `/dev/tty` and writes only the selection to stdout. That is why
the interactive picker still works when our own stdout is a pipe — which is the
normal case, since the shell function captures it. Spawn fzf with
`stdio: ['pipe', 'pipe', 'inherit']` and never with `'inherit'` on fd 1.

### I5. `--quiet` stays interactive; `--json` does not

`--quiet` is the shell function's mode: it must still open the fzf UI. Only
`--json` — and the absence of any TTY — forces the non-interactive
`fzf --filter` path. Do not collapse the two into one "non-interactive" flag.

`isNonInteractive` gates our *own* prompts (the brew-install confirm, the
clipboard keypress), never fzf.

### I6. Cancelling is not an error

fzf exits 130 on Esc / Ctrl-C. `die('E_INTERRUPTED', …)` deliberately writes
**nothing** to stderr in non-JSON mode: cancelling the picker is the single most
common way this program ends, and a red line above the user's next prompt every
time is noise. The exit code still propagates.

### I7. `gwq list --json` is not always JSON

With no worktrees, gwq abandons the `--json` contract and prints a plain-text
sentence. The zsh original coped by piping both gwq and jq through
`2>/dev/null`, which also swallowed real failures.

`listWorktrees()` keeps the three cases apart:

- exit 0 and output that does not start with `[` → **empty list**
- exit 0 and output that starts with `[` but does not parse → **`E_GWQ`**, because
  that is gwq breaking its own contract and silence would hide it
- non-zero exit → **`E_GWQ`**, except `--local` outside a repository (`not a git
  repository` on stderr), which is a normal miss and yields an empty list

Do not collapse these back into one `catch {}`.

### I8. The branch name comes from gwq, not from the path

`feat/login` is checked out in a directory named `feat-login`. The slug is
lossy, so `branch` must be carried from the gwq payload through to the output —
never re-derived from the path. This is the concrete thing the old
`jq -r '.[].path'` pipeline threw away.

### I9. `--json` schema (external contract)

Selection:

```json
{
  "schemaVersion": 1,
  "path":          "<absolute-worktree-path>",
  "branch":        "<ref name, may contain slashes>",
  "commit":        "<full commit hash>",
  "isMain":        true | false,
  "matches":       <number of candidates the query matched>
}
```

Listing (`--list --json`):

```json
{
  "schemaVersion": 1,
  "count":         <number>,
  "worktrees":     [{ "path": "…", "branch": "…", "commit": "…", "isMain": false }]
}
```

Error (stderr, exit ≠ 0):

```json
{ "schemaVersion": 1, "error": { "code": "E_*", "message": "…" }, "exitCode": <number> }
```

Note the rename from gwq's own field names: `commit_hash` → `commit`,
`is_main` → `isMain`. Our schema is camelCase and independent of gwq's; do not
pass gwq's objects through untranslated.

`matches` exists so a caller can detect that it got the best-scoring candidate
of several rather than a unique hit. Adding fields is fine; removing or
renaming requires a `schemaVersion` bump.

stderr *carries* the error line; it is not exclusively JSON. Node warnings and
child diagnostics share the stream. Consumers — including our own tests — must
select the line starting with `{`, never parse the whole stream.

### I10. Exit codes

| Code | Constant        | Meaning                                          |
|------|-----------------|--------------------------------------------------|
| 0    | —               | success                                          |
| 1    | `E_VALIDATION`  | flag conflict, extra positional, parseArgs error |
| 1    | `E_GWQ`         | gwq failed, or broke its own `--json` contract   |
| 1    | `E_FZF`         | fzf could not be run, or exited unexpectedly     |
| 2    | `E_NO_MATCH`    | no worktrees, or the query matched none          |
| 3    | `E_AMBIGUOUS`   | non-interactive with no query                    |
| 127  | `E_DEPS`        | `gwq`/`fzf` missing and user declined install    |
| 130  | `E_INTERRUPTED` | Esc / Ctrl-C                                     |

### I11. Zero runtime dependencies

`ghnew` depends on `@inquirer/prompts`; this package deliberately does not.
`gwqcd` runs on the interactive hot path — every dependency is npx cold-start
latency and typosquat surface. The one prompt we need (`confirmYesNo`) is
fifteen lines over the raw-mode keypress reader we already have.

`jq` is likewise gone: it was a hard runtime dependency of the zsh original and
is now `JSON.parse`.

### I12. Raw mode cleanup

`process.stdin.setRawMode(true)` is guarded by `stdin.isTTY`. Cleanup runs on
`exit`, `SIGTERM`, `SIGHUP`, `uncaughtException`, and inside `try/finally`.
Cursor restore (`\x1b[?25h`) is guarded by `stderr.isTTY` to prevent escape
bytes leaking into files.

### I13. Engines

`engines.node >= 20.12.0` for `node:util` `parseArgs` and import attributes in
the tests. Do not lower.

---

## Do NOT

- Add `preinstall` / `postinstall` scripts to `package.json` (Shai-Hulud worm
  infection vector). `npm install --ignore-scripts` must work.
- Remove `.claude/` or `CLAUDE.md` from `.npmignore`. Those files are for agents
  and maintainers, not end users; bundling them inflates the tarball and widens
  the typosquat blast radius.
- Use `console.log` for human output. Use `stderr.write(...)`. `console.log`
  goes to stdout and violates I1.
- Reintroduce a `jq` dependency, or any runtime dependency (see I11).
- Skip the TTY guard before `setRawMode`. It throws on non-TTY streams.
- Reintroduce a `const VERSION = '…'` literal. `npm version` only bumps the
  manifest, so a literal drifts and `--version` names a build nobody is running.

---

## Release workflow

```sh
git add -A && git commit -m "feat: …"
npm pack --dry-run          # must not contain .claude/, CLAUDE.md, test/, .git/
npm version patch           # or minor / major — commits and tags
git push --follow-tags
npm publish                 # prompts for passkey/OTP via the npm web auth flow
npm view gwqcd version
npx -y gwqcd@latest --version
```

`prepublishOnly` runs `npm test && npm pack --dry-run && node bin/gwqcd.mjs --help`
to catch broken shebangs and missing files before they hit the registry.

Publishing needs `registry.npmjs.org` credentials. If the machine's `.npmrc`
points `registry=` at a private mirror, publish with
`npm publish --registry=https://registry.npmjs.org`.

---

## Testing

`npm test` runs `test/cli.test.mjs` (`node:test`, no network, no TTY) with `gwq`
and `fzf` shims on `PATH`. It covers every code path reachable without a
terminal — including all four I7 branches and the I8 branch-name case — plus
`zsh -n` / `bash -n` / `fish -n` syntax checks on the `--init` output.

**Tests must be hermetic against the developer's own environment.** `run()`
deletes `FORCE_COLOR` from the child env because we set `NO_COLOR`, and node
warns to stderr when it sees both — which made the suite fail on a machine that
exported `FORCE_COLOR`, and only at `npm publish` time via `prepublishOnly`.
Assertions that stderr is empty go through `ourStderr()`, which strips
`(node:NNN) Warning:` lines first. Never assert on raw `r.stderr` being `''`:
stderr is a shared stream, and node's warnings are not ours to control.

The interactive fzf UI cannot be tested there. Run these by hand:

| Scenario | Command | Expect |
| --- | --- | --- |
| Interactive pick | `gwqcd` | fzf opens, Enter lands the shell in the worktree |
| Unique query | `gwqcd <unique>` | lands with no keystroke (`--select-1`) |
| Cancel | `gwqcd`, press Esc | exit 130, shell stays put, no error line |
| Ctrl-C | `gwqcd`, press Ctrl-C | exit 130, cursor restored |
| Preview pane | `gwqcd` | right pane shows `git log --oneline -10` |
| `--local` inside a repo | `gwqcd --local --list` | only that repo's worktrees |
| `--local` outside a repo | `gwqcd --local --list` | "no worktrees", exit 2 |
| npx one-shot | `npx gwqcd <q>` | branch line + box, `c` copies the cd command |
| Stdout separation | `gwqcd login > out.txt` | box on terminal, `out.txt` empty |
| No fzf | `PATH=/usr/bin gwqcd` | offers `brew install fzf`, exit 127 if declined |
| Reinstall drift | delete `~/.npm/_npx`, then `gwqcd` | still works via the npx fallback (I3) |

A pty harness (`script -q /dev/null zsh -c '…'`) can automate the `--select-1`
case, and that one is worth running after touching I3 or I4. Do **not** try to
drive the interactive fzf UI by piping keystrokes into `script` — fzf reads
`/dev/tty`, the writes do not reach it, and the harness hangs until killed.

---

## Where things live

- `bin/gwqcd.mjs` — the entire CLI (ESM, top-level await OK).
- `package.json` — `bin.gwqcd`, `engines.node`, `files`, `prepublishOnly`.
- `.npmignore` — defense-in-depth complement to `files`.
- `.claude/skills/gwqcd/SKILL.md` — agent USE contract. Changing it is a
  user-visible interface change; document it in the commit.
- `README.md` — end-user docs.
- `test/cli.test.mjs` — shim-based CLI tests.

---

## Things that are intentionally NOT here

- **Creating worktrees.** `gwqcd` navigates; `gwqpull` creates. Keep the split.
- **Deleting worktrees.** `gwq remove` exists and is destructive; wrapping it
  behind a fuzzy picker is a foot-gun.
- **A richer fzf display** (repo + branch columns via `--with-nth`). The path
  already encodes host, owner, repo and branch slug, and the extra columns
  would have to guess the worktree base directory to be readable.
- **A prompt library, a logger, or a clipboard package.** See I11.
- **Telemetry / analytics.**
