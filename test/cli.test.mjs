// Exercises the CLI with `gwq` and `fzf` shims on PATH: no network, no real
// worktrees, no TTY. The interactive fzf UI is covered by the manual matrix in
// CLAUDE.md — everything reachable without a terminal lives here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, realpathSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gwqcd.mjs');
const PKG_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;

const WORKTREES = [
  { path: '/wt/github.com/alice/api/main', branch: 'main', commit_hash: 'aaa1111', is_main: true },
  { path: '/wt/github.com/alice/api/feat-login', branch: 'feat/login', commit_hash: 'bbb2222', is_main: false },
  { path: '/wt/github.com/alice/web/fix-cache', branch: 'fix/cache', commit_hash: 'ccc3333', is_main: false },
];

// Shims good enough for every non-interactive path. `fzf --filter` is a
// substring match — close enough to fzf's ranking for tests that only assert
// which candidates survive.
function makeShims({ json = JSON.stringify(WORKTREES), gwqStatus = 0, gwqStderr = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-shims-'));
  const write = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  write('gwq', `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gwq version v0.1.1"; exit 0; fi
if [ "$1" = "list" ]; then
  ${gwqStderr ? `printf '%s\\n' ${JSON.stringify(gwqStderr)} >&2` : ':'}
  ${gwqStatus === 0 ? `cat <<'GWQJSON'\n${json}\nGWQJSON` : ':'}
  exit ${gwqStatus}
fi
exit 0
`);
  write('fzf', `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.74.1"; exit 0; fi
if [ "$1" = "--filter" ]; then
  out=$(grep -F -- "$2")
  [ -n "$out" ] || exit 1
  printf '%s\\n' "$out"
  exit 0
fi
# No TTY in tests, so the interactive branch must never be reached.
echo "fzf: interactive UI invoked in a test" >&2
exit 2
`);
  return dir;
}

// Hermetic against the developer's own machine, which the ghq root made a live
// problem: PATH is the shim directory plus the system directories git lives in
// and nothing else, so a real gwq, ghq or fzf cannot answer a question a shim
// was written for. HOME is a fresh empty directory for the same reason — the
// herdr root and the `~/ghq` fallback have to land somewhere the test controls,
// or the suite starts reporting the developer's own 44 repositories. GHQ_ROOT
// goes for the same reason as FORCE_COLOR: it is theirs, not ours.
function run(args, { shims, cwd, env } = {}) {
  const dir = shims ?? makeShims();
  const ownHome = env?.HOME ? null : mkdtempSync(join(tmpdir(), 'gwqcd-nohome-'));
  const childEnv = { ...process.env };
  // We force NO_COLOR; node itself warns to stderr when FORCE_COLOR is also
  // set, so a developer who exports it would otherwise see phantom failures.
  // GHQ_ROOT goes for the same reason: it is theirs, not ours.
  //
  // Both are dropped *before* the caller's own env is applied, so a test that
  // deliberately sets GHQ_ROOT — the fallback branch has to be exercised
  // somehow — still gets it, while an exported one can never leak in.
  delete childEnv.FORCE_COLOR;
  delete childEnv.GHQ_ROOT;
  Object.assign(childEnv, {
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: env?.HOME ?? ownHome,
    NO_COLOR: '1',
  }, env);
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', env: childEnv, ...(cwd ? { cwd } : {}),
  });
  if (!shims) rmSync(dir, { recursive: true, force: true });
  if (ownHome) rmSync(ownHome, { recursive: true, force: true });
  return r;
}

const jsonLine = (s) =>
  JSON.parse(s.split('\n').find((l) => l.startsWith('{')));

// stderr is shared, not ours alone: node emits its own warnings there. Strip
// them before asserting the program itself stayed silent.
const ourStderr = (s) =>
  s.split('\n')
    .filter((l) => l && !/^\(node:\d+\)/.test(l) && !/^\(Use `node --trace-warnings/.test(l))
    .join('\n');

// ── --init ───────────────────────────────────────────────────────────────────

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`--init ${shell} emits a function and the three-step resolver`, () => {
    const r = run(['--init', shell]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gwqcd/);
    assert.match(r.stdout, /--quiet/, 'the function must call the binary in --quiet mode');
    assert.match(r.stdout, /npx -y/, 'npx must be the last-resort fallback');
    assert.ok(r.stdout.includes(BIN), 'the generating script path must be baked in');
    assert.equal(ourStderr(r.stderr), '');
  });
}

for (const checker of ['zsh', 'bash']) {
  test(`--init ${checker} output parses under ${checker} -n`, (t) => {
    if (spawnSync(checker, ['-c', 'true'], { stdio: 'ignore' }).error) {
      return t.skip(`${checker} not installed`);
    }
    const src = run(['--init', checker]).stdout;
    const r = spawnSync(checker, ['-n'], { input: src, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('--init fish output parses under fish -n', (t) => {
  if (spawnSync('fish', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('fish not installed');
  // fish wants a script *file*. `fish -n /dev/stdin` reads the pipe spawnSync
  // hands it on macOS but not on Linux, where it exits 127 with "Error reading
  // script file" — which is how this passed for a year and failed the first
  // time the suite ran on CI. zsh and bash take the snippet on stdin happily.
  const script = mkdtempSync(join(tmpdir(), 'gwqadd-fish-'));
  writeFileSync(join(script, 'init.fish'), run(['--init', 'fish']).stdout);
  const r = spawnSync('fish', ['-n', join(script, 'init.fish')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  rmSync(script, { recursive: true, force: true });
});

test('--cmd renames the emitted function', () => {
  const r = run(['--init', 'zsh', '--cmd', 'wcd']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^wcd\(\) \{/m);
});

test('--init rejects an unknown shell', () => {
  const r = run(['--init', 'tcsh']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /zsh \| bash \| fish/);
});

test('--cmd without --init is a validation error', () => {
  const r = run(['--cmd', 'wcd']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only meaningful together with --init/);
});

// ── flags ────────────────────────────────────────────────────────────────────

test('--help exits 0 on stdout', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /USAGE/);
  assert.equal(ourStderr(r.stderr), '');
});

test('--version matches package.json', async () => {
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  assert.equal(run(['--version']).stdout.trim(), `gwqcd ${pkg.version}`);
});

test('--json and --quiet are mutually exclusive', () => {
  const r = run(['--json', '--quiet']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('a second positional is rejected', () => {
  const r = run(['one', 'two']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected extra arguments: two/);
});

// ── listing and selection ────────────────────────────────────────────────────

test('--list prints every worktree path', () => {
  const r = run(['--list']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split('\n'), WORKTREES.map((w) => w.path));
});

test('--no-main drops main worktrees', () => {
  const r = run(['--list', '--no-main']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split('\n'), [WORKTREES[1].path, WORKTREES[2].path]);
});

test('--list --json carries branch, commit and isMain', () => {
  const out = JSON.parse(run(['--list', '--json']).stdout);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.count, 3);
  assert.deepEqual(out.worktrees[1], {
    path: '/wt/github.com/alice/api/feat-login',
    branch: 'feat/login',
    commit: 'bbb2222',
    isMain: false,
    source: 'gwq',
  });
});

test('the real branch name survives, not just the path slug', () => {
  // The zsh original piped gwq through `jq -r .[].path`, discarding the branch.
  // `feat/login` cannot be recovered from the `feat-login` directory name.
  const out = JSON.parse(run(['--json', 'feat-login']).stdout);
  assert.equal(out.branch, 'feat/login');
});

test('--json picks the best match and reports how many there were', () => {
  const r = run(['--json', '/wt/github.com/alice/api']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.path, WORKTREES[0].path);
  assert.equal(out.isMain, true);
  assert.equal(out.matches, 2, 'an ambiguous query must say so');
});

test('--quiet prints the path and nothing else on stdout', () => {
  const r = run(['--quiet', 'fix-cache']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${WORKTREES[2].path}\n`);
});

test('no match exits 2 with E_NO_MATCH', () => {
  const r = run(['--json', 'nope']);
  assert.equal(r.status, 2);
  assert.equal(jsonLine(r.stderr).error.code, 'E_NO_MATCH');
  assert.equal(r.stdout, '', 'stdout stays empty on error (I1)');
});

test('no query without a TTY exits 3 with E_AMBIGUOUS', () => {
  const r = run(['--json']);
  assert.equal(r.status, 3);
  assert.equal(jsonLine(r.stderr).error.code, 'E_AMBIGUOUS');
});

// ── gwq output quirks ────────────────────────────────────────────────────────

test('gwq printing plain text instead of JSON reads as an empty list', () => {
  // With no worktrees gwq abandons --json and prints a human sentence. The zsh
  // original swallowed that with `2>/dev/null` plus a failing jq.
  const shims = makeShims({ json: 'No worktrees found' });
  const r = run(['--json', 'x'], { shims });
  rmSync(shims, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.match(jsonLine(r.stderr).error.message, /gwq add/);
});

test('an empty JSON array is an empty list, not a crash', () => {
  const shims = makeShims({ json: '[]' });
  const r = run(['--json', 'x'], { shims });
  rmSync(shims, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.equal(jsonLine(r.stderr).error.code, 'E_NO_MATCH');
});

test('a failing gwq surfaces as E_GWQ rather than an empty list', () => {
  const shims = makeShims({ gwqStatus: 1, gwqStderr: 'gwq: boom' });
  const r = run(['--json', 'x'], { shims });
  rmSync(shims, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_GWQ');
});

test('--local outside a repository is an empty list, not an error', () => {
  // --local asks git directly now, so this has to actually run outside a
  // repository rather than shimming gwq into failing.
  const outside = mkdtempSync(join(tmpdir(), 'gwqcd-outside-'));
  const r = run(['--local', '--json', 'x'], { cwd: outside });
  rmSync(outside, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.match(jsonLine(r.stderr).error.message, /this repository has no worktrees/);
});

test('malformed JSON from gwq is reported, not silently swallowed', () => {
  const shims = makeShims({ json: '[{"path": ' });
  const r = run(['--json', 'x'], { shims });
  rmSync(shims, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_GWQ');
});

// ── dependency check ─────────────────────────────────────────────────────────

test('a missing fzf exits 127 with the brew command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-noshim-'));
  // git too: it is checked before gwq, so omitting it would make this
  // assert the wrong missing tool.
  for (const n of ['git', 'gwq']) {
    writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, n), 0o755);
  }
  const r = spawnSync(process.execPath, [BIN, '--json', 'x'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, NO_COLOR: '1' },
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 127);
  assert.equal(jsonLine(r.stderr).error.code, 'E_DEPS');
  assert.match(jsonLine(r.stderr).error.message, /brew install fzf/);
});

test('a missing git exits 127 — gwq shells out to it', () => {
  // Without git, `gwq` does not simply fail loudly: `gwq list --json` exits 0 printing "No worktrees found",
  // which this tool would otherwise report as "no worktrees" to someone who has plenty.
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-nogit-'));
  for (const n of ['gwq', 'fzf']) {
    writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, n), 0o755);
  }
  const r = spawnSync(process.execPath, [BIN, '--json', 'x'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, NO_COLOR: '1' },
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 127);
  assert.equal(jsonLine(r.stderr).error.code, 'E_DEPS');
  assert.match(jsonLine(r.stderr).error.message, /'git' not found/);
});

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
  // The CLI under test gets the fixture's HOME, but this builder was still
  // running git with the developer's real one — so a global core.hooksPath or
  // commit.gpgsign broke twenty tests and leaked their fixtures. Scrub the
  // config cascade the same way run() scrubs the environment.
  const gitEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const g = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: gitEnv });
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
// every tilde expansion land inside the fixture, and run() keeps the real
// gwq/ghq/fzf off PATH so only the shims answer.
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

test('a `claude -w` worktree inside a gwq worktree is found', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.stdout.includes(join(fx.base, 'host/owner/repo/feat-one/.claude/worktrees/season-amazing-net')),
    r.stdout,
  );
  assert.doesNotMatch(r.stderr, /slow path/, 'gwq list must not be called');
});

test('the walk still prunes, so nested repositories are not listed', (t) => {
  // Descending into a worktree is what cost gwq its 43 seconds, and a vendored
  // submodule is not somewhere anyone wants to cd.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  assert.doesNotMatch(r.stdout, /vendor\/dep/);
});

test('junk in .claude/worktrees without a .git is not a worktree', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  assert.doesNotMatch(r.stdout, /worktrees\/notes/);
});

test('the gwq worktree and its branch still come back correct', (t) => {
  // `git rev-parse --abbrev-ref HEAD HEAD` abbreviates *both* revs, so the
  // first version of this shipped the branch name in the commit field.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  const one = out.worktrees.find((w) => w.path.endsWith('feat-one'));
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

test('`claude -w` worktrees inside a main clone are found', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  const out = r.stdout;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.repo, '.claude/worktrees/drifting-giggling-pond')), out);
  assert.ok(out.includes(join(fx.repo, '.claude/worktrees/agent-aed5fc34')), out);
});

test('main clones under the ghq root are NOT listed', (t) => {
  // Walking ~/ghq for what is inside its repositories must not turn gwqcd into
  // a worse ghqcd. The main clone is ghqcd's job.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  const lines = r.stdout.trim().split('\n');
  assert.ok(!lines.includes(fx.repo), `the main clone leaked into the list:\n${r.stdout}`);
});

test('an agent that started an agent is found', (t) => {
  // The recursion lives in collectClaudeWorktrees, but the nested worktree in
  // the fixture sits under the ghq root, so it is only reachable once that root
  // is walked.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  assert.ok(r.stdout.includes('quizzical-jumping-tome'), r.stdout);
});

test('a detached `agent-…` worktree reports no branch, not a crash', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  const agent = out.worktrees.find((w) => w.path.endsWith('agent-aed5fc34'));
  assert.equal(agent.branch, '', 'a detached HEAD has no branch');
  assert.match(agent.commit, /^[0-9a-f]{40}$/);
});

test('without the ghq binary the ~/ghq fallback still finds agent worktrees', (t) => {
  // `ghq root` is asked first, but its absence is not the end of it: $GHQ_ROOT,
  // then ghq's own documented default of ~/ghq. The fixture home has one.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list'], { withGhq: false });
  const out = r.stdout;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.repo, '.claude/worktrees/drifting-giggling-pond')), out);
});

test('no ghq at all leaves the gwq source untouched and does not exit 127', (t) => {
  // ghq is optional, unlike git (I1b): no binary and no ~/ghq means there is no
  // tree to search, which is today's correct behavior — not exit 127.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const bare = mkdtempSync(join(tmpdir(), 'gwqcd-noghq-'));
  const shims = homeShim({ base: fx.base, ghqRoot: fx.ghqRoot, withGhq: false });
  const r = run(['--list'], { shims, env: { HOME: bare } });
  rmSync(shims, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  const out = r.stdout;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.base, 'host/owner/repo/feat-one')), out);
  assert.doesNotMatch(out, /ghq\/host\/owner\/repo\/\.claude/, 'no ghq root to search');
});

test('herdr worktrees are found under ~/.herdr/worktrees', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  const out = r.stdout;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.home, '.herdr/worktrees/repo/worktree-brave-meadow-2b28')), out);
});

test("herdr's directory slug is not its branch name", (t) => {
  // Directory worktree-brave-meadow-2b28, branch worktree/brave-meadow-2b28.
  // The slash is flattened to a dash, which is I8 re-run on a second tool.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  const w = out.worktrees.find((x) => x.path.includes('.herdr'));
  assert.equal(w.branch, 'worktree/brave-meadow-2b28');
});

test('the three roots together yield exactly the expected set', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list']);
  const got = r.stdout.trim().split('\n').sort();
  const want = EXPECTED.map(([rel]) => join(fx.home, rel)).sort();
  assert.deepEqual(got, want);
});

test('--list --json carries the source of every worktree', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list', '--json']);
  const out = JSON.parse(r.stdout);
  const got = out.worktrees
    .map((w) => [w.path.slice(fx.home.length + 1), w.source])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(got, [...EXPECTED].sort((a, b) => a[0].localeCompare(b[0])));
});

test('--source gwq excludes the agent worktrees', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list', '--source', 'gwq']);
  const lines = r.stdout.trim().split('\n');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines, [join(fx.base, 'host/owner/repo/feat-one')]);
});

test('--source takes a comma-separated list', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--list', '--source', 'claude,herdr']);
  const lines = r.stdout.trim().split('\n').sort();
  const want = EXPECTED.filter(([, s]) => s !== 'gwq')
    .map(([rel]) => join(fx.home, rel)).sort();
  assert.deepEqual(lines, want);
});

test('--source all is the default and selects everything', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const a = runIn(fx, ['--list']);
  const b = runIn(fx, ['--list', '--source', 'all']);
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

test('--source with a query that filters everything out is E_NO_MATCH', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const r = runIn(fx, ['--json', '--source', 'herdr', 'feat-one']);
  assert.equal(r.status, 2);
  assert.equal(jsonLine(r.stderr).error.code, 'E_NO_MATCH');
});

test('--local labels the sources it can see', (t) => {
  // git reports every worktree of the repository, agent ones included, and has
  // always done so. Now the listing says which is which.
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const shims = homeShim({ base: fx.base, ghqRoot: fx.ghqRoot });
  t.after(() => rmSync(shims, { recursive: true, force: true }));
  const r = run(['--local', '--list', '--json'], {
    shims, cwd: fx.repo, env: { HOME: fx.home },
  });
  const out = JSON.parse(r.stdout);
  const bySource = {};
  for (const w of out.worktrees) bySource[w.source] = (bySource[w.source] ?? 0) + 1;
  // the main clone is `other`; the gwq worktree is `gwq`; the herdr one is
  // `herdr`; the four .claude ones are `claude`.
  assert.equal(bySource.other, 1, JSON.stringify(out.worktrees, null, 2));
  assert.equal(bySource.gwq, 1);
  assert.equal(bySource.herdr, 1);
  assert.equal(bySource.claude, 4);
});

test('--local --source other is the main clone alone', (t) => {
  const fx = realHome();
  t.after(() => rmSync(fx.home, { recursive: true, force: true }));
  const shims = homeShim({ base: fx.base, ghqRoot: fx.ghqRoot });
  t.after(() => rmSync(shims, { recursive: true, force: true }));
  const r = run(['--local', '--list', '--source', 'other'], {
    shims, cwd: fx.repo, env: { HOME: fx.home },
  });
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines, [fx.repo]);
});

// ── overlapping roots, and more than one ghq root ────────────────────────────
//
// I7c makes three claims about root geometry that the sibling-root fixture
// above cannot exercise, because its three roots never overlap. All three were
// found by review, two of them as live bugs.

// A shim whose `gwq config get` and `ghq root --all` answers are chosen per
// test, so root geometry is the thing under test.
function geometryShim({ basedir, ghqRoots }) {
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-geo-'));
  const write = (name, body) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  };
  write('gwq', `#!/bin/sh
[ "$1" = "--version" ] && { echo "gwq version v0.1.1"; exit 0; }
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "${basedir}"; exit 0; fi
echo "gwq: slow path taken" >&2
exit 9
`);
  // Only --all lists every root; plain `ghq root` gives the primary one. That
  // asymmetry is the bug this shim reproduces.
  write('ghq', `#!/bin/sh
[ "$1" = "--version" ] && { echo "ghq version 1.10.1"; exit 0; }
if [ "$1" = "root" ] && [ "$2" = "--all" ]; then
${ghqRoots.map((r) => `  echo "${r}"`).join('\n')}
  exit 0
fi
if [ "$1" = "root" ]; then echo "${ghqRoots[0]}"; exit 0; fi
exit 9
`);
  write('fzf', `#!/bin/sh
[ "$1" = "--version" ] && { echo 0.74.1; exit 0; }
if [ "$1" = "--filter" ]; then out=$(grep -F -- "$2"); [ -n "$out" ] || exit 1; printf '%s\\n' "$out"; exit 0; fi
exit 2
`);
  return dir;
}

// One repository, one linked worktree, at paths the caller chooses.
function repoAt(root, { repoRel, worktreeRel, agentSlug }) {
  const home = realpathSync(root);
  const repo = join(home, repoRel);
  const gitEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const g = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: gitEnv });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@e.com');
  g(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'init');
  const out = { repo };
  if (worktreeRel) {
    out.worktree = join(home, worktreeRel);
    mkdirSync(dirname(out.worktree), { recursive: true });
    g(repo, 'worktree', 'add', '-q', '-b', 'feat/one', out.worktree);
  }
  if (agentSlug) {
    out.agent = join(repo, '.claude', 'worktrees', agentSlug);
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
    g(repo, 'worktree', 'add', '-q', '-b', `agent/${agentSlug}`, out.agent);
  }
  return out;
}

test('a second ghq root is searched — `ghq root` alone names only the first', (t) => {
  // Plain `ghq root` prints the primary root only, so every agent worktree
  // under any other configured root was invisible, silently, exit 0. That is
  // the failure class I1b exists to prevent.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-2root-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const a = repoAt(home, { repoRel: 'rootA/github.com/o/repoA', agentSlug: 'agent-in-a' });
  const b = repoAt(home, { repoRel: 'rootB/github.com/o/repoB', agentSlug: 'agent-in-b' });
  // The basedir must exist, or discovery takes the gwq fallback and this test
  // would be measuring that instead of the ghq roots.
  mkdirSync(join(home, 'worktrees'), { recursive: true });
  const shims = geometryShim({
    basedir: join(home, 'worktrees'),
    ghqRoots: [join(home, 'rootB'), join(home, 'rootA')],
  });
  t.after(() => rmSync(shims, { recursive: true, force: true }));

  const r = run(['--list'], { shims, env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.includes(b.agent), `primary root missing:\n${r.stdout}`);
  assert.ok(lines.includes(a.agent), `second ghq root was not searched:\n${r.stdout}`);
});

test('a gwq basedir nested under the ghq root keeps its worktrees', (t) => {
  // I7c: skipping a root nested inside another "would drop a worktree.basedir
  // configured under the ghq root and lose every gwq worktree". Nothing tested
  // it, and both natural implementations of that mistake passed the suite.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-nest-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = repoAt(home, {
    repoRel: 'ghq/github.com/o/repo',
    worktreeRel: 'ghq/.worktrees/github.com/o/repo/feat-one',
    agentSlug: 'agent-x',
  });
  const shims = geometryShim({
    basedir: join(home, 'ghq', '.worktrees'),
    ghqRoots: [join(home, 'ghq')],
  });
  t.after(() => rmSync(shims, { recursive: true, force: true }));

  const r = run(['--list', '--json'], { shims, env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const byPath = new Map(out.worktrees.map((w) => [w.path, w.source]));
  assert.equal(byPath.get(fx.worktree), 'gwq', `the nested basedir was skipped:\n${r.stdout}`);
  assert.equal(byPath.get(fx.agent), 'claude');
  assert.ok(!byPath.has(fx.repo), 'the main clone must not appear');
});

test('a gwq basedir that is an ancestor of the ghq root does not leak main clones', (t) => {
  // The other direction of the same overlap. Here the gwq walk reaches every
  // main clone and used to emit all of them as gwq worktrees, breaking I7c's
  // "the main clone does not appear". First-writer-wins cannot help: a
  // peek-only root records nothing, so it never wins the race.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-anc-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = repoAt(home, { repoRel: 'ghq/github.com/o/repo', agentSlug: 'agent-y' });
  const shims = geometryShim({ basedir: home, ghqRoots: [join(home, 'ghq')] });
  t.after(() => rmSync(shims, { recursive: true, force: true }));

  const r = run(['--list'], { shims, env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(!lines.includes(fx.repo), `the main clone leaked as a gwq worktree:\n${r.stdout}`);
  assert.ok(lines.includes(fx.agent), `the agent worktree should still be found:\n${r.stdout}`);
});

test('the same worktree reachable from two roots is listed once', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-dup-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = repoAt(home, { repoRel: 'ghq/github.com/o/repo', agentSlug: 'agent-z' });
  // Same directory named twice, once as the basedir and once as an ghq root.
  const shims = geometryShim({
    basedir: join(home, 'ghq'),
    ghqRoots: [join(home, 'ghq')],
  });
  t.after(() => rmSync(shims, { recursive: true, force: true }));

  const r = run(['--list'], { shims, env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(lines, [fx.agent], `expected exactly the agent worktree:\n${r.stdout}`);
  assert.equal(new Set(lines).size, lines.length, 'no duplicates');
});

test('the gwq fallback supplements the other roots instead of replacing them', (t) => {
  // With the basedir gone, `gwq list -g --json` is the only way to learn the
  // gwq worktrees — and an earlier cut returned *only* the fallback's entries,
  // or skipped the fallback entirely because a herdr worktree had made the
  // list non-empty. Both were silent losses.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-supp-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = repoAt(home, {
    repoRel: 'ghq/github.com/o/repo',
    worktreeRel: '.herdr/worktrees/repo/worktree-brave',
  });
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-suppshim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gwqJson = JSON.stringify([
    { path: '/elsewhere/api/main', branch: 'main', commit_hash: 'aaa', is_main: true },
    { path: '/elsewhere/api/feat-login', branch: 'feat/login', commit_hash: 'bbb', is_main: false },
  ]);
  writeFileSync(join(dir, 'gwq'), `#!/bin/sh
[ "$1" = "--version" ] && { echo v0.1.1; exit 0; }
if [ "$1" = "config" ]; then echo "${join(home, 'gone')}"; exit 0; fi
if [ "$1" = "list" ]; then cat <<'J'
${gwqJson}
J
exit 0; fi
exit 0
`);
  chmodSync(join(dir, 'gwq'), 0o755);
  writeFileSync(join(dir, 'ghq'), `#!/bin/sh
[ "$1" = "--version" ] && { echo 1.10.1; exit 0; }
[ "$1" = "root" ] && { echo "${join(home, 'ghq')}"; exit 0; }
exit 9
`);
  chmodSync(join(dir, 'ghq'), 0o755);
  writeFileSync(join(dir, 'fzf'), `#!/bin/sh
[ "$1" = "--version" ] && { echo 0.74.1; exit 0; }
if [ "$1" = "--filter" ]; then out=$(grep -F -- "$2"); [ -n "$out" ] || exit 1; printf '%s\\n' "$out"; exit 0; fi
exit 2
`);
  chmodSync(join(dir, 'fzf'), 0o755);

  const r = run(['--list'], { shims: dir, env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.includes('/elsewhere/api/feat-login'), `the fallback's gwq worktrees are missing:\n${r.stdout}`);
  assert.ok(lines.includes(fx.worktree), `the herdr worktree was replaced by the fallback:\n${r.stdout}`);
});

test('an empty but walkable basedir does not drag in the 43-second fallback', (t) => {
  // The fallback is for a basedir that cannot be walked. An empty one is a
  // truthful empty gwq source, and routing it to `gwq list -g` would put the
  // slow path back on an ordinary machine.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-empty-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = repoAt(home, { repoRel: 'ghq/github.com/o/repo', agentSlug: 'agent-w' });
  mkdirSync(join(home, 'worktrees'), { recursive: true });
  const shims = geometryShim({
    basedir: join(home, 'worktrees'),
    ghqRoots: [join(home, 'ghq')],
  });
  t.after(() => rmSync(shims, { recursive: true, force: true }));

  const r = run(['--list'], { shims, env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [fx.agent]);
  assert.doesNotMatch(r.stderr, /slow path/, '`gwq list` must not be reached');
});

test('$GHQ_ROOT is the fallback when there is no ghq binary, and it takes a list', (t) => {
  // Deleting this branch of ghqRoots() passed the whole suite, because run()
  // scrubs GHQ_ROOT and nothing set it back. It is the only path that supports
  // several roots without ghq installed, so it needs its own test.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-envroot-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const a = repoAt(home, { repoRel: 'envA/github.com/o/repoA', agentSlug: 'agent-envA' });
  const b = repoAt(home, { repoRel: 'envB/github.com/o/repoB', agentSlug: 'agent-envB' });
  mkdirSync(join(home, 'worktrees'), { recursive: true });
  // withGhq: false — no ghq on PATH at all, so `ghq root --all` cannot answer.
  const shims = homeShim({ base: join(home, 'worktrees'), ghqRoot: '', withGhq: false });
  t.after(() => rmSync(shims, { recursive: true, force: true }));

  const r = run(['--list'], {
    shims,
    env: { HOME: home, GHQ_ROOT: `${join(home, 'envA')}:${join(home, 'envB')}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.includes(a.agent), `first $GHQ_ROOT entry not searched:\n${r.stdout}`);
  assert.ok(lines.includes(b.agent), `second $GHQ_ROOT entry not searched:\n${r.stdout}`);
  assert.ok(!lines.includes(a.repo), 'main clones stay out');
});

test('$GHQ_ROOT loses to a working ghq, which is the authority', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-envlose-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const real = repoAt(home, { repoRel: 'ghq/github.com/o/repo', agentSlug: 'agent-real' });
  const decoy = repoAt(home, { repoRel: 'decoy/github.com/o/repo', agentSlug: 'agent-decoy' });
  mkdirSync(join(home, 'worktrees'), { recursive: true });
  const shims = geometryShim({
    basedir: join(home, 'worktrees'),
    ghqRoots: [join(home, 'ghq')],
  });
  t.after(() => rmSync(shims, { recursive: true, force: true }));

  const r = run(['--list'], {
    shims,
    env: { HOME: home, GHQ_ROOT: join(home, 'decoy') },
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.includes(real.agent), `ghq's own answer was ignored:\n${r.stdout}`);
  assert.ok(!lines.includes(decoy.agent), `$GHQ_ROOT overrode a working ghq:\n${r.stdout}`);
});

// ── the emitted function, actually run ───────────────────────────────────────
//
// A syntax check never caught this: with the function installed, every flag
// whose output goes to stdout was captured and handed to `cd`. `--version`
// became "no such file or directory: gwqcd x.y.z" and `--help` became
// "file name too long". Run the function for real.

// I3 step 1 is "PATH first", which means that with a global gwqcd installed
// these tests were running *that* binary and not the one under review — and
// `assert.match(stdout, /^gwqcd \d+\.\d+\.\d+/)` passed either way. Pin PATH
// to a directory holding only node, so step 1 finds nothing and the snippet
// falls through to its baked-in path (step 2), which is this working copy.
const NODE_ONLY = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-nodeonly-'));
  symlinkSync(process.execPath, join(dir, 'node'));
  // Module-level, so it outlives every test; `exit` is the only hook that
  // covers both a clean finish and a failing one.
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  return dir;
})();

// The shell itself is launched by absolute path, because the pinned PATH below
// deliberately excludes the directories a shell may live in — fish is under
// /opt/homebrew/bin on this machine and would not be found otherwise.
function shellPath(shell) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, shell);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// PATH holds node and the system directories git lives in, and nothing else, so
// I3 step 1 finds no gwqcd and the snippet falls through to its baked-in path.
const shellEnv = () => {
  const env = { ...process.env, PATH: `${NODE_ONLY}:/usr/bin:/bin`, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return env;
};

function shellRun(shell, args) {
  const bin = shellPath(shell);
  const init = run(['--init', shell]).stdout;
  return spawnSync(bin, ['-c', `${init}\ngwqcd ${args.join(' ')}`], {
    encoding: 'utf8', env: shellEnv(),
  });
}

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`the ${shell} function passes --version through instead of cd'ing into it`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    // The version of *this* working copy, so a globally installed gwqcd
    // answering instead is a failure rather than a pass.
    assert.match(r.stdout, new RegExp(`^gwqcd ${PKG_VERSION.replaceAll('.', '\\.')}$`, 'm'),
      `the emitted function must run this copy, not another gwqcd on PATH:\n${r.stdout}`);
    assert.doesNotMatch(r.stderr, /cd:|no such file|not a directory/);
  });

  test(`the ${shell} function passes --help through`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /USAGE/);
    assert.doesNotMatch(r.stderr, /file name too long|cd:/);
  });
}

test('the emitted snippet tells people to use `command`', () => {
  // `eval "$(<pkg> --init zsh)"` in ~/.zshrc resolves to the *function* on every
  // re-source after the first, and a stale function captures this very output
  // and hands it to cd. `command` skips functions. The header comment is the
  // line people copy, so it has to be the correct one.
  for (const shell of ['zsh', 'bash']) {
    const out = run(['--init', shell]).stdout;
    assert.match(out, /eval "\$\(command gwqcd --init (zsh|bash)\)"/,
      `${shell} header must recommend the command form`);
  }
  assert.match(run(['--init', 'fish']).stdout, /command gwqcd --init fish \| source/);
});

test('re-sourcing is idempotent even with a stale function defined', (t) => {
  if (spawnSync('zsh', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('zsh missing');
  const init = run(['--init', 'zsh']).stdout;
  // A pre-`command` function: captures stdout and cds into it, whatever it is.
  const stale = `gwqcd() { local d; d=$(echo stale) || return $?; builtin cd -- "$d"; }`;
  const script = [stale, init, 'gwqcd --version'].join('\n');
  const r = spawnSync(shellPath('zsh'), ['-c', script], {
    encoding: 'utf8', env: shellEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^gwqcd ${PKG_VERSION.replaceAll('.', '\\.')}$`, 'm'),
    'the new function must have replaced the stale one, and must be this copy');
  assert.doesNotMatch(r.stderr, /cd:|no such file/);
});
