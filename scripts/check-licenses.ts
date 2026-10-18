// Every production dependency must carry a permissive licence compatible with Apache-2.0.
// PSF-2.0 is there for argparse (a js-yaml dependency).
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'Python-2.0', 'PSF-2.0']);
const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8' });
const byLicense = JSON.parse(out) as Record<string, { name: string; versions?: string[] }[]>;
let bad = 0;
for (const [license, pkgs] of Object.entries(byLicense)) {
  const ok = license.split(/\s+OR\s+|[()]/).some((l) => ALLOWED.has(l.trim()));
  for (const p of pkgs) {
    if (!ok) {
      bad++;
      console.log(`not allowed: ${p.name} (${license})`);
    }
  }
  console.log(`${license}: ${String(pkgs.length)} package(s)`);
}
process.exit(bad > 0 ? 1 : 0);
