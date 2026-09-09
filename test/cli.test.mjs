// Exercises the CLI with `gwq` and `fzf` shims on PATH: no network, no real
// worktrees, no TTY. The interactive fzf UI is covered by the manual matrix in
// CLAUDE.md — everything reachable without a terminal lives here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gwqcd.mjs');

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
  const childEnv = {
    ...process.env,
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: env?.HOME ?? ownHome,
    NO_COLOR: '1',
    ...env,
  };
  // We force NO_COLOR; node itself warns to stderr when FORCE_COLOR is also
  // set, so a developer who exports it would otherwise see phantom failures.
  delete childEnv.FORCE_COLOR;
  delete childEnv.GHQ_ROOT;
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

test('an agent that started an agent is found', () => {
  // The recursion lives in collectClaudeWorktrees, but the nested worktree in
  // the fixture sits under the ghq root, so it is only reachable once that root
  // is walked.
  const fx = realHome();
  const r = runIn(fx, ['--list']);
  rmSync(fx.home, { recursive: true, force: true });
  assert.ok(r.stdout.includes('quizzical-jumping-tome'), r.stdout);
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

test('without the ghq binary the ~/ghq fallback still finds agent worktrees', () => {
  // `ghq root` is asked first, but its absence is not the end of it: $GHQ_ROOT,
  // then ghq's own documented default of ~/ghq. The fixture home has one.
  const fx = realHome();
  const r = runIn(fx, ['--list'], { withGhq: false });
  const out = r.stdout;
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.repo, '.claude/worktrees/drifting-giggling-pond')), out);
});

test('no ghq at all leaves the gwq source untouched and does not exit 127', () => {
  // ghq is optional, unlike git (I1b): no binary and no ~/ghq means there is no
  // tree to search, which is today's correct behavior — not exit 127.
  const fx = realHome();
  const bare = mkdtempSync(join(tmpdir(), 'gwqcd-noghq-'));
  const shims = homeShim({ base: fx.base, ghqRoot: fx.ghqRoot, withGhq: false });
  const r = run(['--list'], { shims, env: { HOME: bare } });
  rmSync(shims, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  const out = r.stdout;
  rmSync(fx.home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(out.includes(join(fx.base, 'host/owner/repo/feat-one')), out);
  assert.doesNotMatch(out, /ghq\/host\/owner\/repo\/\.claude/, 'no ghq root to search');
});

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

// ── the emitted function, actually run ───────────────────────────────────────
//
// A syntax check never caught this: with the function installed, every flag
// whose output goes to stdout was captured and handed to `cd`. `--version`
// became "no such file or directory: gwqcd x.y.z" and `--help` became
// "file name too long". Run the function for real.

function shellRun(shell, args) {
  const init = run(['--init', shell]).stdout;
  const script = shell === 'fish'
    ? `${init}\ngwqcd ${args.join(' ')}`
    : `${init}\ngwqcd ${args.join(' ')}`;
  return spawnSync(shell, ['-c', script], { encoding: 'utf8' });
}

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`the ${shell} function passes --version through instead of cd'ing into it`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^gwqcd \d+\.\d+\.\d+/m);
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
  const r = spawnSync('zsh', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^gwqcd \d+\.\d+\.\d+/m, 'the new function must have replaced the stale one');
  assert.doesNotMatch(r.stderr, /cd:|no such file/);
});
