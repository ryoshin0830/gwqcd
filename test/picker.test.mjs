import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { branchLabel, pickerRows, preview } from '../bin/picker.mjs';

test('branch labels distinguish real branches, detached commits and unavailable metadata', () => {
  assert.equal(branchLabel({ branch: 'feat/login', commit: 'abcdef0123' }), 'feat/login');
  assert.equal(branchLabel({ branch: '', commit: 'abcdef0123' }), 'detached@abcdef01');
  assert.equal(branchLabel({ branch: '', commit: '' }), '(unavailable)');
  assert.equal(branchLabel(undefined), '(unavailable)');
});

test('picker rows preserve exact paths while shortening only the home prefix', () => {
  const paths = ['/home/u/.codex/worktrees/id/repo', '/home/user/repo', '/tmp/引用 "x"\t$(touch nope)'];
  const branch = 'feature/日本語-and-a-long-branch-name-that-must-remain-searchable';
  const meta = new Map([[paths[0], { branch, commit: '12345678' }]]);
  const rows = pickerRows(paths, meta, { home: '/home/u', color: false });
  assert.equal(rows[0].text.split('\t')[1], branch);
  assert.equal(rows[0].text.split('\t')[2], '~/.codex/worktrees/id/repo');
  assert.equal(rows[1].text.split('\t')[2], paths[1]);
  for (const row of rows) {
    assert.equal(JSON.parse(Buffer.from(row.key, 'base64url')).path, row.path);
    assert.equal(row.text.split('\t').length, 3);
    assert.doesNotMatch(row.text, /[\n\r\x1b]/);
  }
  assert.ok(rows[2].text.includes('\\t'));
});

test('color is optional and never the only detached/unavailable indication', () => {
  const paths = ['/one', '/two'];
  const meta = new Map([['/one', { branch: '', commit: '1234567890' }]]);
  const colored = pickerRows(paths, meta, { home: '/home/u', color: true });
  assert.match(colored[0].text, /\x1b\[/);
  assert.match(colored[0].text, /detached@12345678/);
  assert.match(colored[1].text, /\(unavailable\)/);
});

test('preview uses the exact unusual path as a Git argument and shows full context', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gwqcd-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, '日本語 \' " $(not-a-command)\t repository');
  mkdirSync(path);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8', env: {
      ...process.env, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'feature/日本語');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(path, 'a'), 'test'); git('add', 'a'); git('commit', '-qm', 'preview commit');
  const commit = git('rev-parse', 'HEAD');
  const [row] = pickerRows([path], new Map([[path, { branch: 'feature/日本語', commit }]]), { home: root });
  const text = preview(row.key);
  assert.ok(text.includes('Branch: feature/日本語'));
  assert.ok(text.includes(commit));
  assert.ok(text.includes('preview commit'));
  assert.ok(text.includes('\\t repository'));
  assert.doesNotMatch(text, /\x1b/);
});

test('preview rejects malformed payloads and explains missing worktrees', () => {
  assert.throws(() => preview('not-json'));
  assert.throws(() => preview(Buffer.from(JSON.stringify({ path: 42 })).toString('base64url')));
  const [row] = pickerRows(['/nonexistent/gwqcd-preview'], new Map(), { home: '/home/u' });
  assert.match(preview(row.key), /Git history unavailable/);
});
