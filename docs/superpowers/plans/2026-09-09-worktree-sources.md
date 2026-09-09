# Worktree Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gwqcd` find the worktrees `claude -w` and herdr create, not just the ones gwq creates, without giving up the millisecond discovery path.

**Architecture:** Discovery walks three roots instead of one. `claude -w` worktrees live inside main worktrees, which is exactly where the walk prunes, so the walker peeks at `<dir>/.claude/worktrees` at the instant it prunes and never descends. Each worktree carries a `source` assigned at discovery time, exposed as an additive JSON field and filterable with a new `--source` flag.

**Tech Stack:** Node.js >= 20.12, zero runtime dependencies, `node:test`. One file: `bin/gwqcd.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-09-worktree-sources-design.md`

## Global Constraints

- **Zero runtime dependencies.** No package may be added to `package.json` (I11).
- **No `preinstall` / `postinstall` scripts**, ever (Shai-Hulud vector).
- **stdout is machine-readable only.** Human output goes to `stderr.write`, never `console.log` (I1).
- **`engines.node` stays `>=20.12.0`.** Do not lower it (I13).
- **ghq must NOT be added to `ensureTool`.** It is optional; its absence means the `claude` source is empty, which is today's correct behavior, not exit 127.
- **`schemaVersion` stays `1`.** `source` is an additive field, which I9 permits.
- **Existing exit codes are unchanged.** `--source` errors are `E_VALIDATION`, exit 1.
- **Tests must be hermetic.** `run()` deletes `FORCE_COLOR`; assertions on our own stderr go through `ourStderr()`, never raw `r.stderr`.
- **Never write a CI skip token in a commit message.** Every push to main releases; these commits land on a branch.
- Node imports needed across tasks: add `existsSync`, `realpathSync` to the `node:fs` import and `sep` to the `node:path` import.

---

### Task 1: The walker peeks where it prunes

Teaches the existing walk to find `claude -w` worktrees inside any worktree it already finds, and moves discovery from bare paths to `{ path, source }` records so later tasks have somewhere to put the label.

**Files:**
- Modify: `bin/gwqcd.mjs` — the `node:fs` / `node:path` imports, `walkWorktrees`, `discoverWorktrees`, and the `found` handling at the top of `main`
- Test: `test/cli.test.mjs` — replace `realBasedir` with `realHome`, replace `basedirShim` with `homeShim`, extend `run()`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `walkWorktrees(dir, { emitAs, depth = 0, out = [] }) -> Array<{path: string, source: string}>` — `emitAs` is the source string to label the pruned directory with, or `null` to peek only and not emit it.
  - `collectClaudeWorktrees(repo: string, depth: number, out: Array) -> void`
  - `discoverWorktrees() -> Promise<{ paths: string[], sources: Map<string,string|null>, meta: Map<string,object> }>`
  - Test helpers `realHome()` and `homeShim({ base, ghqRoot, withGhq })`, and `run(args, { shims, cwd, env })`.

- [ ] **Step 1: Write the failing tests**

Replace the whole `── the fast discovery path ──` section of `test/cli.test.mjs` (currently `realBasedir`, `basedirShim` and the five tests that use them) with this. It keeps every existing assertion and adds the new ones.

```js
// ── the fast discovery path ──────────────────────────────────────────────────
//
// `gwq list -g` took 43.7 seconds on this machine's 115 worktrees; walking the
// roots takes 30ms. These tests build a real home with real repositories,
// because the walk, the pruning, the .claude peek and the metadata all come
// from the filesystem and from git — a shim cannot express any of it.
//
// Layout, and what must come out of it:
//
//   $HOME/ghq/host/owner/repo                     main clone  — NOT listed
//     .claude/worktrees/drifting-giggling-pond    claude      — listed
//       .claude/worktrees/quizzical-jumping-tome  claude      — listed (nested)
//     .claude/worktrees/agent-aed5fc34            claude      — listed, detached
//     .claude/worktrees/notes                     no .git     — NOT listed
//   $HOME/worktrees/host/owner/repo/feat-one      gwq         — listed
//     .claude/worktrees/season-amazing-net        claude      — listed
//     vendor/dep                                  nested repo — NOT listed
//   $HOME/.herdr/worktrees/repo/worktree-brave-meadow-2b28
//                                                 herdr       — listed

function realHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-home-')));
  const ghqRoot = join(home, 'ghq');
  const base = join(home, 'worktrees');
  const repo = join(ghqRoot, 'host', 'owner', 'repo');
  const g = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };

  mkdirSync(repo, { recursive: true });
  mkdirSync(base, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@e.com');
  g(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'init');

  // gwq's layout: nested under host/owner/repo the way its template produces.
  const wtDir = join(base, 'host', 'owner', 'repo');
  mkdirSync(wtDir, { recursive: true });
  const gwqOne = join(wtDir, 'feat-one');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat/one', gwqOne);

  // The decoy that must not be walked into: files inside a worktree, including
  // a repository of its own. gwq reports these; they are not worktrees.
  const nested = join(gwqOne, 'vendor', 'dep');
  mkdirSync(nested, { recursive: true });
  g(nested, 'init', '-q', '-b', 'main');

  // `claude -w` inside a gwq worktree — the peek has to happen at every root,
  // not only under ghq.
  mkdirSync(join(gwqOne, '.claude', 'worktrees'), { recursive: true });
  g(repo, 'worktree', 'add', '-q', '-b', 'season-amazing-net',
    join(gwqOne, '.claude', 'worktrees', 'season-amazing-net'));

  // `claude -w` inside the main clone, which is where it normally lands.
  const cw = join(repo, '.claude', 'worktrees');
  mkdirSync(cw, { recursive: true });
  // The I8 case, verified against a real one: the directory says
  // drifting-giggling-pond and the branch says fix/editor-chat-domain-guide.
  g(repo, 'worktree', 'add', '-q', '-b', 'fix/editor-chat-domain-guide',
    join(cw, 'drifting-giggling-pond'));
  // A real `agent-…` worktree observed on a detached HEAD, so branch is ''.
  g(repo, 'worktree', 'add', '-q', '--detach', join(cw, 'agent-aed5fc34'));
  // Junk in .claude/worktrees is not a worktree.
  mkdirSync(join(cw, 'notes'), { recursive: true });
  writeFileSync(join(cw, 'notes', 'scratch.md'), '# not a worktree\n');
  // An agent can start an agent.
  mkdirSync(join(cw, 'drifting-giggling-pond', '.claude', 'worktrees'), { recursive: true });
  g(repo, 'worktree', 'add', '-q', '-b', 'sub/agent',
    join(cw, 'drifting-giggling-pond', '.claude', 'worktrees', 'quizzical-jumping-tome'));

  // herdr: ~/.herdr/worktrees/<repo>/<slug>. The slug flattens the slash, so
  // this is the I8 case again on a second tool.
  const herdr = join(home, '.herdr', 'worktrees', 'repo');
  mkdirSync(herdr, { recursive: true });
  g(repo, 'worktree', 'add', '-q', '-b', 'worktree/brave-meadow-2b28',
    join(herdr, 'worktree-brave-meadow-2b28'));

  return { home, ghqRoot, base, repo, sha: g(repo, 'rev-parse', 'HEAD') };
}

// A gwq that answers only `config get worktree.basedir`, and an ghq that
// answers only `root`. Anything else is the slow path, and reaching it here is
// the failure these tests exist to catch.
function homeShim({ base, ghqRoot, withGhq = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-hshim-'));
  const write = (name, body) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  };
  write('gwq', `#!/bin/sh
[ "$1" = "--version" ] && { echo "gwq version v0.1.1"; exit 0; }
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "${base}"; exit 0; fi
echo "gwq: slow path taken" >&2
exit 9
`);
  if (withGhq) {
    write('ghq', `#!/bin/sh
[ "$1" = "--version" ] && { echo "ghq version 1.6.2"; exit 0; }
[ "$1" = "root" ] && { echo "${ghqRoot}"; exit 0; }
exit 9
`);
  }
  write('fzf', `#!/bin/sh
[ "$1" = "--version" ] && { echo 0.74.1; exit 0; }
if [ "$1" = "--filter" ]; then out=$(grep -F -- "$2"); [ -n "$out" ] || exit 1; printf '%s\\n' "$out"; exit 0; fi
exit 2
`);
  return dir;
}

// Runs the CLI against a fixture home: HOME is redirected so the herdr root and
// every tilde expansion land inside the fixture. PATH is the shim dir *only*,
// so a real gwq or ghq on the developer's machine cannot leak in — git and node
// are found through the absolute paths spawnSync already uses for node and
// through /usr/bin for git.
function runIn(fx, args, { withGhq = true } = {}) {
  const shims = homeShim({ base: fx.base, ghqRoot: fx.ghqRoot, withGhq });
  try {
    return run(args, { shims, env: { HOME: fx.home } });
  } finally {
    rmSync(shims, { recursive: true, force: true });
  }
}

// Every path the fixture must yield, relative to $HOME, with its source.
const EXPECTED = [
  ['worktrees/host/owner/repo/feat-one', 'gwq'],
  ['worktrees/host/owner/repo/feat-one/.claude/worktrees/season-amazing-net', 'claude'],
  ['ghq/host/owner/repo/.claude/worktrees/agent-aed5fc34', 'claude'],
  ['ghq/host/owner/repo/.claude/worktrees/drifting-giggling-pond', 'claude'],
  ['ghq/host/owner/repo/.claude/worktrees/drifting-giggling-pond/.claude/worktrees/quizzical-jumping-tome', 'claude'],
  ['.herdr/worktrees/repo/worktree-brave-meadow-2b28', 'herdr'],
];

test('a `claude -w` worktree inside a gwq worktree is found', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.stdout.includes(join(fx.base, 'host/owner/repo/feat-one/.claude/worktrees/season-amazing-net')),
    r.stdout,
  );
  assert.doesNotMatch(r.stderr, /slow path/, 'gwq list must not be called');
});

test('the walk still prunes, so nested repositories are not listed', () => {
  // Descending into a worktree is what cost gwq its 43 seconds, and a vendored
  // submodule is not somewhere anyone wants to cd.
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  rmSync(fx.home, { recursive: true, force: true });
  assert.doesNotMatch(r.stdout, /vendor\/dep/);
});

test('junk in .claude/worktrees without a .git is not a worktree', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  rmSync(fx.home, { recursive: true, force: true });
  assert.doesNotMatch(r.stdout, /worktrees\/notes/);
});

test('an agent that started an agent is found', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  rmSync(fx.home, { recursive: true, force: true });
  assert.ok(r.stdout.includes('quizzical-jumping-tome'), r.stdout);
});

test('the gwq worktree and its branch still come back correct', () => {
  // `git rev-parse --abbrev-ref HEAD HEAD` abbreviates *both* revs, so the
  // first version of this shipped the branch name in the commit field.
  const fx = realHome();
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  const one = out.worktrees.find((w) => w.path.endsWith('feat-one'));
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(one.branch, 'feat/one');
  assert.match(one.commit, /^[0-9a-f]{40}$/, 'a sha, not the branch name');
  assert.equal(one.isMain, false, 'a linked worktree is not the main one');
});

test('an unreadable or absent basedir falls back to gwq rather than failing', () => {
  const shims = homeShim({ base: '/nonexistent/gwq/basedir', ghqRoot: '/nonexistent/ghq' });
  const empty = mkdtempSync(join(tmpdir(), 'gwqcd-emptyhome-'));
  const r = run(['--json', 'x'], { shims, env: { HOME: empty } });
  rmSync(shims, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
  // The shim's `list` exits 9, which is the fallback being reached — the point
  // is that it is reached at all rather than reporting an empty list.
  assert.equal(jsonLine(r.stderr).error.code, 'E_GWQ');
});
```

Then extend `run()` so it can override the environment, and widen the `node:fs` import at the top of the test file to include `realpathSync` (already there) and nothing else:

```js
function run(args, { shims, cwd, env } = {}) {
  const dir = shims ?? makeShims();
  const childEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, NO_COLOR: '1', ...env };
  // We force NO_COLOR; node itself warns to stderr when FORCE_COLOR is also
  // set, so a developer who exports it would otherwise see phantom failures.
  delete childEnv.FORCE_COLOR;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', env: childEnv, ...(cwd ? { cwd } : {}),
  });
  if (!shims) rmSync(dir, { recursive: true, force: true });
  return r;
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -30`

Expected: FAIL. The `season-amazing-net`, `quizzical-jumping-tome` and `notes` tests fail because nothing peeks into `.claude/worktrees` yet. `EXPECTED` is unused until Task 3, which is fine.

- [ ] **Step 3: Widen the imports**

In `bin/gwqcd.mjs`, replace the two import lines:

```js
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
```

- [ ] **Step 4: Replace `walkWorktrees` with the peeking version**

Replace the existing `walkWorktrees` function and its comment block with:

```js
// Prune at the worktree. Descending into one means walking node_modules and
// vendor trees, which is where gwq's own 43 seconds go.
//
// `claude -w` puts its worktree *inside* the repository, at
// .claude/worktrees/<slug> — precisely the place this walk refuses to enter. So
// at the moment of pruning, and only then, peek at that one directory. One
// readdir per repository, no descent, 9ms for the whole of a 44-repository ghq
// root.
//
// `emitAs` is the source to label the pruned directory with, or null to peek
// without emitting it. Null is what keeps main clones out of the results: the
// ghq root is walked to find what is *inside* its repositories, and a main
// clone is `ghqcd`'s job, not this tool's.
function walkWorktrees(dir, { emitAs, depth = 0, out = [] }) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable or vanished mid-walk
  }
  if (entries.some((e) => e.name === '.git')) {
    if (emitAs) out.push({ path: dir, source: emitAs });
    collectClaudeWorktrees(dir, depth, out);
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink()) {
      walkWorktrees(joinPath(dir, e.name), { emitAs, depth: depth + 1, out });
    }
  }
  return out;
}

// .claude/worktrees can hold anything the agent left behind, so only a
// directory with a `.git` of its own counts. Recurses because an agent can
// start an agent, under the same depth guard as the walk.
function collectClaudeWorktrees(repo, depth, out) {
  if (depth > 8) return;
  const base = joinPath(repo, '.claude', 'worktrees');
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return; // the common case by far: this repository has no agent worktrees
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const wt = joinPath(base, e.name);
    if (!existsSync(joinPath(wt, '.git'))) continue;
    out.push({ path: wt, source: 'claude' });
    collectClaudeWorktrees(wt, depth + 1, out);
  }
}
```

- [ ] **Step 5: Move `discoverWorktrees` to records**

Replace the existing `discoverWorktrees` function with the version below. It still walks only the gwq base directory; Tasks 2 and 3 add the other roots.

```js
// Returns { paths, sources, meta }. `sources` maps a path to the tool whose
// convention put it there, or null when it is not known yet (--local learns it
// lazily, in labelLocal). `meta` may start empty: filling it costs a git call
// per worktree, so callers ask for only what they print.
async function discoverWorktrees() {
  if (values.local) {
    const list = localWorktrees();
    return {
      paths: list.map((w) => w.path),
      sources: new Map(list.map((w) => [w.path, null])),
      meta: new Map(list.map((w) => [w.path, w])),
    };
  }

  const found = new Map(); // path -> source, first writer wins
  const basedir = await gwqBasedir();
  for (const root of usableRoots([{ dir: basedir, emitAs: 'gwq' }])) {
    for (const e of walkWorktrees(root.dir, { emitAs: root.emitAs })) {
      if (!found.has(e.path)) found.set(e.path, e.source);
    }
  }
  if (found.size) {
    return { paths: [...found.keys()], sources: found, meta: new Map() };
  }

  const list = gwqListJson(['list', '-g', '--json']);
  return {
    paths: list.map((w) => w.path),
    sources: new Map(list.map((w) => [w.path, 'gwq'])),
    meta: new Map(list.map((w) => [w.path, w])),
  };
}

// Each root is resolved through realpath so every path built from it is spelled
// one way, and roots that do not exist are dropped. Overlap between roots is
// handled where it actually shows up — by the first-writer-wins map above —
// rather than by dropping a root, which would lose whatever only that root
// could see.
function usableRoots(specs) {
  const out = [];
  for (const { dir, emitAs } of specs) {
    if (!dir) continue;
    try {
      out.push({ dir: realpathSync(dir), emitAs });
    } catch { /* absent or unreadable: not a root */ }
  }
  return out;
}
```

Make `gwqBasedir` async so Task 2 can overlap it with `ghq root`. Replace it with:

```js
// Async because Task 2's `ghq root` runs alongside it: these two subprocesses
// are the only slow part of discovery, and overlapping them makes the added
// wall-clock the slower of the two rather than their sum.
function capture(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

// gwq stores the tilde literally; it expands it, so we must too.
function expandTilde(v) {
  if (!v) return '';
  if (v === '~') return homedir();
  if (v.startsWith('~/')) return joinPath(homedir(), v.slice(2));
  return v;
}

async function gwqBasedir() {
  const out = await capture('gwq', ['config', 'get', 'worktree.basedir']);
  if (out == null) return '';
  return expandTilde(out.trim().split('\n')[0]?.trim() ?? '');
}
```

- [ ] **Step 6: Update the two call sites in `main`**

In `main`, replace the three lines that read `found` with:

```js
  const found = await discoverWorktrees();
  const byPath = found.meta;
  const sourceOf = found.sources;
  let paths = found.paths;
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -30`

Expected: PASS, all tests. If `--list --json` fails on a missing `source` key, that key does not exist yet — it arrives in Task 4, and no assertion in this task reads it.

- [ ] **Step 8: Commit**

```bash
git add bin/gwqcd.mjs test/cli.test.mjs
git commit -m "$(cat <<'MSG'
feat: find `claude -w` worktrees by peeking where the walk prunes

`claude -w` puts a real linked worktree at <repo>/.claude/worktrees/<slug>,
inside the main worktree — the one place I7b's walk deliberately refuses to
enter. One readdir at the instant of pruning finds them all without descending:
9ms for a 44-repository ghq root, against 43.7s for `gwq list -g --json`.

Discovery now carries a source per worktree rather than a bare path, so the
label has somewhere to live. The walker gained `emitAs`, which Task 2 needs to
walk a root for what is inside its repositories without listing the
repositories themselves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WXUj4zXDKWFivQrMprDYPX
MSG
)"
```

---

### Task 2: The ghq root

Adds the second root, so `claude -w` worktrees inside main clones are found. The main clones themselves must not appear.

**Files:**
- Modify: `bin/gwqcd.mjs` — add `ghqRoots`, extend the root list in `discoverWorktrees`, extend `HELP`
- Test: `test/cli.test.mjs` — add four tests to the fast-discovery section

**Interfaces:**
- Consumes: `capture`, `expandTilde`, `usableRoots`, `walkWorktrees` from Task 1; the `realHome` / `homeShim` / `runIn` helpers.
- Produces: `ghqRoots() -> Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

Append to the fast-discovery section of `test/cli.test.mjs`:

```js
test('`claude -w` worktrees inside a main clone are found', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  const out = r.stdout;
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.repo, '.claude/worktrees/drifting-giggling-pond')), out);
  assert.ok(out.includes(join(fx.repo, '.claude/worktrees/agent-aed5fc34')), out);
});

test('main clones under the ghq root are NOT listed', () => {
  // Walking ~/ghq for what is inside its repositories must not turn gwqcd into
  // a worse ghqcd. The main clone is ghqcd's job.
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  const lines = r.stdout.trim().split('\n');
  rmSync(fx.home, { recursive: true, force: true });
  assert.ok(!lines.includes(fx.repo), `the main clone leaked into the list:\n${r.stdout}`);
});

test('a detached `agent-…` worktree reports no branch, not a crash', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  rmSync(fx.home, { recursive: true, force: true });
  const agent = out.worktrees.find((w) => w.path.endsWith('agent-aed5fc34'));
  assert.equal(agent.branch, '', 'a detached HEAD has no branch');
  assert.match(agent.commit, /^[0-9a-f]{40}$/);
});

test('without ghq on PATH the gwq source still returns everything', () => {
  // ghq is optional, unlike git (I1b): its absence means there is no ghq tree
  // to search, which is today's correct behavior — not exit 127.
  const fx = realHome();
  const r = runIn(fx, ['--list'], { withGhq: false });
  const out = r.stdout;
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.base, 'host/owner/repo/feat-one')), out);
  assert.doesNotMatch(out, /ghq\/host\/owner\/repo/, 'no ghq root, no claude source');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -30`

Expected: FAIL — the `drifting-giggling-pond` and `agent-aed5fc34` paths are absent because no ghq root is walked yet.

- [ ] **Step 3: Add `ghqRoots`**

Insert after `gwqBasedir` in `bin/gwqcd.mjs`:

```js
// ghq is asked rather than reimplemented: it supports several roots and reads
// them from three places. The fallbacks keep the claude source working when ghq
// is not installed at all, and ~/ghq is ghq's own documented default rather
// than a guess of ours.
//
// ghq is deliberately NOT in `ensureTool`. I1b requires git because without it
// gwq reports zero worktrees to someone who has 44 — a wrong answer delivered
// silently. Missing ghq is not that: it means there is no ghq tree to search,
// so this source is empty and every other source returns what it always did.
async function ghqRoots() {
  const out = await capture('ghq', ['root']);
  if (out != null && out.trim()) {
    return out.trim().split('\n').map((l) => expandTilde(l.trim())).filter(Boolean);
  }
  const env = process.env.GHQ_ROOT;
  if (env) return env.split(':').map((p) => expandTilde(p.trim())).filter(Boolean);
  return [joinPath(homedir(), 'ghq')];
}
```

- [ ] **Step 4: Walk it**

In `discoverWorktrees`, replace the two lines that resolve and walk the single root with:

```js
  // The two subprocess lookups are the only slow part of discovery, so they
  // overlap: the added wall-clock is the slower of the two, not their sum.
  const [basedir, ghq] = await Promise.all([gwqBasedir(), ghqRoots()]);

  for (const root of usableRoots([
    { dir: basedir, emitAs: 'gwq' },
    // emitAs null: walked for the `.claude/worktrees` inside its repositories,
    // never for the repositories themselves.
    ...ghq.map((dir) => ({ dir, emitAs: null })),
  ])) {
    for (const e of walkWorktrees(root.dir, { emitAs: root.emitAs })) {
      if (!found.has(e.path)) found.set(e.path, e.source);
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -30`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/gwqcd.mjs test/cli.test.mjs
git commit -m "$(cat <<'MSG'
feat: walk the ghq root for the agent worktrees inside its repositories

The ghq root is walked with emitAs null, so the 44 main clones it contains stay
out of the results — a main clone is ghqcd's job, and listing them here would
turn gwqcd into a worse ghqcd.

ghq is optional and stays out of ensureTool. I1b requires git because without it
gwq claims zero worktrees for a user who has 44; missing ghq only means there is
no ghq tree to search, which is today's behavior and not worth exit 127.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WXUj4zXDKWFivQrMprDYPX
MSG
)"
```

---

### Task 3: The herdr root

Adds the third root and locks the full expected set, including herdr's own I8 case.

**Files:**
- Modify: `bin/gwqcd.mjs` — add `herdrRoot`, extend the root list, fix the empty-list message
- Test: `test/cli.test.mjs` — add three tests

**Interfaces:**
- Consumes: everything from Tasks 1 and 2, plus the `EXPECTED` table defined in Task 1.
- Produces: `herdrRoot() -> string`.

- [ ] **Step 1: Write the failing tests**

Append to the fast-discovery section:

```js
test('herdr worktrees are found under ~/.herdr/worktrees', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  const out = r.stdout;
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.home, '.herdr/worktrees/repo/worktree-brave-meadow-2b28')), out);
});

test("herdr's directory slug is not its branch name", () => {
  // Directory worktree-brave-meadow-2b28, branch worktree/brave-meadow-2b28.
  // The slash is flattened to a dash, which is I8 re-run on a second tool.
  const fx = realHome();
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  rmSync(fx.home, { recursive: true, force: true });
  const w = out.worktrees.find((x) => x.path.includes('.herdr'));
  assert.equal(w.branch, 'worktree/brave-meadow-2b28');
});

test('the three roots together yield exactly the expected set', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  const got = r.stdout.trim().split('\n').sort();
  rmSync(fx.home, { recursive: true, force: true });
  const want = EXPECTED.map(([rel]) => join(fx.home, rel)).sort();
  assert.deepEqual(got, want);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -30`

Expected: FAIL — the `.herdr` path is missing from the list.

- [ ] **Step 3: Add `herdrRoot` and walk it**

Insert after `ghqRoots` in `bin/gwqcd.mjs`:

```js
// herdr exposes no setting for this directory, so the convention is the
// contract. If it ever grows one, this becomes a one-line change.
function herdrRoot() {
  return joinPath(homedir(), '.herdr', 'worktrees');
}
```

Then add the third entry to the `usableRoots` call in `discoverWorktrees`, after the ghq spread:

```js
    { dir: herdrRoot(), emitAs: 'herdr' },
```

- [ ] **Step 4: Say where we looked when nothing is found**

In `main`, replace the `paths.length === 0` message:

```js
  if (paths.length === 0) {
    die('E_NO_MATCH', values.local
      ? 'this repository has no worktrees. Create one with `gwq add <branch>`.'
      : 'no worktrees found under gwq\'s base directory, ~/.herdr/worktrees, or '
        + 'any .claude/worktrees below the ghq root. Create one with `gwq add <branch>`.');
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -30`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/gwqcd.mjs test/cli.test.mjs
git commit -m "$(cat <<'MSG'
feat: walk ~/.herdr/worktrees as the third root

herdr's slug flattens the branch's slash: directory
worktree-brave-meadow-2b28 checks out worktree/brave-meadow-2b28. That is I8
re-run on a second tool, and the branch still travels from git rather than
being re-derived from the path.

The empty-list message now names the three places searched, so "no worktrees"
is a statement about somewhere rather than about nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WXUj4zXDKWFivQrMprDYPX
MSG
)"
```

---

### Task 4: `source` in the payload and `--source` to filter

The user-visible half: the field agents read and the flag humans use to quiet the picker.

**Files:**
- Modify: `bin/gwqcd.mjs` — `parseArgs` options, validation, `HELP`, the `shape` helper, both JSON writers, the filter in `main`
- Test: `test/cli.test.mjs` — add five tests

**Interfaces:**
- Consumes: `sourceOf` (a `Map<string, string|null>`) from Task 1's `discoverWorktrees`.
- Produces:
  - `const SOURCES = ['gwq', 'claude', 'herdr', 'other']`
  - `let selectedSources: Set<string> | null` — null means every source
  - `shape(path) -> { path, branch, commit, isMain, source }`

- [ ] **Step 1: Write the failing tests**

Append to the fast-discovery section:

```js
test('--list --json carries the source of every worktree', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  rmSync(fx.home, { recursive: true, force: true });
  const got = out.worktrees
    .map((w) => [w.path.slice(fx.home.length + 1), w.source])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(got, [...EXPECTED].sort((a, b) => a[0].localeCompare(b[0])));
});

test('--source gwq excludes the agent worktrees', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list', '--source', 'gwq']);
  const lines = r.stdout.trim().split('\n');
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines, [join(fx.base, 'host/owner/repo/feat-one')]);
});

test('--source takes a comma-separated list', () => {
  const fx = realHome();
  const r = runIn(fx, ['--list', '--source', 'claude,herdr']);
  const lines = r.stdout.trim().split('\n').sort();
  rmSync(fx.home, { recursive: true, force: true });
  const want = EXPECTED.filter(([, s]) => s !== 'gwq')
    .map(([rel]) => join(fx.home, rel)).sort();
  assert.deepEqual(lines, want);
});

test('--source all is the default and selects everything', () => {
  const fx = realHome();
  const a = runIn(fx, ['--list']);
  const b = runIn(fx, ['--list', '--source', 'all']);
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(a.stdout, b.stdout);
});

test('an unknown --source value is E_VALIDATION and names the valid ones', () => {
  const r = run(['--json', '--source', 'jujutsu']);
  assert.equal(r.status, 1);
  const e = jsonLine(r.stderr).error;
  assert.equal(e.code, 'E_VALIDATION');
  assert.match(e.message, /jujutsu/);
  assert.match(e.message, /gwq \| claude \| herdr \| other \| all/);
});

test('--source with a query that filters everything out is E_NO_MATCH', () => {
  const fx = realHome();
  const r = runIn(fx, ['--json', '--source', 'herdr', 'feat-one']);
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.equal(jsonLine(r.stderr).error.code, 'E_NO_MATCH');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -30`

Expected: FAIL — `parseArgs` rejects `--source` as an unknown option, and `w.source` is `undefined`.

- [ ] **Step 3: Declare and validate the flag**

Add to the `parseArgs` options object, after `'no-main'`:

```js
      source: { type: 'string' },
```

Insert after the existing `--cmd` validation in the argument-validation block:

```js
// A worktree's source is the tool whose convention put it where it is.
// `other` is only reachable through --local: global discovery walks exactly
// the three roots that produce the other three.
const SOURCES = ['gwq', 'claude', 'herdr', 'other'];
const SOURCE_LIST = `${SOURCES.join(' | ')} | all`;

// null means every source, which is the default.
let selectedSources = null;
if (values.source != null) {
  const requested = values.source.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = requested.filter((s) => s !== 'all' && !SOURCES.includes(s));
  if (requested.length === 0 || bad.length) {
    die('E_VALIDATION', bad.length
      ? `--source: unknown ${bad.length > 1 ? 'sources' : 'source'} ${bad.join(', ')}. Valid: ${SOURCE_LIST}`
      : `--source expects a comma-separated list of ${SOURCE_LIST}`);
  }
  if (!requested.includes('all')) selectedSources = new Set(requested);
}
```

- [ ] **Step 4: Label `--local` paths, then filter**

In `main`, immediately after the `sourceOf` / `paths` assignments and before the `--no-main` block, insert:

```js
  // Global discovery knows the source by construction. --local gets its paths
  // from git, which has no notion of one, so the label is derived from the path
  // against the known roots — and only when something is going to read it,
  // because the gwq label costs a subprocess.
  if (values.local && (isJson || selectedSources)) await labelLocal(paths, sourceOf);

  if (selectedSources) {
    const before = paths.length;
    paths = paths.filter((p) => selectedSources.has(sourceOf.get(p) ?? 'other'));
    if (paths.length === 0 && before > 0) {
      die('E_NO_MATCH', `no worktree came from ${[...selectedSources].join(' or ')}`);
    }
  }
```

Add `labelLocal` and `classifySource` next to `usableRoots`:

```js
// git reports paths, not provenance, so a --local listing has to recognise the
// roots by shape. The .claude test and the herdr root are free; the gwq label
// is the one that costs a subprocess, which is why the caller gates this.
async function labelLocal(paths, into) {
  const basedir = await gwqBasedir();
  const roots = [];
  for (const [dir, source] of [[basedir, 'gwq'], [herdrRoot(), 'herdr']]) {
    if (!dir) continue;
    try { roots.push([realpathSync(dir), source]); } catch { /* not a root */ }
  }
  for (const p of paths) into.set(p, classifySource(p, roots));
}

// A `claude -w` worktree inside a gwq worktree is under the gwq base directory
// *and* has .claude/worktrees in its path, so the claude test has to come
// first: the innermost convention is the one that made the directory.
function classifySource(path, roots) {
  if (path.includes(`${sep}.claude${sep}worktrees${sep}`)) return 'claude';
  for (const [dir, source] of roots) {
    if (path === dir || path.startsWith(dir + sep)) return source;
  }
  return 'other';
}
```

- [ ] **Step 5: Put `source` in both payloads**

Replace the `shape` helper in `main`:

```js
  // fzf matches on the path, exactly as the original shell function did — the
  // path already encodes host, owner, repo, tool and a branch slug.
  const shape = (p) => {
    const m = byPath.get(p) ?? { path: p, branch: '', commit: '', isMain: false };
    return {
      path: m.path,
      branch: m.branch,
      commit: m.commit,
      isMain: m.isMain,
      source: sourceOf.get(p) ?? 'other',
    };
  };
```

In the `--list --json` writer, replace `worktrees: shown.map((p) => shape(byPath.get(p)))` with:

```js
        worktrees: shown.map((p) => shape(p)),
```

In the single-selection JSON writer, replace `...shape(picked)` with `...shape(selected)`.

- [ ] **Step 6: Document the flag in `--help`**

In `HELP`, add after the `--no-main` line:

```
  --source <list>    limit to gwq | claude | herdr | other | all (default: all)
```

Add a block after `EXAMPLES`:

```
WHERE IT LOOKS
  gwq      the directory named by \`gwq config get worktree.basedir\`
  claude   <repo>/.claude/worktrees/… for every repository under \`ghq root\`,
           and inside every worktree found above — this is what \`claude -w\` makes
  herdr    ~/.herdr/worktrees/<repo>/…
  Repositories outside ghq's root are not searched. ghq itself is optional:
  without it, the claude source is simply empty.
```

And update the two JSON samples in the `OUTPUT` section to carry the field:

```
    {"schemaVersion":1,"path":"…","branch":"…","commit":"…","isMain":false,"source":"gwq","matches":1}
  with --list:
    {"schemaVersion":1,"count":2,"worktrees":[{"path":"…","branch":"…","commit":"…","isMain":false,"source":"claude"}]}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -30`

Expected: PASS, all tests including the pre-existing `--list --json carries branch, commit and isMain` case, which uses `assert.deepEqual` on a whole object and therefore needs `source: 'gwq'` added to its expectation. Update that assertion:

```js
  assert.deepEqual(out.worktrees[1], {
    path: '/wt/github.com/alice/api/feat-login',
    branch: 'feat/login',
    commit: 'bbb2222',
    isMain: false,
    source: 'gwq',
  });
```

- [ ] **Step 8: Commit**

```bash
git add bin/gwqcd.mjs test/cli.test.mjs
git commit -m "$(cat <<'MSG'
feat: --source filters, and the JSON says which tool made each worktree

An agent reading the payload needs to tell a worktree it can safely reuse from
one another agent is sitting in, and a human with a dozen agent worktrees needs
`--source gwq` to get a quiet picker. The field is additive, so schemaVersion
stays at 1 per I9.

Classification puts the .claude test first: a `claude -w` worktree inside a gwq
worktree is under the gwq base directory too, and the innermost convention is
the one that made the directory.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WXUj4zXDKWFivQrMprDYPX
MSG
)"
```

---

### Task 5: `--local` labels its own worktrees

`--local` has always listed `claude -w` worktrees, because `git worktree list --porcelain` reports them. It just never said so.

**Files:**
- Modify: nothing — Task 4 wired `labelLocal`; this task proves it
- Test: `test/cli.test.mjs` — add two tests

**Interfaces:**
- Consumes: `labelLocal`, `classifySource`, the `realHome` fixture.
- Produces: nothing new.

- [ ] **Step 1: Write the tests**

Append to the fast-discovery section:

```js
test('--local labels the sources it can see', () => {
  // git reports every worktree of the repository, agent ones included, and has
  // always done so. Now the listing says which is which.
  const fx = realHome();
  const shims = homeShim({ base: fx.base, ghqRoot: fx.ghqRoot });
  const r = run(['--local', '--list', '--json'], {
    shims, cwd: fx.repo, env: { HOME: fx.home },
  });
  rmSync(shims, { recursive: true, force: true });
  const out = JSON.parse(r.stdout);
  rmSync(fx.home, { recursive: true, force: true });
  const bySource = {};
  for (const w of out.worktrees) bySource[w.source] = (bySource[w.source] ?? 0) + 1;
  // the main clone is `other`; the gwq worktree is `gwq`; the herdr one is
  // `herdr`; the four .claude ones are `claude`.
  assert.equal(bySource.other, 1, JSON.stringify(out.worktrees, null, 2));
  assert.equal(bySource.gwq, 1);
  assert.equal(bySource.herdr, 1);
  assert.equal(bySource.claude, 4);
});

test('--local --source other is the main clone alone', () => {
  const fx = realHome();
  const shims = homeShim({ base: fx.base, ghqRoot: fx.ghqRoot });
  const r = run(['--local', '--list', '--source', 'other'], {
    shims, cwd: fx.repo, env: { HOME: fx.home },
  });
  rmSync(shims, { recursive: true, force: true });
  const lines = r.stdout.trim().split('\n');
  rmSync(fx.home, { recursive: true, force: true });
  assert.deepEqual(lines, [fx.repo]);
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test 2>&1 | tail -30`

Expected: PASS if Task 4's `labelLocal` is correct. If `bySource.gwq` comes back `undefined` and `other` is 2, `classifySource` is not realpath-normalising the base directory — the fixture's home is already a realpath, so compare the two spellings printed by the failure and fix `labelLocal`, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/cli.test.mjs
git commit -m "$(cat <<'MSG'
test: --local labels the agent worktrees it was already listing

`git worktree list --porcelain` has always reported the .claude/worktrees
entries, so --local found them before this branch existed. What it could not do
was say which tool made them. Four claude, one gwq, one herdr and the main
clone as `other`, from one repository.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WXUj4zXDKWFivQrMprDYPX
MSG
)"
```

---

### Task 6: Documentation, invariants, and the version

The interface changed, so every document that states the interface has to change with it. This is also where two pre-existing bugs in these files get fixed.

**Files:**
- Modify: `README.md`, `.claude/skills/gwqcd/SKILL.md`, `CLAUDE.md`, `package.json`, `.npmignore`

**Interfaces:**
- Consumes: the finished behavior from Tasks 1 to 5.
- Produces: nothing code depends on.

- [ ] **Step 1: Bump the version to 0.3.0**

A new flag and a new schema field is a minor bump. Edit `package.json` by hand rather than running `npm version`, which would also create a tag pointing at a branch commit:

```json
  "version": "0.3.0",
```

Every push to main releases whatever `package.json` says, so this number is the release this pull request makes.

- [ ] **Step 2: Keep the new docs out of the tarball**

Add to `.npmignore`, which is defense in depth behind `files` in `package.json`:

```
docs/
```

- [ ] **Step 3: Update `README.md`**

Add `--source <list>` to the options table with the text `limit to gwq | claude | herdr | other | all (default: all)`. Add a section after the options, before the JSON section:

```markdown
## Where it looks

| source   | location                                    | created by |
| -------- | ------------------------------------------- | ---------- |
| `gwq`    | `gwq config get worktree.basedir`           | `gwq add`  |
| `claude` | `<repo>/.claude/worktrees/<slug>`           | `claude -w` |
| `herdr`  | `~/.herdr/worktrees/<repo>/<slug>`          | `herdr worktree create` |

`claude -w` puts its worktree inside the repository it belongs to, so gwqcd
looks inside every repository under `ghq root` — and inside every worktree it
already found, because an agent can start an agent. It never descends into a
repository beyond that one directory, which is why the whole search costs about
30ms rather than the 43 seconds `gwq list -g --json` takes here.

ghq is optional. Without it there is no ghq root to search and the `claude`
source is empty; every other source is unaffected.

Use `--source gwq` for a picker with no agent worktrees in it.
```

Add `"source"` to both JSON examples in the README.

- [ ] **Step 4: Update `.claude/skills/gwqcd/SKILL.md`**

Four changes:

1. Fix the version pin. It currently reads `npx -y gwqcd@^0.1`, and `^0.1` cannot resolve anything above `0.1.x`, so every agent following this skill has been running a build from before the fast discovery path existed. Change both the range and the parenthetical to `^0.3`.

2. Add `source` to both output samples, and add a row to the description:

```markdown
`source` names the tool whose convention created the worktree: `gwq`,
`claude` for one `claude -w` made at `<repo>/.claude/worktrees/<slug>`,
`herdr`, or `other`.
```

3. Add a section after the `matches` section:

```markdown
## Agent worktrees are somebody's workspace

A `source` of `claude` or `herdr` means another agent session was given that
worktree. Running commands in it, and especially committing in it, collides
with work in progress that is not yours.

Prefer `--source gwq` when you need a worktree to work in:

```bash
gwqcd --json --source gwq <query>
```

Read a `claude` or `herdr` worktree when the user asked about that specific
one. Do not adopt it as your own working directory unless they say so.
```

4. Add `--source` to the enumeration examples:

```bash
gwqcd --list --json --source gwq      # no agent worktrees
gwqcd --list --json --source claude   # only `claude -w` worktrees
```

- [ ] **Step 5: Update `CLAUDE.md`**

Add a new invariant after I7b, and amend three places.

New invariant:

```markdown
### I7c. Three roots, and the ghq root is walked for what is *inside* it

`claude -w` creates a real linked worktree at `<repo>/.claude/worktrees/<slug>`
— inside the main worktree, which is the one place I7b's walk refuses to enter.
herdr creates one at `~/.herdr/worktrees/<repo>/<slug>`. Eleven and one
respectively on the machine this was measured on, all invisible to `gwq`.

So discovery walks three roots:

| root | resolution | `emitAs` |
| --- | --- | --- |
| gwq basedir | `gwq config get worktree.basedir` | `gwq` |
| ghq root | `ghq root`, else `$GHQ_ROOT`, else `~/ghq` | **null** |
| herdr root | `~/.herdr/worktrees` | `herdr` |

`emitAs: null` on the ghq root is load-bearing. That root is walked to find the
`.claude/worktrees` inside its repositories; emitting the pruned directory
itself would add 44 main clones to the list and make `gwqcd` a worse `ghqcd`.
There is a test asserting the main clone does not appear.

The peek happens at the moment of pruning, at every root, and recurses into a
found worktree's own `.claude/worktrees` because an agent can start an agent.
Only a child with a `.git` of its own counts — `.claude/worktrees` also holds
notes and scratch files.

`gwq config get` and `ghq root` run concurrently, so the added wall-clock is
the slower of the two rather than their sum:

| step | cost |
| --- | --- |
| `gwq config get` ‖ `ghq root` | 45ms |
| walk `~/ghq`, 44 repositories, 61 directories visited | 9ms |
| walk the gwq basedir, 115 worktrees | 20ms |
| walk `~/.herdr/worktrees` | 1ms |
| for contrast, `gwq list -g --json` **today** | 43,756ms |

That last number was 7,600ms when I7b was written. The slow path has got six
times worse as worktrees accumulated, which is the strongest argument yet for
not being on it.

**ghq is an optional dependency and must stay out of `ensureTool`.** I1b
requires git because without it gwq reports zero worktrees to someone who has
44 — a wrong answer, silently. Missing ghq is not the same failure: it means
there is no ghq tree to search, so the `claude` source is empty and every other
source returns exactly what it returned before. Degrading to correct behavior
does not deserve exit 127.
```

Amend I8 by appending:

```markdown
Both new sources make this sharper, and both were verified on real worktrees:
`claude -w` puts branch `fix/editor-chat-domain-guide` in a directory called
`drifting-giggling-pond`, one `agent-…` worktree is on a detached HEAD with no
branch at all, and herdr flattens `worktree/brave-meadow-2b28` to
`worktree-brave-meadow-2b28`.
```

Amend I9 by adding `source` to both schema samples and this note:

```markdown
`source` is `gwq` | `claude` | `herdr` | `other`, assigned at discovery time
and never re-derived from the path afterwards — except under `--local`, where
git reports paths without provenance and the roots have to be recognised by
shape. There the `.claude` test comes first, because a `claude -w` worktree
inside a gwq worktree is under the gwq base directory too and the innermost
convention is the one that made the directory.
```

In the "Things that are intentionally NOT here" section, replace the richer-fzf-display bullet's reasoning with:

```markdown
- **A richer fzf display** (repo + branch columns via `--with-nth`). The path
  already encodes host, owner, repo, tool and branch slug —
  `…/alchemy/.claude/worktrees/adaptive-hugging-horizon` and
  `~/.herdr/worktrees/gwqcd/worktree-brave-meadow-2b28` each name their tool,
  their repository and their slug. Adding the sources did not change this.
```

And add to that same section:

```markdown
- **Cleaning up finished agent worktrees.** `--source claude` makes the list
  trivial to produce, which is exactly why the deletion is not automated here.
  See the note on `gwq remove` above.
- **Repositories outside ghq's root.** A `~/dev/project` with agent worktrees
  inside is not found. `gwqcd` is a ghq and gwq tool; `--help` says where it
  looks.
```

Add a row to the manual test matrix:

```markdown
| Agent worktree pick | `gwqcd drifting` | lands in a `claude -w` worktree |
| Quiet picker | `gwqcd --source gwq` | no `.claude/worktrees` entries in fzf |
```

- [ ] **Step 6: Verify the whole thing**

```bash
npm test
node bin/gwqcd.mjs --help
npm pack --dry-run 2>&1 | grep -E 'docs/|\.claude/|CLAUDE.md|test/' && echo "LEAK" || echo "tarball clean"
node bin/gwqcd.mjs --list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const c={};for(const w of o.worktrees)c[w.source]=(c[w.source]??0)+1;console.log(o.count,c)})'
```

Expected: tests pass; help renders the new block; `npm pack --dry-run` shows no `docs/`, `.claude/`, `CLAUDE.md` or `test/`; the real machine reports its worktrees grouped by source with a non-zero `claude` count.

- [ ] **Step 7: Commit**

```bash
git add README.md .claude/skills/gwqcd/SKILL.md CLAUDE.md package.json .npmignore
git commit -m "$(cat <<'MSG'
docs: three roots, --source, and 0.3.0

Adds invariant I7c for the three-root walk and the emitAs-null rule that keeps
main clones out of the results. I8 and I9 gain the new evidence: two more tools
that name a directory nothing like the branch inside it.

Two pre-existing bugs fixed in files this change already touches. SKILL.md
pinned `npx -y gwqcd@^0.1`, a range that cannot resolve past 0.1.x, so every
agent following the skill has been running a build from before the fast
discovery path existed. And the skill now warns that a `claude` or `herdr`
worktree belongs to another agent session, with --source gwq as the way to ask
for one that does not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WXUj4zXDKWFivQrMprDYPX
MSG
)"
```

---

## Self-review

**Spec coverage.** Sources table → Tasks 1 to 3. Roots table and concurrency → Tasks 1 to 3. `includeRoots`, renamed `emitAs` → Task 2. Fallback preserved → Task 1, with the existing E_GWQ test kept. `--source` flag → Task 4. Schema field → Task 4. Lazy `--local` labelling → Tasks 4 and 5. I8 evidence → Tasks 1 and 3. Performance table → Task 6's I7c. The spec's ten test cases map to: 1 → Task 4's payload test, 2 → Task 3, 3 → Task 2, 4 → Task 1, 5 → Task 1, 6 → Task 4, 7 → Task 4, 8 → Task 1's first-writer-wins map plus Task 3's exact-set test, 9 → Task 3, 10 → Task 2. Both incidental fixes → Task 6.

**Deviation from the spec, deliberate.** The spec described dedup as "a root nested inside a root already walked is skipped". That is wrong: a gwq base directory configured inside the ghq root would be skipped and every gwq worktree would vanish. The plan keeps realpath on the roots and dedups at the output instead, with a first-writer-wins map. Task 1 Step 5 carries the reasoning in a comment. The spec's `usableRoots` behavior is narrowed accordingly.

**Placeholder scan.** No TBD, no "handle errors appropriately", no "similar to Task N". Every code step carries the code.

**Type consistency.** `emitAs` is the option name in Task 1's `walkWorktrees` and in Tasks 2 and 3's root specs. `sourceOf` is the `Map` name in Task 1 Step 6 and in Task 4's `shape` and filter. `shape` takes a path string in Task 4, which is why Task 4 Step 5 also fixes the two call sites that passed it an object. `labelLocal(paths, into)` is called with `(paths, sourceOf)` in Task 4 Step 4 and defined with that arity in Step 4. `SOURCES` is `['gwq','claude','herdr','other']` in Task 4 and in the error-message assertion, which expects `gwq | claude | herdr | other | all`.
