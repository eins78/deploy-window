// covers: DWA-CFG-001..013, DWA-AUTH-006, DWA-GRA-004 (T-CFG-1, 2, 3, 5, 6, 11, T-AUTH-6)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { load, dump } from 'js-yaml';
import { ConfigInvalid, configPath, DEFAULT_CONFIG_PATH, parseConfigText, validateConfig } from '../src/config.js';
import { MAX_COMMENT, formatMarker, markerOverhead } from '../src/marker.js';
import { CH_A, FIXTURE_YAML } from './helpers.js';

type Doc = Record<string, any>;
const base = (): Doc => load(FIXTURE_YAML) as Doc;

function errorsOf(doc: unknown): string[] {
  try {
    validateConfig(doc);
  } catch (e) {
    if (e instanceof ConfigInvalid) return e.errors.map((x) => `${x.path}: ${x.message}`);
    throw e;
  }
  return [];
}

function rejects(mutate: (d: Doc) => void, pattern: RegExp): void {
  const d = base();
  mutate(d);
  const errs = errorsOf(d);
  assert.ok(errs.some((e) => pattern.test(e)), `expected ${String(pattern)} in:\n${errs.join('\n')}`);
}

const chA = (d: Doc): Doc => d.channels[CH_A] as Doc;

void describe('loading (T-CFG-1, T-CFG-5)', () => {
  void it('the fixture is valid', () => {
    assert.deepEqual(errorsOf(base()), []);
  });
  void it('the path comes from DWA_CONFIG, default /etc/deploy-window/config.yaml', () => {
    assert.equal(configPath({ DWA_CONFIG: '/tmp/x.yaml' }), '/tmp/x.yaml');
    assert.equal(configPath({}), DEFAULT_CONFIG_PATH);
    assert.equal(DEFAULT_CONFIG_PATH, '/etc/deploy-window/config.yaml');
  });
  void it('channels are keyed by id; a name as key is rejected, the label is free text', () => {
    rejects((d) => { d.channels['#deploys'] = chA(d); }, /Slack channel id/);
    const c = parseConfigText(FIXTURE_YAML);
    assert.equal(c.channels.get(CH_A)?.label, '#deploys-example');
  });
  void it('defaults: rollback, select all, limits', () => {
    const c = parseConfigText(FIXTURE_YAML);
    const a = c.channels.get(CH_A);
    assert.equal(a?.onPartial, 'rollback');
    assert.equal(a?.select, 'all');
    assert.equal(c.limits.instance, 'dwa');
    assert.equal(c.limits.maxSilencesPerWindow, 20);
    assert.equal(c.limits.maxConcurrentWindows, 10);
  });
});

void describe('secrets are refused (T-CFG-2)', () => {
  // Built by concatenation so that the token-shape lint never sees a literal token.
  for (const value of ['xox' + 'b-123-456-abc', 'xox' + 'p-1-2', 'xap' + 'p-1-A0-123-abc', 'gls' + 'a_abcdef_123']) {
    void it(`value ${value.slice(0, 5)}…`, () => {
      rejects((d) => { chA(d).label = value; }, /looks like a token/);
    });
  }
  for (const key of ['token', 'password', 'secret']) {
    void it(`key ${key}`, () => {
      rejects((d) => { d.grafana[key] = 'abc'; }, /secret keys are not allowed/);
    });
  }
  void it('*_env names are fine', () => {
    assert.deepEqual(errorsOf(base()), []);
  });
});

void describe('every error is reported (T-CFG-3)', () => {
  void it('collects several errors in one run', () => {
    const d = base();
    d.grafana.url = 'http://127.0.0.1:3000/';
    chA(d).environments = ['INTEG', 'PROD', '30m'];
    d.limits.max_duration = '1m';
    const errs = errorsOf(d);
    assert.ok(errs.length >= 3, errs.join('\n'));
  });
});

void describe('rejections (T-CFG-6)', () => {
  const rows: [string, (d: Doc) => void, RegExp][] = [
    ['env named 30m', (d) => { chA(d).environments.push('30m'); }, /must match|duration/],
    ['env named 123', (d) => { chA(d).environments.push('123'); }, /must match/],
    ['env named a:b', (d) => { chA(d).environments.push('a:b'); }, /must match/],
    ['env named start', (d) => { chA(d).environments.push('start'); }, /keyword/],
    ['target named 2h', (d) => { chA(d).targets['2h'] = chA(d).targets.api; }, /looks like a duration/],
    ['target named 42', (d) => { chA(d).targets['42'] = chA(d).targets.api; }, /all digits/],
    ['target equal to env', (d) => { chA(d).targets.prod = chA(d).targets.api; }, /equals an environment/],
    ['env case-only duplicate', (d) => { chA(d).environments.push('prod'); }, /listed twice/],
    ['no target', (d) => { chA(d).targets = {}; }, /at least one target/],
    ['missing env mute', (d) => { delete chA(d).targets.web.PROD; }, /no mute definition for environment PROD/],
    ['extra env mute', (d) => { chA(d).targets.web.STAGE = chA(d).targets.web.PROD; }, /not in environments/],
    ['unknown version', (d) => { d.version = 2; }, /unknown version/],
    ['empty matchers', (d) => { chA(d).targets.web.PROD = [{ matchers: [] }]; }, /empty matchers/],
    ['trailing slash in url', (d) => { d.grafana.url = 'http://127.0.0.1:3000/'; }, /slash/],
    ['max below min', (d) => { d.limits.max_duration = '3m'; }, /below min_duration/],
    ['channel max below min', (d) => { chA(d).max_duration = '1m'; }, /below min_duration/],
    ['unknown env_max_duration key', (d) => { chA(d).env_max_duration = { STAGE: '1h' }; }, /not an environment/],
    ['regex without allow_regex', (d) => { chA(d).targets.web.PROD = [{ matchers: [{ name: 'a', value: 'x' }, { name: 'b', value: 'web-.+', is_regex: true }] }]; }, /allow_regex/],
    ['regex .*', (d) => { chA(d).targets.web.PROD = [{ allow_regex: true, matchers: [{ name: 'a', value: 'x' }, { name: 'b', value: '.*', is_regex: true }] }]; }, /matches everything/],
    ['regex matching the empty string', (d) => { chA(d).targets.web.PROD = [{ allow_regex: true, matchers: [{ name: 'a', value: 'x' }, { name: 'b', value: 'a?', is_regex: true }] }]; }, /empty string/],
    ['only a regex matcher', (d) => { chA(d).targets.web.PROD = [{ allow_regex: true, matchers: [{ name: 'b', value: 'web-.+', is_regex: true }] }]; }, /equality matcher/],
    ['empty matcher value', (d) => { chA(d).targets.web.PROD = [{ matchers: [{ name: 'a', value: '  ' }] }]; }, /empty or white-space/],
    ['on_partial other', (d) => { chA(d).on_partial = 'ignore'; }, /on_partial/],
    ['empty channel auth block (T-AUTH-6)', (d) => { chA(d).auth = {}; }, /no allowed user/],
    ['no allow list anywhere (T-AUTH-6)', (d) => { d.auth = {}; }, /no allowed user/],
    ['default_environment not listed', (d) => { chA(d).default_environment = 'STAGE'; }, /not in environments/],
    ['unknown key (typo)', (d) => { chA(d).enviroments = ['X']; }, /nrecognized key/],
    ['instance outside [a-z0-9]{1,16}', (d) => { d.limits.instance = 'Bad-Name'; }, /a-z0-9/],
    ['unknown alertmanager type', (d) => { d.grafana.url = 'ftp://x'; }, /http/],
  ];
  for (const [name, mutate, pattern] of rows) void it(name, () => { rejects(mutate, pattern); });

  void it('a channel auth block with allow_users only does not inherit global groups (DWA-CFG-012)', () => {
    const d = base();
    d.auth = { allow_usergroups: ['S0EXAMPLE01'] };
    chA(d).auth = { allow_users: ['U0EXAMPLE09'] };
    d.channels.C0CHANNELB1.auth = { allow_users: ['U0EXAMPLE09'] };
    d.channels.C0CHANNELC1.auth = { allow_users: ['U0EXAMPLE09'] };
    const c = validateConfig(d);
    assert.deepEqual(c.channels.get(CH_A)?.auth, { allowUsers: ['U0EXAMPLE09'], allowUsergroups: [] });
  });
  void it('a regex entry with allow_regex and an equality matcher is valid', () => {
    const d = base();
    chA(d).targets.web.PROD = [{ allow_regex: true, matchers: [{ name: 'env', value: 'prod' }, { name: 'host', value: 'web-[0-9]+', is_regex: true }] }];
    assert.deepEqual(errorsOf(d), []);
  });
  void it('env and target names match case-insensitively and keep the canonical spelling', () => {
    const d = base();
    chA(d).targets.api = { integ: chA(d).targets.api.INTEG, Prod: chA(d).targets.api.PROD };
    const c = validateConfig(d);
    assert.deepEqual([...(c.channels.get(CH_A)?.targets.get('api')?.keys() ?? [])], ['INTEG', 'PROD']);
  });
});

void describe('marker budget (T-CFG-11)', () => {
  const longNames = (d: Doc, signed: boolean) => {
    chA(d).environments = ['E'.repeat(32), 'PROD'];
    chA(d).default_environment = undefined;
    const t = 't'.repeat(63);
    chA(d).targets = { [t]: { ['E'.repeat(32)]: [{ matchers: [{ name: 'a', value: 'b' }] }], PROD: [{ matchers: [{ name: 'a', value: 'c' }] }] } };
    if (signed) d.marker_key_env = 'DWA_MARKER_KEY';
  };
  void it('the default 300 fits with the longest names, without signing', () => {
    const d = base();
    longNames(d, false);
    d.limits.max_message_length = 300;
    assert.deepEqual(errorsOf(d), []);
  });
  void it('rejects a max_message_length above 500 minus the overhead', () => {
    const d = base();
    longNames(d, true);
    d.limits.max_message_length = 300;
    assert.ok(errorsOf(d).some((e) => e.includes('max_message_length')));
    const overhead = markerOverhead({ instance: 'dwa', longestChannelId: 11, longestEnv: 32, longestTarget: 63, signed: true });
    const d2 = base();
    longNames(d2, true);
    d2.limits.max_message_length = MAX_COMMENT - overhead;
    assert.deepEqual(errorsOf(d2), []);
  });
  void it('property: marker plus the longest allowed message stays within 500 characters', () => {
    const key = Buffer.from('k');
    for (let i = 0; i < 200; i++) {
      const envLen = 1 + (i % 32);
      const tLen = 1 + ((i * 7) % 63);
      const instance = 'x'.repeat(1 + (i % 16));
      const signed = i % 2 === 0;
      const overhead = markerOverhead({ instance, longestChannelId: 11, longestEnv: envLen, longestTarget: tLen, signed });
      const msg = 'm'.repeat(MAX_COMMENT - overhead);
      const comment = formatMarker(
        { instance, windowId: 'abcdefgh', channelId: 'C0123456789ABCDE', env: 'E'.repeat(envLen), target: 't'.repeat(tLen), entries: 99, userId: 'U0123456789ABCDE', ts: '1234567890.123456' },
        msg,
        signed ? key : undefined,
      );
      assert.ok(comment.length <= MAX_COMMENT, `length ${String(comment.length)} at i=${String(i)}`);
    }
  });
});

void describe('example files (T-CFG-8 load part)', () => {
  void it('dump and reload is stable', () => {
    assert.deepEqual(errorsOf(load(dump(base()))), []);
  });
});
