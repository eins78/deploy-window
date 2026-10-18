// JSON-lines logging and audit (DWA-OPS-003, DWA-AUD-*). Secret values and token-shaped strings
// never reach a line (DWA-DEP-004).
import { appendFileSync } from 'node:fs';
import { redactTokenShapes } from './message.js';

export type Level = 'info' | 'warning' | 'error';

export interface Logger {
  log(level: Level, event: string, fields?: Record<string, unknown>): void;
  /** Audit lines go to stdout and, if configured, to an append-only file (DWA-AUD-005). */
  audit(event: string, fields: Record<string, unknown>, level?: Level): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  auditFile?: string;
  appendFile?: (path: string, line: string) => void;
  /** Values to remove from every line: the configured secrets (DWA-DEP-004). */
  secrets?: () => string[];
  now?: () => Date;
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join('REDACTED');
  }
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, '$1REDACTED');
  return redactTokenShapes(out);
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const append = opts.appendFile ?? ((path: string, line: string) => { appendFileSync(path, `${line}\n`, { mode: 0o640 }); });
  const now = opts.now ?? (() => new Date());
  const secrets = opts.secrets ?? (() => []);

  const line = (level: Level, event: string, fields: Record<string, unknown>): string => {
    const raw = JSON.stringify({ time: now().toISOString(), level, event, ...fields }, (_k, v: unknown) =>
      v instanceof Error ? { name: v.name, message: v.message } : v,
    );
    return redact(raw, secrets());
  };

  return {
    log(level, event, fields = {}) {
      write(line(level, event, fields));
    },
    audit(event, fields, level = 'info') {
      const l = line(level, event, { audit: true, ...fields });
      write(l);
      if (opts.auditFile !== undefined) {
        try {
          append(opts.auditFile, l);
        } catch (e) {
          write(line('error', 'audit_file_failed', { error: (e as Error).message }));
        }
      }
    },
  };
}
