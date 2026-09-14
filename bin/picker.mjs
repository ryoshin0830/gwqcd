import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function branchLabel(meta) {
  return meta?.branch || (meta?.commit ? `detached@${meta.commit.slice(0, 8)}` : '(unavailable)');
}

// Display controls as text; never let a path or commit message alter the TTY.
const displayText = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g,
  (c) => ({ '\t': '\\t', '\n': '\\n', '\r': '\\r' }[c]
    ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));

export function pickerRows(paths, meta, { home, color = false }) {
  return paths.map((path) => {
    const { branch = '', commit = '' } = meta.get(path) ?? {};
    const key = Buffer.from(JSON.stringify({ path, branch, commit })).toString('base64url');
    const label = displayText(branchLabel({ branch, commit }));
    const location = displayText(path.startsWith(home + '/') ? '~/' + path.slice(home.length + 1) : path);
    const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
    // fzf expands tabs by terminal cell width, including wide Japanese text.
    // The opaque first field is neither displayed nor searched.
    return { key, path, text: `${key}\t${paint(branch ? '1;36' : commit ? '33' : '31', label)}\t${paint('2', location)}` };
  });
}

export function preview(key) {
  const data = JSON.parse(Buffer.from(key, 'base64url').toString('utf8'));
  if (typeof data.path !== 'string' || typeof data.branch !== 'string' || typeof data.commit !== 'string') {
    throw new Error('invalid picker row');
  }
  const r = spawnSync('git', ['-C', data.path, 'log', '--color=never', '--oneline', '-8'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 });
  const history = r.status === 0 ? r.stdout.trimEnd().split('\n').map(displayText).join('\n')
    : 'Git history unavailable (worktree missing or unreadable).';
  return `Branch: ${displayText(branchLabel(data))}\nPath: ${displayText(data.path)}\nCommit: ${displayText(data.commit || '(unavailable)')}\n\n${history}\n`;
}

// Invoked by fzf with one shell-quoted, base64url field. Git always receives
// the decoded path as an argument, never as shell source or a display label.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(preview(process.argv[2] ?? ''));
  } catch {
    process.stderr.write('gwqcd: invalid preview selection\n');
    process.exitCode = 1;
  }
}
