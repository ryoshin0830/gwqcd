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

function run(args, { shims, cwd } = {}) {
  const dir = shims ?? makeShims();
  const childEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, NO_COLOR: '1' };
  // We force NO_COLOR; node itself warns to stderr when FORCE_COLOR is also
  // set, so a developer who exports it would otherwise see phantom failures.
  delete childEnv.FORCE_COLOR;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', env: childEnv, ...(cwd ? { cwd } : {}),
  });
  if (!shims) rmSync(dir, { recursive: true, force: true });
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
  if (spawnSync('fish', ['-c', 'true'], { stdio: 'ignore' }).error) {
    return t.skip('fish not installed');
  }
  const src = run(['--init', 'fish']).stdout;
  const r = spawnSync('fish', ['-n', '/dev/stdin'], { input: src, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
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
// `gwq list -g` took 7.6 seconds on 44 worktrees; walking gwq's base directory
// takes 12ms. These tests use a real basedir with real worktrees, because the
// walk, the pruning and the metadata all come from the filesystem and git.

function realBasedir() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-base-')));
  const repo = join(root, 'repo');
  const base = join(root, 'worktrees');
  mkdirSync(repo); mkdirSync(base);
  const g = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@e.com');
  g(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'init');
  // Two linked worktrees under the basedir, one nested in a subdirectory the
  // way gwq's template produces.
  mkdirSync(join(base, 'host', 'owner', 'repo'), { recursive: true });
  g(repo, 'worktree', 'add', '-q', '-b', 'feat/one', join(base, 'host', 'owner', 'repo', 'feat-one'));
  g(repo, 'worktree', 'add', '-q', '-b', 'feat/two', join(base, 'host', 'owner', 'repo', 'feat-two'));
  // A decoy that must not be walked into: files inside a worktree, including a
  // nested repository of its own. gwq reports these; they are not worktrees.
  const nested = join(base, 'host', 'owner', 'repo', 'feat-one', 'vendor', 'dep');
  mkdirSync(nested, { recursive: true });
  g(nested, 'init', '-q', '-b', 'main');
  return { root, repo, base, sha: g(repo, 'rev-parse', 'HEAD') };
}

// A gwq that only answers `config get worktree.basedir`; anything else would be
// the slow path, and reaching it here is a failure.
function basedirShim(base) {
  const dir = mkdtempSync(join(tmpdir(), 'gwqcd-bshim-'));
  const p = join(dir, 'gwq');
  writeFileSync(p, `#!/bin/sh
[ "$1" = "--version" ] && { echo "gwq version v0.1.1"; exit 0; }
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo "${base}"; exit 0; fi
echo "gwq: slow path taken" >&2
exit 9
`);
  chmodSync(p, 0o755);
  const fzf = join(dir, 'fzf');
  writeFileSync(fzf, `#!/bin/sh
[ "$1" = "--version" ] && { echo 0.74.1; exit 0; }
if [ "$1" = "--filter" ]; then out=$(grep -F -- "$2"); [ -n "$out" ] || exit 1; printf '%s\\n' "$out"; exit 0; fi
exit 2
`);
  chmodSync(fzf, 0o755);
  return dir;
}

test('worktrees are discovered by walking the base directory', () => {
  const fx = realBasedir();
  const shims = basedirShim(fx.base);
  const r = run(['--list'], { shims });
  rmSync(shims, { recursive: true, force: true });
  rmSync(fx.root, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const paths = r.stdout.trim().split('\n').sort();
  assert.equal(paths.length, 2, 'exactly the two linked worktrees');
  assert.ok(paths[0].endsWith('feat-one'));
  assert.ok(paths[1].endsWith('feat-two'));
  assert.doesNotMatch(r.stderr, /slow path/, 'gwq list must not be called');
});

test('the walk prunes at a worktree, so nested repositories are not listed', () => {
  // Descending into a worktree is what cost gwq its second-plus, and a vendored
  // submodule is not somewhere anyone wants to cd.
  const fx = realBasedir();
  const shims = basedirShim(fx.base);
  const r = run(['--list'], { shims });
  rmSync(shims, { recursive: true, force: true });
  rmSync(fx.root, { recursive: true, force: true });
  assert.doesNotMatch(r.stdout, /vendor\/dep/);
});

test('branch, commit and isMain come back correct — not the branch twice', () => {
  // `git rev-parse --abbrev-ref HEAD HEAD` abbreviates *both* revs, so the
  // first version of this shipped the branch name in the commit field.
  const fx = realBasedir();
  const shims = basedirShim(fx.base);
  const r = run(['--list', '--json'], { shims });
  rmSync(shims, { recursive: true, force: true });
  rmSync(fx.root, { recursive: true, force: true });
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 2);
  const one = out.worktrees.find((w) => w.path.endsWith('feat-one'));
  assert.equal(one.branch, 'feat/one');
  assert.match(one.commit, /^[0-9a-f]{40}$/, 'a sha, not the branch name');
  assert.equal(one.commit, fx.sha);
  assert.equal(one.isMain, false, 'a linked worktree is not the main one');
});

test('an unreadable or absent basedir falls back to gwq rather than failing', () => {
  const shims = basedirShim('/nonexistent/gwq/basedir');
  const r = run(['--json', 'x'], { shims });
  rmSync(shims, { recursive: true, force: true });
  // The shim's `list` exits 9, which is the fallback being reached — the point
  // is that it is reached at all rather than reporting an empty list.
  assert.equal(jsonLine(r.stderr).error.code, 'E_GWQ');
});
