// covers: DWA-GEN-001, 002, 007, DWA-CFG-002, DWA-DEP-001, 003, 008, DWA-OPS-004, 006, DWA-SLK-001, 005,
// DWA-CMD-010 (T-GEN-1, T-GEN-2, T-GEN-7, T-CFG-8, T-DEP-1, T-DEP-3, T-DEP-5, T-SLK-2, T-SLK-4, T-CMD-6, T-OPS-4)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import { loadConfigFile } from '../src/config.js';
import { parseCommand } from '../src/grammar.js';
import { makeHarness } from './helpers.js';

const read = (p: string) => readFileSync(p, 'utf8');

void describe('manifest (T-SLK-4, T-CMD-6, T-DEP-5)', () => {
  const m = load(read('manifest.example.yaml')) as Record<string, any>;
  void it('bot scopes are exactly commands and chat:write; Socket Mode on; no escaping', () => {
    assert.deepEqual(m.oauth_config.scopes.bot, ['commands', 'chat:write']);
    assert.equal(m.settings.socket_mode_enabled, true);
    assert.equal(m.features.slash_commands[0].should_escape, false);
    assert.equal(m.settings.interactivity.is_enabled, false);
    assert.equal(m.features.slash_commands[0].url, undefined);
  });
  void it('an escaped channel reference is an unknown token', () => {
    const c = loadConfigFile('config.example.yaml').channels.get('C0EXAMPLE01');
    assert.ok(c);
    const r = parseCommand('start 30m <#C0EXAMPLE01|deploys>', c, { minDuration: 5, maxDuration: 240, maxMessageLength: 300 });
    assert.equal(r.ok ? 'ok' : r.code, 'unknown_env_or_target');
  });
});

void describe('two example configurations on the same code (T-CFG-8, DWA-OPS-006)', () => {
  void it('org-a (paid plan): starts and ends a window', async () => {
    const config = loadConfigFile('config.example.yaml');
    const h = makeHarness({ config: { ...config, channels: new Map([...config.channels].map(([k, v]) => [k, { ...v, auth: { allowUsers: ['U0EXAMPLE01'], allowUsergroups: [] } }])) } });
    await h.run('start 30m PROD -- release 2.4', 'C0EXAMPLE01');
    assert.match(h.slack.lastUpdate(), /\*active\*/);
    assert.equal(h.grafana.active().length, 3);
    await h.run('start 61m PROD', 'C0EXAMPLE01'); // env_max_duration PROD 1h
    assert.match(h.slack.lastEphemeral(), /duration_too_long/);
    await h.run('end', 'C0EXAMPLE01');
    assert.equal(h.grafana.active().length, 0);
  });
  void it('org-b (Free plan): explicit select, 10-minute floor, 200-character messages', async () => {
    const config = loadConfigFile('config.free-plan.example.yaml');
    assert.equal(config.slack.command, '/window');
    const h = makeHarness({ config });
    const run = (t: string) => h.run(t, 'C0ORGB0001', 'U0ORGB0001');
    await run('start 30m');
    assert.match(h.slack.lastEphemeral(), /Name at least one target: shop, mail/);
    await run('start 9m shop');
    assert.match(h.slack.lastEphemeral(), /duration_too_short/);
    await run(`start 30m shop -- ${'x'.repeat(201)}`);
    assert.match(h.slack.lastEphemeral(), /message_too_long/);
    await run('start 30m shop');
    assert.deepEqual(h.grafana.creates[0]?.matchers.map((m) => m.value), ['shop', 'prod']);
    assert.match(h.slack.posts[0]?.text ?? '', /\/window list/);
  });
});

void describe('unit file (T-DEP-1)', () => {
  const unit = read('deploy/deploy-window.service.example');
  for (const flag of ['DynamicUser=yes', 'Restart=always', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectProc=invisible', 'PrivateTmp=yes', 'PrivateUsers=yes', 'CapabilityBoundingSet=\n', 'WatchdogSec=']) {
    void it(flag.trim(), () => { assert.ok(unit.includes(flag), flag); });
  }
});

void describe('repository content', () => {
  void it('no LLM client among the dependencies (T-GEN-2)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const n of names) assert.doesNotMatch(n, /openai|anthropic|langchain|llm|ollama|gemini|mistral|cohere/i);
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@slack/socket-mode', '@slack/web-api', 'js-yaml', 'zod']);
  });
  void it('the code opens no listening socket (T-SLK-2)', () => {
    for (const f of readdirSync('src')) {
      assert.doesNotMatch(read(`src/${f}`), /createServer|\.listen\(/, f);
    }
  });
  void it('the operator documents exist (T-OPS-4)', () => {
    const ops = read('docs/operations.md');
    for (const h of ['## Token rotation', '## Upgrade', '## Manual fallback']) assert.ok(ops.includes(h), h);
  });
  void it('only example configuration files are in the repository (DWA-DEP-003)', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n');
    assert.ok(!files.some((f) => /(^|\/)config\.ya?ml$|(^|\/)\.env$|(^|\/)env$/.test(f)));
  });
  void it('token-shape lint and the optional private deny list pass (T-GEN-1, T-DEP-3)', () => {
    // DWA_DENY_LIST names a private file outside this repository; without it only token shapes are checked.
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/lint-tokens.ts'], { stdio: 'pipe' });
  });
  void it('durations in configuration and commands use one parser (T-GEN-7)', () => {
    assert.match(read('src/config.ts'), /import \{ parseDuration \} from '\.\/duration\.js'/);
    assert.match(read('src/grammar.ts'), /import \{ parseDuration \} from '\.\/duration\.js'/);
  });
});
