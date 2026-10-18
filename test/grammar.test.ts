// covers: DWA-CMD-001..007, DWA-MSG-001..003, DWA-ENV-002, DWA-GEN-007 (T-CMD-1..5, T-CMD-7, T-MSG-1)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCommand, type ParseResult } from '../src/grammar.js';
import { slackEscape } from '../src/message.js';
import { CH_A, CH_B, CH_C, channel, fixtureConfig } from './helpers.js';

const config = fixtureConfig();
const fixtures = { A: channel(config, CH_A), B: channel(config, CH_B), C: channel(config, CH_C) };
const limits = config.limits;

type Expect =
  | { error: string }
  | { kind: 'help' | 'list' }
  | { kind: 'start'; env: string; targets?: string[]; duration: number; message?: string }
  | { kind: 'end'; env?: string; targets?: string[]; message?: string };

// Spec section 12. `targets` lists explicitly named targets; "all" means none named (select: all applies later).
const CASES: [string, 'A' | 'B' | 'C', string, Expect][] = [
  ['G01', 'B', 'start 30m', { kind: 'start', env: 'PROD', duration: 30 }],
  ['G02', 'A', 'start 30m', { kind: 'start', env: 'INTEG', duration: 30 }],
  ['G03', 'A', 'start 1h30m PROD -- release 2.4', { kind: 'start', env: 'PROD', duration: 90, message: 'release 2.4' }],
  ['G04', 'A', 'start PROD 30m', { kind: 'start', env: 'PROD', duration: 30 }],
  ['G05', 'A', 'start 30m integ api', { kind: 'start', env: 'INTEG', targets: ['api'], duration: 30 }],
  ['G06', 'A', 'start 30m PROD api,web', { kind: 'start', env: 'PROD', targets: ['api', 'web'], duration: 30 }],
  ['G07', 'A', 'start 30m PROD web api', { kind: 'start', env: 'PROD', targets: ['web', 'api'], duration: 30 }],
  ['G08', 'A', 'start 30m api,api', { kind: 'start', env: 'INTEG', targets: ['api'], duration: 30 }],
  ['G09', 'A', 'START 2H', { kind: 'start', env: 'INTEG', duration: 120 }],
  ['G10', 'A', 'start 30m -- a -- b', { kind: 'start', env: 'INTEG', duration: 30, message: 'a -- b' }],
  ['G11', 'A', 'start 30m — phone dash', { kind: 'start', env: 'INTEG', duration: 30, message: 'phone dash' }],
  ['G12', 'A', 'start 30m --', { kind: 'start', env: 'INTEG', duration: 30, message: '' }],
  ['G13', 'A', 'start 30m -- <!channel> <@U123|someone> & "q"', { kind: 'start', env: 'INTEG', duration: 30, message: '<!channel> <@U123|someone> & "q"' }],
  ['G14', 'A', 'start 30m -- api PROD 99m', { kind: 'start', env: 'INTEG', duration: 30, message: 'api PROD 99m' }],
  ['G15', 'A', 'start 30m -- line1\nline2', { kind: 'start', env: 'INTEG', duration: 30, message: 'line1 line2' }],
  ['G16', 'C', 'start 30m', { error: 'env_required' }],
  ['G17', 'A', 'start', { error: 'duration_missing' }],
  ['G18', 'A', 'start PROD', { error: 'duration_missing' }],
  ['G19', 'A', 'start 0m', { error: 'duration_too_short' }],
  ['G20', 'A', 'start 3m', { error: 'duration_too_short' }],
  ['G21', 'A', 'start 25h', { error: 'duration_too_long' }],
  ['G22', 'A', 'start 90', { error: 'duration_needs_unit' }],
  ['G23', 'A', 'start 30m 45m', { error: 'duplicate_duration' }],
  ['G24', 'A', 'start 30m PROD INTEG', { error: 'duplicate_env' }],
  ['G25', 'A', 'start 30m nosuch', { error: 'unknown_env_or_target' }],
  ['G26', 'A', 'start 30m STAGE', { error: 'unknown_env_or_target' }],
  ['G27', 'A', 'start 30m api.*', { error: 'unknown_env_or_target' }],
  ['G28', 'A', 'start 30m api,,web', { error: 'empty_list_item' }],
  ['G29', 'A', `start 30m -- ${'x'.repeat(301)}`, { error: 'message_too_long' }],
  ['G30', 'A', 'start ３０m', { error: 'unknown_env_or_target' }],
  ['G31', 'A', `start 30m -- ${'x'.repeat(300)}`, { kind: 'start', env: 'INTEG', duration: 30, message: 'x'.repeat(300) }],
  ['G32', 'A', 'end', { kind: 'end' }],
  ['G33', 'A', 'end PROD api', { kind: 'end', env: 'PROD', targets: ['api'] }],
  ['G34', 'A', 'end -- deploy done', { kind: 'end', message: 'deploy done' }],
  ['G35', 'A', 'end 30m', { error: 'unexpected_duration' }],
  ['G36', 'C', 'end', { kind: 'end' }],
  ['G37', 'A', 'list', { kind: 'list' }],
  ['G38', 'A', 'list PROD', { error: 'unexpected_argument' }],
  ['G39', 'A', '', { kind: 'help' }],
  ['G40', 'A', 'help', { kind: 'help' }],
  ['G41', 'A', 'stop', { error: 'unknown_subcommand' }],
  ['G42', 'A', '30m', { error: 'unknown_subcommand' }],
  ['G43', 'A', 'list 30m', { error: 'unexpected_argument' }],
  ['G44', 'A', 'help foo', { error: 'unexpected_argument' }],
  ['G45', 'A', '-- just a message', { kind: 'help' }],
  ['G46', 'A', 'start 30m api, web', { error: 'empty_list_item' }],
  ['G47', 'A', 'start 30m--x', { error: 'unknown_env_or_target' }],
  ['G48', 'A', 'end PROD 30m', { error: 'unexpected_duration' }],
];

function check(r: ParseResult, e: Expect): void {
  if ('error' in e) {
    assert.equal(r.ok ? `ok:${r.command.kind}` : r.code, e.error);
    return;
  }
  assert.ok(r.ok, r.ok ? '' : `${r.code}: ${r.detail}`);
  const c = r.command;
  assert.equal(c.kind, e.kind);
  if (c.kind === 'start' && e.kind === 'start') {
    assert.equal(c.env, e.env);
    assert.equal(c.duration, e.duration);
    assert.deepEqual(c.targets, e.targets ?? []);
    assert.equal(c.message, e.message ?? '');
  }
  if (c.kind === 'end' && e.kind === 'end') {
    assert.equal(c.env, e.env);
    assert.deepEqual(c.targets, e.targets ?? []);
    assert.equal(c.message, e.message ?? '');
  }
}

void describe('grammar cases G01–G48 (T-CMD-1)', () => {
  assert.equal(CASES.length, 48);
  for (const [id, ch, input, expected] of CASES) {
    void it(`${id}: ${JSON.stringify(input).slice(0, 50)}`, () => {
      check(parseCommand(input, fixtures[ch], limits), expected);
    });
  }

  void it('G13 escapes to the Slack-safe form', () => {
    const r = parseCommand('start 30m -- <!channel> <@U123|someone> & "q"', fixtures.A, limits);
    assert.ok(r.ok && r.command.kind === 'start');
    assert.equal(slackEscape(r.command.message), '&lt;!channel&gt; &lt;@U123|someone&gt; &amp; "q"');
  });
});

void describe('separators (T-CMD-2)', () => {
  void it('accepts the en dash like -- and the em dash', () => {
    const r = parseCommand('start 30m – en dash', fixtures.A, limits);
    assert.ok(r.ok && r.command.kind === 'start');
    assert.equal(r.command.message, 'en dash');
  });
  void it('a dash inside a token is not a separator', () => {
    const r = parseCommand('start 30m a—b', fixtures.A, limits);
    assert.equal(r.ok ? 'ok' : r.code, 'unknown_env_or_target');
  });
});

void describe('caps (T-CMD-4)', () => {
  void it('channel cap: B allows 2h, not 2h1m', () => {
    assert.ok(parseCommand('start 2h', fixtures.B, limits).ok);
    const r = parseCommand('start 2h1m', fixtures.B, limits);
    assert.equal(r.ok ? 'ok' : r.code, 'duration_too_long');
    assert.match(r.ok ? '' : r.detail, /120 minutes/);
  });
  void it('env_max_duration is lower than the global cap', () => {
    const c = fixtureConfig().channels.get(CH_A);
    assert.ok(c);
    c.envMaxDuration.PROD = 60;
    assert.ok(parseCommand('start 1h PROD', c, limits).ok);
    assert.ok(parseCommand('start 2h INTEG', c, limits).ok);
    const r = parseCommand('start 61m PROD', c, limits);
    assert.equal(r.ok ? 'ok' : r.code, 'duration_too_long');
  });
  void it('min_duration comes from the configuration', () => {
    const r = parseCommand('start 9m', fixtures.A, { ...limits, minDuration: 10 });
    assert.equal(r.ok ? 'ok' : r.code, 'duration_too_short');
  });
});

void describe('which error wins (T-CMD-7)', () => {
  const order: [string, string][] = [
    ['stop 30m,,x', 'unknown_subcommand'],
    ['list a,,b', 'empty_list_item'],
    ['start 90 nosuch', 'duration_needs_unit'],
    ['start nosuch 30m 45m', 'unknown_env_or_target'],
    ['start 30m 45m PROD INTEG', 'duplicate_duration'],
    ['start PROD INTEG', 'duplicate_env'],
    ['start 3m', 'duration_too_short'],
    [`start 25h -- ${'x'.repeat(400)}`, 'duration_too_long'],
    [`start 30m -- ${'x'.repeat(400)}`, 'message_too_long'],
  ];
  for (const [input, code] of order) {
    void it(`${input.slice(0, 30)} → ${code}`, () => {
      const r = parseCommand(input, fixtures.A, limits);
      assert.equal(r.ok ? 'ok' : r.code, code);
    });
  }
  void it('C: a too-long duration wins over env_required', () => {
    const r = parseCommand('start 5h', fixtures.C, limits);
    assert.equal(r.ok ? 'ok' : r.code, 'duration_too_long');
  });
});

void describe('message (T-MSG-1, T-MSG-4)', () => {
  void it('replaces bidi, zero-width, line separators and C1 controls; counts code points', () => {
    const r = parseCommand('start 30m -- a‮b​c d\u0085e', fixtures.A, limits);
    assert.ok(r.ok && r.command.kind === 'start');
    assert.equal(r.command.message, 'a b c d e');
    const emoji = '\u{1F600}'.repeat(300);
    assert.ok(parseCommand(`start 30m -- ${emoji}`, fixtures.A, limits).ok);
  });
  void it('a message after a separator is never parsed (DWA-MSG-004)', () => {
    const r = parseCommand('start 30m -- target_id=other .*', fixtures.A, limits);
    assert.ok(r.ok && r.command.kind === 'start');
    assert.deepEqual(r.command.targets, []);
  });
});
