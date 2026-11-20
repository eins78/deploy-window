// covers: DWA-GEN-007, DWA-CMD-005 (T-GEN-7, T-CMD-3), as property tests against a reference written from spec 5.1
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { isDuration, parseDuration } from '../src/duration.js';

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
