# Worktree Picker UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make branches and detached revisions recognizable and searchable in the interactive picker without losing exact navigation paths.

**Architecture:** Main CLI resolves candidate metadata before interactive picking. A focused picker module builds safe display rows and provides a preview entry point; main maps returned keys to original paths. Machine output and noninteractive matching retain their contracts.

**Tech Stack:** Node ESM, node:test, fzf, Git, Docker/tmux browser terminal.

## Global Constraints

- Node >= 20.12.0; zero runtime dependencies; JSON schemaVersion 1.
- Color-independent labels; full branch names; home-prefix shortening only.
- Preview below list; Ctrl-/ toggles; short terminals start with preview hidden.
- All selected paths come from the original candidate map, not rendered text.
- Interactive branch/path search; noninteractive queries remain path-only.

## Task 1: Picker presentation and safe preview

Files: create bin/picker.mjs and test/picker.test.mjs; modify bin/gwqcd.mjs.

Interfaces: pickerRows(paths, meta, {home, color}) returns [{key,path,text}].
Each key is base64url JSON of {path,branch,commit}; text is key + tab + styled
branch label + tab + display path. branchLabel(meta) returns actual branch,
detached@<8-char SHA>, or (unavailable). preview(key) returns full details and
Git history using spawnSync with separate arguments.

- [x] Add regression tests before implementation:

```js
assert.equal(branchLabel({branch:'feat/login',commit:'abcdef0123'}), 'feat/login');
assert.equal(branchLabel({branch:'',commit:'abcdef0123'}), 'detached@abcdef01');
assert.equal(branchLabel({branch:'',commit:''}), '(unavailable)');
const [row] = pickerRows(['/home/u/.codex/worktrees/id/repo'],
  new Map(), {home:'/home/u',color:false});
assert.equal(JSON.parse(Buffer.from(row.key,'base64url')).path, row.path);
assert.ok(row.text.includes('~/.codex/worktrees/id/repo'));
```

- [x] Run `node --test test/picker.test.mjs` and confirm missing-module failure.
- [x] Implement row construction, control-character escaping, 32-cell terminal tab stops (never truncate labels), and preview with full metadata/Git log. Invalid preview keys fail without running Git.
- [x] Integrate main with these fzf options:

```js
['--height=70%', '--layout=reverse', '--border', '--ansi',
 '--delimiter=\t', '--with-nth=2..', '--prompt=worktree> ',
 '--header=BRANCH / REVISION                 LOCATION\nType to search branch/path | Enter open | Esc cancel | Ctrl-/ preview',
 '--bind=ctrl-/:toggle-preview', '--preview-window=down,6,wrap']
```

Use `down,6,wrap,hidden` for stderr/stdout terminal rows below 24. Build preview
command from shell-quoted process.execPath and picker module path plus `{1}`.
Resolve selected key through the rows map and reject unknown keys as E_FZF.
Call resolveMeta(paths, byPath) only on the interactive pick branch, reusing
local and --no-main metadata already present.

- [x] Add CLI integration tests with a TTY preload and fzf stub to verify row transport, preview/options and exact --quiet output. Test unknown-key rejection and existing machine-mode contracts.
- [x] Run `npm test` and `npm pack --dry-run`; verify picker module is packaged.

## Task 2: Documentation, visual QA, and PR delivery

Files: README.md, CLAUDE.md, .claude/skills/gwqcd/SKILL.md, design/plan,
and screenshots under docs/verification/2026-09-14-docker/.

- [x] Update current UI, search and metadata-cost descriptions; remove the obsolete prohibition on branch columns. Keep historical benchmarks explicitly historical.
- [x] Run the new suite and real-tool smoke inside the existing dedicated Linux container with current bin/test/package files copied in. Run actual fzf through tmux: branch search, detached selection, Enter, Escape, preview toggle, narrow terminal.
- [x] Capture and inspect real terminal screenshots, record measured startup time, and request independent code review while completing the visual checks.
- [x] Commit, push to PR #2, update its description and post current screenshots. Verify remote head, body/comment, loaded images and clean local status.

Delivery: PR #2 updated; screenshot comment 5659131334 verified through the
GitHub API and browser (all three images loaded). Runtime source is 6ad5d69.
