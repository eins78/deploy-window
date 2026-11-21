// covers: DWA-GEN-007, DWA-CMD-005, 006, DWA-LIM-001, DWA-ENV-002, DWA-AUD-001 (T-GEN-7, T-CMD-3, T-CMD-4, T-LIM-1,
// T-AUD-1 duration), as property tests against a reference written from spec 5.1
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { validateConfig } from '../src/config.js';
import { formatDuration, isDuration, parseDuration } from '../src/duration.js';
import { capFor, parseCommand } from '../src/grammar.js';

// FC_RUNS sets the number of runs per property (default 200, about a second in all); FC_SEED replays a failure.
const RUNS = Number(process.env.FC_RUNS ?? '200');
const SEED = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED);
function params<T>(examples: T[] = []): fc.Parameters<T> {
  return SEED === undefined ? { numRuns: RUNS, examples } : { numRuns: RUNS, seed: SEED, examples };
}

// ---- The reference, from the specification alone ----
//
// Spec 5.1: `duration = [ 1*2DIGIT "h" ] [ 1*3DIGIT "m" ]  ; at least one part; DIGIT = %x30-39`.
// The grammar is ABNF (RFC 5234), where a quoted string is case-insensitive (RFC 5234 section 2.3), so `H` and `M`
// are units too; G09 (`START 2H`, 120 min) shows it. DWA-CMD-005: only ASCII 0-9 are digits. No white space, sign or
// other character is part of a duration. Written as a scanner over UTF-16 code units, with no regular expression and
// no toLowerCase, so that it does not share a blind spot with the parser under test.

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isH = (c: number) => c === 0x68 || c === 0x48;
const isM = (c: number) => c === 0x6d || c === 0x4d;

/** Minutes, or undefined when the text is not a duration of the documented grammar. */
function referenceDuration(s: string): number | undefined {
  const digitsEnd = (from: number) => {
    let i = from;
    while (i < s.length && isDigit(s.charCodeAt(i))) i++;
    return i;
  };
  const value = (from: number, to: number) => {
    let v = 0;
    for (let i = from; i < to; i++) v = v * 10 + (s.charCodeAt(i) - 0x30);
    return v;
  };
  let pos = 0;
  let total = 0;
  let parts = 0;
  let end = digitsEnd(pos);
  if (end > pos && end - pos <= 2 && end < s.length && isH(s.charCodeAt(end))) {
    total += value(pos, end) * 60;
    parts++;
    pos = end + 1;
    end = digitsEnd(pos);
  }
  if (end > pos && end - pos <= 3 && end < s.length && isM(s.charCodeAt(end))) {
    total += value(pos, end);
    parts++;
    pos = end + 1;
  }
  return parts > 0 && pos === s.length ? total : undefined;
}

/** The largest duration the grammar can express: 99h999m. */
const MAX_DURATION_MINUTES = 99 * 60 + 999;

// ---- Generators ----

const chars = (s: string) => Array.from(s);
const codePoints = (...cps: number[]) => cps.map((cp) => String.fromCodePoint(cp));
const digitRun = (min: number, max: number) => fc.string({ unit: fc.constantFrom(...chars('0123456789')), minLength: min, maxLength: max });
const unit = (u: 'h' | 'm') => fc.constantFrom(u, u.toUpperCase());

/** Every form the grammar documents: hours only, minutes only, both; leading zeros; either case. */
const validDuration = fc.oneof(
  fc.tuple(digitRun(1, 2), unit('h')).map(([d, u]) => d + u),
  fc.tuple(digitRun(1, 3), unit('m')).map(([d, u]) => d + u),
  fc.tuple(digitRun(1, 2), unit('h'), digitRun(1, 3), unit('m')).map(([h, uh, m, um]) => h + uh + m + um),
);

// One-character edits that make near-misses: signs, white space of several kinds, separators, digits and units that
// look right but are not ASCII (fullwidth, Arabic-Indic, Devanagari, mathematical bold, superscript; fullwidth,
// Cyrillic and Planck-constant units), other unit words, and more ASCII digits and units (3-digit hours, 4-digit
// minutes, doubled parts).
const EDITS = [
  '+', '-', ' ', ...codePoints(0x09, 0x0a, 0x0d, 0xa0, 0x2009, 0x200b, 0x3000), '.', ',', '_', ':',
  '３', '٣', '३', '𝟑', '³', '½',
  'ｈ', 'ｍ', 'Ｈ', 'Ｍ', 'һ', 'м', '\u210e', '\u1d50', '\u212a',
  's', 'd', 'hr', 'min', 'hours', 'x',
  '0', '1', '9', '00', '999', 'h', 'm', 'H', 'M', '1h', '30m',
];

/** A documented form with one edit: inserted, replacing a character, or a character deleted. */
const nearMiss = fc
  .tuple(validDuration, fc.nat(), fc.constantFrom(...EDITS), fc.constantFrom('insert', 'replace', 'delete'))
  .map(([s, at, edit, how]) => {
    const i = at % (s.length + 1);
    if (how === 'insert') return s.slice(0, i) + edit + s.slice(i);
    if (how === 'replace') return s.slice(0, i) + edit + s.slice(i + 1);
    return s.slice(0, i) + s.slice(i + 1);
  });

/** Hand-picked near-misses and boundaries, so they run on every seed. */
const CLASSES = [
  '', ' ', 'h', 'm', 'hm', 'H', '30', '0', '30m\n', '\n30m', ' 30m', '30m ', '3 0m', '30 m', '1h 30m', '+30m', '-30m',
  '30m1h', '1h1h', '30m30m', '1.5h', '1,5h', '0x1fm', '1e2m', '100h', '1000m', '001h', '0030m', '99h999m', '00h000m',
  '0h', '0m', '99h1000m', '999h', '99999999999999999999m', '1h30', '30mm', '30min', '2hr', '３０m', '٣٠m', '30ｍ',
  '30м', '1ℎ', 'Infinity', 'NaN', '1H30M', '1h30M', '1H30m',
];

/** Short strings over the grammar's characters plus a few look-alikes: dense in valid and almost-valid text. */
const alphabetString = fc.string({
  unit: fc.constantFrom(...chars('0123456789hmHM +-.３ｈｍ')),
  maxLength: 10,
});

/** Any Unicode text, surrogate halves included. */
const anyString = fc.string({ unit: 'binary', maxLength: 12 });

const durationLike = fc.oneof(
  { arbitrary: validDuration, weight: 3 },
  { arbitrary: nearMiss, weight: 4 },
  { arbitrary: fc.constantFrom(...CLASSES), weight: 1 },
  { arbitrary: alphabetString, weight: 3 },
  { arbitrary: anyString, weight: 1 },
);

// ---- (a) parseDuration accepts exactly the documented grammar ----

void describe('parseDuration equals the reference from spec 5.1 (property)', () => {
  void it('the reference reads the documented examples', () => {
    const cases: [string, number | undefined][] = [
      ['30m', 30], ['2h', 120], ['1h30m', 90], ['4h', 240], ['2H', 120], ['0m', 0], ['3m', 3], ['25h', 1500],
      ['99h999m', 6939], ['90', undefined], ['３０m', undefined], ['30m45m', undefined], ['', undefined],
    ];
    for (const [s, minutes] of cases) assert.equal(referenceDuration(s), minutes, JSON.stringify(s));
  });

  void it('on generated strings, parseDuration and isDuration agree with the reference', (t) => {
    let accepted = 0;
    let total = 0;
    fc.assert(
      fc.property(durationLike, (s) => {
        const expected = referenceDuration(s);
        total++;
        if (expected !== undefined) accepted++;
        assert.equal(parseDuration(s), expected, `parseDuration(${JSON.stringify(s)})`);
        assert.equal(isDuration(s), expected !== undefined, `isDuration(${JSON.stringify(s)})`);
      }),
      params(CLASSES.map((s) => [s] as [string])),
    );
    t.diagnostic(`${String(accepted)} of ${String(total)} generated strings are durations`);
  });

  void it('every valid form parses to its hours and minutes, at most 99h999m', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 999 }), fc.boolean(), fc.boolean(), (h, m, upper, pad) => {
        const hs = (pad && h < 10 ? '0' : '') + String(h) + (upper ? 'H' : 'h');
        const ms = (pad && m < 100 ? '0' : '') + String(m) + (upper ? 'M' : 'm');
        assert.equal(parseDuration(hs + ms), h * 60 + m);
        assert.equal(parseDuration(hs), h * 60);
        assert.equal(parseDuration(ms), m);
        assert.ok(h * 60 + m <= MAX_DURATION_MINUTES);
      }),
      params(),
    );
  });

  // Not random: every code point in each position of a short duration. Case folding is where a parser that lower-cases
  // first could let in a character the grammar does not have (for example U+212A KELVIN SIGN folds to `k`).
  void it('no code point other than 0-9, h, H, m, M is part of a duration (exhaustive)', () => {
    const templates = [(c: string) => c, (c: string) => `1${c}`, (c: string) => `1${c}5m`, (c: string) => `1h5${c}`, (c: string) => `${c}5m`];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      for (const make of templates) {
        const s = make(c);
        if (parseDuration(s) !== referenceDuration(s)) assert.fail(`U+${cp.toString(16).toUpperCase()}: ${JSON.stringify(s)}`);
      }
    }
  });
});

// ---- (b) a duration the bot writes reads back as the same minutes ----

// formatDuration writes the duration of an accepted window (min_duration up to a cap) into the audit line, and the
// rate-limit window (60 minutes) into a reply. Every limit is read with parseDuration, so the values are 0 to 99h999m.
void describe('formatDuration writes a duration of the grammar (property)', () => {
  void it('parseDuration(formatDuration(n)) is n for every n the grammar can express', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_DURATION_MINUTES }), (n) => {
        const text = formatDuration(n);
        assert.equal(referenceDuration(text), n, `formatDuration(${String(n)}) is ${JSON.stringify(text)}`);
        assert.equal(parseDuration(text), n);
      }),
      params(),
    );
  });
});

// ---- (c) a window that parseCommand accepts never exceeds the lowest documented cap ----

// DWA-CFG-006: environment names match [A-Za-z][A-Za-z0-9_.-]{0,31} and are not a keyword.
const ENV_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const KEYWORDS = ['start', 'end', 'list', 'help'];
const TARGET = 'api';
/** Valid env names that every plain JavaScript object already has as a property: constructor, toString, ... */
const OBJECT_NAMES = Object.getOwnPropertyNames(Object.prototype).filter((n) => ENV_NAME.test(n));

const envName = fc
  .oneof(fc.stringMatching(ENV_NAME), fc.constantFrom('PROD', 'INTEG', 'Stage', 'dev'), fc.constantFrom(...OBJECT_NAMES))
  .filter((n) => !KEYWORDS.includes(n.toLowerCase()) && referenceDuration(n) === undefined && n.toLowerCase() !== TARGET);

/** The same ASCII name in any mix of case: names are case-insensitive (spec 5.1). */
const recased = (name: string) =>
  fc
    .array(fc.boolean(), { minLength: name.length, maxLength: name.length })
    .map((up) => chars(name).map((c, i) => (up[i] ? c.toUpperCase() : c.toLowerCase())).join(''));

/** One documented spelling of n minutes (n at most 99h999m), as a configuration file would hold it. */
function durationOf(n: number): string {
  const h = Math.min(99, Math.floor(n / 60));
  return `${String(h)}h${String(n - h * 60)}m`;
}

/** Any documented spelling of n minutes: hours or not, leading zeros, case. */
function spellings(n: number): fc.Arbitrary<string> {
  const lo = Math.max(0, Math.ceil((n - 999) / 60));
  const hi = Math.min(99, Math.floor(n / 60));
  return fc.record({ h: fc.integer({ min: lo, max: hi }), pad: fc.boolean(), upper: fc.boolean(), both: fc.boolean() }).map(({ h, pad, upper, both }) => {
    const m = n - h * 60;
    const hPart = `${pad && h < 10 ? '0' : ''}${String(h)}${upper ? 'H' : 'h'}`;
    const mPart = `${pad && m < 100 ? '0' : ''}${String(m)}${upper ? 'M' : 'm'}`;
    if (h === 0) return both ? hPart + mPart : mPart;
    if (m === 0) return both ? hPart + mPart : hPart;
    return hPart + mPart;
  });
}

interface Setup {
  envs: string[];
  defaultEnv: string | undefined;
  /** Undefined: the key is left out of the file, so the documented default applies. */
  minDuration: number | undefined;
  maxDuration: number | undefined;
  channelMax: number | undefined;
  /** Keys as written in the file. */
  envMax: [string, number][];
  namedEnv: string | undefined;
  namesTarget: boolean;
}

interface Scenario extends Setup {
  requested: number;
  tokens: string[];
}

const setup: fc.Arbitrary<Setup> = fc
  .tuple(fc.uniqueArray(envName, { minLength: 1, maxLength: 3, selector: (n) => n.toLowerCase() }), fc.option(fc.integer({ min: 1, max: 120 }), { nil: undefined }))
  .chain(([envs, minDuration]) => {
    const cap = fc.integer({ min: minDuration ?? 5, max: MAX_DURATION_MINUTES });
    return fc.record({
      envs: fc.constant(envs),
      defaultEnv: fc.option(fc.constantFrom(...envs), { nil: undefined }),
      minDuration: fc.constant(minDuration),
      maxDuration: fc.option(cap, { nil: undefined }),
      channelMax: fc.option(cap, { nil: undefined }),
      // Keys in any case (names are case-insensitive), so one env can have two entries; a YAML mapping holds a key once.
      envMax: fc.uniqueArray(fc.tuple(fc.constantFrom(...envs).chain(recased), cap), { maxLength: 3, selector: ([key]) => key }),
      namedEnv: fc.option(fc.constantFrom(...envs), { nil: undefined }),
      namesTarget: fc.boolean(),
    });
  });

function configData(s: Setup): unknown {
  const env_max_duration: Record<string, string> = {};
  for (const [key, minutes] of s.envMax) env_max_duration[key] = durationOf(minutes);
  const mute = [{ matchers: [{ name: 'target_id', value: 'example-api' }] }];
  return {
    version: 1,
    slack: { command: '/deploy', bot_token_env: 'DWA_SLACK_BOT_TOKEN', app_token_env: 'DWA_SLACK_APP_TOKEN' },
    grafana: { url: 'http://127.0.0.1:3000', token_env: 'DWA_GRAFANA_TOKEN' },
    limits: {
      max_message_length: 100,
      ...(s.minDuration === undefined ? {} : { min_duration: durationOf(s.minDuration) }),
      ...(s.maxDuration === undefined ? {} : { max_duration: durationOf(s.maxDuration) }),
    },
    auth: { allow_users: ['U0EXAMPLE01'] },
    channels: {
      C0EXAMPLE01: {
        environments: s.envs,
        ...(s.defaultEnv === undefined ? {} : { default_environment: s.defaultEnv }),
        ...(s.channelMax === undefined ? {} : { max_duration: durationOf(s.channelMax) }),
        env_max_duration,
        targets: { [TARGET]: Object.fromEntries(s.envs.map((e) => [e, mute])) },
      },
    },
  };
}

/** DWA-ENV-002: the env named, else the only env, else default_environment, else none. */
function documentedEnv(s: Setup): string | undefined {
  if (s.namedEnv !== undefined) return s.namedEnv;
  if (s.envs.length === 1) return s.envs[0];
  return s.defaultEnv;
}

/** DWA-LIM-001 defaults (5 minutes, 4 hours); DWA-CMD-006: the lowest of global, channel and the env's own cap. */
const documentedMin = (s: Setup) => s.minDuration ?? 5;
function documentedCap(s: Setup, env: string | undefined): number {
  const caps = [s.maxDuration ?? 240];
  if (s.channelMax !== undefined) caps.push(s.channelMax);
  if (env !== undefined) {
    for (const [key, minutes] of s.envMax) if (key.toLowerCase() === env.toLowerCase()) caps.push(minutes);
  }
  return Math.min(...caps);
}

/** Boundaries (the floor, every cap, one either side), or anything the grammar can express. */
const scenario: fc.Arbitrary<Scenario> = setup.chain((s) => {
  const caps = [s.maxDuration ?? 240, ...(s.channelMax === undefined ? [] : [s.channelMax]), ...s.envMax.map(([, m]) => m)];
  const edges = [documentedMin(s), documentedCap(s, documentedEnv(s)), ...caps]
    .flatMap((n) => [n - 1, n, n + 1])
    .filter((n) => n >= 0 && n <= MAX_DURATION_MINUTES);
  return fc
    .oneof(fc.constantFrom(...edges), fc.integer({ min: 0, max: MAX_DURATION_MINUTES }))
    .chain((requested) =>
      fc
        .tuple(spellings(requested), s.namedEnv === undefined ? fc.constant(undefined) : recased(s.namedEnv))
        .chain(([durationToken, envToken]) => {
          const tokens = [durationToken, ...(envToken === undefined ? [] : [envToken]), ...(s.namesTarget ? [TARGET] : [])];
          return fc.shuffledSubarray(tokens, { minLength: tokens.length }).map((order) => ({ ...s, requested, tokens: order }));
        }),
    );
});

const none = { defaultEnv: undefined, minDuration: undefined, maxDuration: undefined, channelMax: undefined, namedEnv: undefined };
/** Counterexamples, pinned so that they run first on every seed. */
const PINNED: [Scenario][] = [
  // An env named like an Object.prototype property and no env cap: the cap read the inherited function (NaN), so
  // 99h999m passed the default 4-hour cap.
  [{ ...none, envs: ['constructor'], envMax: [], namesTarget: false, requested: 6939, tokens: ['99h999m'] }],
  // Two env_max_duration keys for one env, differing in case: the later key won, not the lower cap.
  [{ ...none, envs: ['PROD'], envMax: [['PROD', 60], ['prod', 180]], namesTarget: false, requested: 120, tokens: ['2h'] }],
];

void describe('a window is never longer than the lowest documented cap (property)', () => {
  void it('parseCommand gives the documented outcome, and capFor is the lowest applicable cap', (t) => {
    const outcomes = new Map<string, number>();
    fc.assert(
      fc.property(scenario, (s) => {
        const config = validateConfig(configData(s));
        const channel = config.channels.get('C0EXAMPLE01');
        assert.ok(channel);
        const tokenMinutes = s.tokens.map(referenceDuration).filter((m) => m !== undefined);
        assert.deepEqual(tokenMinutes, [s.requested], 'generator: one duration token');

        const env = documentedEnv(s);
        const cap = documentedCap(s, env);
        const r = parseCommand(`start ${s.tokens.join(' ')}`, channel, config.limits);
        const outcome = r.ok ? 'accepted' : r.code;
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
        if (s.requested < documentedMin(s)) {
          assert.equal(outcome, 'duration_too_short');
        } else if (s.requested > cap) {
          assert.equal(outcome, 'duration_too_long');
          assert.ok(!r.ok && r.detail.includes(`${String(cap)} minutes`), 'the error text names the limit');
        } else if (env === undefined) {
          assert.equal(outcome, 'env_required');
        } else {
          assert.ok(r.ok && r.command.kind === 'start', `accepted, got ${outcome}`);
          // Written so that a NaN cap fails: the window is the duration typed, within the floor and the cap.
          assert.equal(r.command.duration, s.requested, 'no silent clamp');
          assert.ok(r.command.duration >= documentedMin(s) && r.command.duration <= cap, 'within the floor and the cap');
          assert.equal(r.command.env, env);
        }
        for (const e of [undefined, ...s.envs]) {
          assert.equal(capFor(channel, config.limits, e), documentedCap(s, e), `capFor(${String(e)})`);
        }
      }),
      params(PINNED),
    );
    t.diagnostic([...outcomes].map(([k, n]) => `${k} ${String(n)}`).join(', '));
  });
});
