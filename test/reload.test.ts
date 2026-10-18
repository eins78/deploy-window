// covers: DWA-CFG-004 (T-CFG-4), DWA-OPS-003 (T-OPS-3), DWA-DEP-004 (T-DEP-4), DWA-AUD-005 (T-AUD-4)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigInvalid, parseConfigText } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { reloadConfig } from '../src/reload.js';
import { FIXTURE_YAML } from './helpers.js';

void describe('SIGHUP reload (T-CFG-4)', () => {
  const current = parseConfigText(FIXTURE_YAML);
  void it('a good file replaces the configuration', () => {
    const lines: string[] = [];
    const next = reloadConfig('x', current, createLogger({ write: (l) => lines.push(l) }), () =>
      parseConfigText(FIXTURE_YAML.replace('max_message_length: 300', 'max_message_length: 100')));
    assert.equal(next.limits.maxMessageLength, 100);
    assert.match(lines[0] ?? '', /config_reloaded/);
  });
  void it('a change that needs a restart is refused as a whole', () => {
    const lines: string[] = [];
    const next = reloadConfig('x', current, createLogger({ write: (l) => lines.push(l) }), () =>
      parseConfigText(FIXTURE_YAML.replace('max_message_length: 300', 'max_message_length: 300, instance: other')));
    assert.equal(next, current);
    assert.match(lines[0] ?? '', /config_reload_needs_restart.*limits\.instance/);
  });
  void it('a bad file keeps the old one and logs the errors', () => {
    const lines: string[] = [];
    const next = reloadConfig('x', current, createLogger({ write: (l) => lines.push(l) }), () => {
      throw new ConfigInvalid([{ path: 'grafana.url', message: 'must not end with a slash' }]);
    });
    assert.equal(next, current);
    assert.match(lines[0] ?? '', /config_reload_failed.*grafana\.url/);
  });
});

void describe('log lines (T-OPS-3, T-DEP-4, T-AUD-4)', () => {
  void it('every line is JSON with time, level, event; secrets and token shapes are redacted', () => {
    const lines: string[] = [];
    const file: string[] = [];
    const log = createLogger({
      write: (l) => lines.push(l),
      auditFile: '/var/log/x',
      appendFile: (_p, l) => file.push(l),
      secrets: () => ['super-secret-grafana-token'],
    });
    log.log('error', 'grafana_unavailable', { error: new Error('auth failed for super-secret-grafana-token'), header: 'Authorization: Bearer abc.def' });
    log.audit('start', { message: `use ${'xap' + 'p-1-A0123-4567'} now` });
    for (const l of lines) {
      const o = JSON.parse(l) as Record<string, unknown>;
      assert.ok(typeof o.time === 'string' && typeof o.level === 'string' && typeof o.event === 'string');
    }
    const all = lines.join('\n');
    assert.doesNotMatch(all, /super-secret-grafana-token|Bearer abc|xapp-1/);
    assert.equal(file.length, 1);
    assert.equal(file[0], lines[1]);
  });
});
