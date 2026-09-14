# Codex Worktree Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover and select Codex App worktrees globally and label them consistently with --local.

**Architecture:** Extend the existing bounded directory walker with a Codex root. Reuse lazy metadata and source filtering; give Codex precedence over overlapping gwq roots and retain Claude precedence for nested agents.

**Tech Stack:** Node.js ESM, node:test, Git, existing gwq/fzf shims.

## Global Constraints

- Zero runtime dependencies; Node >= 20.12.0.
- Preserve schemaVersion 1, stdout/stderr discipline, existing gwq fallback, and lazy metadata.
- CODEX_HOME overrides ~/.codex when nonempty; its worktrees child is the discovery root.
- Missing or unreadable Codex roots contribute no candidates.
- Use the existing isolated worktree and codex/add-codex-worktree-source branch.

## Task 1: Discover and label Codex worktrees

**Files:** Modify bin/gwqcd.mjs and test/cli.test.mjs.

**Interfaces:** Existing discoverWorktrees() returns paths, sources and meta maps.
New codexRoot() returns the configured worktree root string. Existing sourceRoots()
provides canonical prefixes to classifySource() for local and fallback rows.

- [ ] Add a real detached worktree regression and scrub inherited CODEX_HOME in run().

```js
delete childEnv.CODEX_HOME;

test('Codex detached worktrees are globally discoverable', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gwqcd-codex-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = repoAt(home, {
    repoRel: 'ghq/host/o/repo',
    worktreeRel: '.codex/worktrees/4e86/general',
  });
  const detached = spawnSync('git', ['-C', fx.worktree, 'checkout', '--detach'], { encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  const base = join(home, 'worktrees');
  mkdirSync(base);
  const shims = homeShim({ base, ghqRoot: join(home, 'ghq') });
  t.after(() => rmSync(shims, { recursive: true, force: true }));
  const r = run(['--list', '--json'], { shims, env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 1);
  assert.deepEqual(out.worktrees[0], {
    path: fx.worktree, branch: '',
    commit: spawnSync('git', ['-C', fx.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    isMain: false, source: 'codex',
  });
});
```

- [ ] Run `node --test --test-name-pattern='Codex' test/cli.test.mjs`; expect failure because the candidate is missing.
- [ ] Add codex to SOURCES and help. Add the root to usableRoots specs after herdr, and assign its canonical prefix precedence during merging.

```js
function codexRoot() {
  return joinPath(expandTilde(process.env.CODEX_HOME || joinPath(homedir(), '.codex')), 'worktrees');
}

// Additional usableRoots spec:
{ dir: codexRoot(), emitAs: 'codex' }

// After roots have been canonicalized:
const codexPrefixes = roots.filter((r) => r.emitAs === 'codex').map((r) => r.dir);
// In the existing walk merge:
const source = e.source === 'claude' ? 'claude'
  : isUnder(e.path, codexPrefixes) ? 'codex' : e.source;
if (!found.has(e.path)) found.set(e.path, source);

// sourceRoots precedence:
[[codexRoot(), 'codex'], [dirs, 'gwq'], [herdrRoot(), 'herdr']]
```

- [ ] Expand real-Git regressions to cover named branches; codex-only, mixed and all filters; --quiet; --local; CODEX_HOME override, empty and tilde values; nested Claude agents; root overlap and symlink canonicalization; missing/unreadable roots; fallback supplementation. Reuse repoAt/homeShim and isolated HOME. Each test asserts returned paths, source, metadata or error contracts through the CLI.
- [ ] Run `npm test`; all existing and new cases must pass. Commit code and tests.

## Task 2: Document and verify the delivered interface

**Files:** Modify README.md, CLAUDE.md, .claude/skills/gwqcd/SKILL.md, package.json (description only), and this plan/spec status.

**Interfaces:** Public source enum gains codex; no JSON fields are removed.

- [ ] Add this source row to the user and agent tables:

```markdown
| `codex` | `$CODEX_HOME/worktrees/<id>/<repo>` (default `~/.codex/worktrees`) | Codex App |
```

- [ ] Explain CODEX_HOME override, detached branch values and --source codex. Include Codex in existing agent-worktree guidance. Update current root descriptions and enum lists; retain dated historical measurements as historical.
- [ ] Run `npm test`, `npm pack --dry-run`, and `git diff --check`. Confirm the package contains only intended runtime files.
- [ ] Run live `--list --json`, `--source codex`, `--quiet /Users/shin-ryo/.codex/worktrees/4e86/general`, and local selection. Compare branch, commit and isMain with Git. Compare six samples of `node bin/gwqcd.mjs --list` with the measured baseline median of 224.5 ms.
- [ ] Use a verification subagent to review changes against the design, while independently checking documentation and live behavior. Resolve concrete issues and rerun affected checks.
- [ ] Commit verified documentation, push the branch, and create a PR against main with gh-pr-body (--body-file). Fetch the PR back to verify head, base, diff and description; open its review panel in Codex and verify the open result.

## Progress and evidence

- Initial current-main baseline: 72 tests passed; 139 live entries (124 gwq, 14 claude, 1 herdr), no Codex paths.
- Baseline --list samples (ms): 277, 226, 243, 223, 218, 185; median 224.5.
