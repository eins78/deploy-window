// T-GEN-1, T-DEP-3: scan the tracked files for token shapes and, if DWA_DENY_LIST names a file,
// for the words in that private deny list. The deny list never lives in this repository.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TOKEN = /\b(?:xox[a-z]-[A-Za-z0-9-]{6,}|xapp-[0-9]-[A-Za-z0-9-]{6,}|glsa_[A-Za-z0-9_]{8,})/;
const exempt = (file: string) => file.startsWith('test/') || /\.example(\.|$)/.test(file) || file === 'LICENSE' || file === 'NOTICE';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f !== '' && f !== 'pnpm-lock.yaml');

const denyPath = process.env.DWA_DENY_LIST;
const deny = denyPath
  ? readFileSync(denyPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((w) => w.toLowerCase())
  : [];

let problems = 0;
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (TOKEN.test(line)) {
      problems++;
      console.log(`${file}:${String(i + 1)}: token-shaped string`);
    }
    if (!exempt(file)) {
      const lower = line.toLowerCase();
      for (const w of deny) {
        if (lower.includes(w)) {
          problems++;
          // Print the position only; the word itself is private.
          console.log(`${file}:${String(i + 1)}: matches the private deny list`);
        }
      }
    }
  });
}
console.log(`${String(files.length)} files scanned; deny list ${denyPath ? `with ${String(deny.length)} words` : 'not set (DWA_DENY_LIST)'}; ${String(problems)} problem(s)`);
process.exit(problems > 0 ? 1 : 0);
