// covers: DWA-CHN-*, DWA-ENV-*, DWA-END-*, DWA-LIM-*, DWA-FAIL-*, DWA-ANN-*, DWA-AUD-*, DWA-AUTH-001..005,
// DWA-AUTH-007, DWA-ST-002..007, DWA-GRA-001, 002, 005, 007, 010, DWA-MSG-003, 005, DWA-SLK-004..006, DWA-GEN-003, 004
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import { DeployWindowApp } from '../src/commands.js';
import { validateConfig } from '../src/config.js';
import { GrafanaError } from '../src/grafana.js';
import { parseMarker } from '../src/marker.js';
import { RateLimit } from '../src/memory.js';
import { audits, CH_A, CH_B, CH_C, cmd, FIXTURE_YAML, makeHarness, STRANGER, T0, USER, USER2 } from './helpers.js';

const markerOf = (comment: string) => {
  const p = parseMarker(comment, 'dwa');
  assert.equal(p.kind, 'own');
  return p.kind === 'own' ? p.marker : undefined;
};

function yamlWith(mutate: (d: Record<string, any>) => void) {
  const d = load(FIXTURE_YAML) as Record<string, any>;
  mutate(d);
  return validateConfig(d);
}

void describe('start', () => {
  void it('announces first, then creates one silence per entry with the marker (T-GRA-1, T-ST-4)', async () => {
    const h = makeHarness();
    await h.run('start 30m PROD -- release 2.4');
    assert.deepEqual(h.slack.order.slice(0, 1), ['post']);
    assert.equal(h.grafana.creates.length, 3); // api has two PROD entries, web one
    const first = h.grafana.creates[0];
    assert.ok(first);
    assert.equal(first.startsAt.getTime(), T0 - 60_000); // DWA-GRA-001
    assert.equal(first.endsAt.getTime(), T0 + 30 * 60_000);
    assert.deepEqual(first.matchers, [{ name: 'target_id', value: 'example-prod-api', isRegex: false }]);
    const m = markerOf(first.comment);
    const post = h.slack.posts[0];
    assert.ok(post);
    assert.equal(m?.ts, post.ts);
    assert.equal(m?.channelId, CH_A);
    assert.equal(m?.env, 'PROD');
    assert.equal(m?.target, 'api');
    assert.equal(m?.entries, 2);
    assert.equal(m?.userId, USER);
    assert.equal(m?.message, 'release 2.4');
    assert.match(h.slack.lastUpdate(), /\*active\*/);
    assert.equal(h.grafana.active().length, 3);
  });

  void it('the starting text tells the reader what to do (T-ST-7)', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    assert.match(h.slack.posts[0]?.text ?? '', /does not change within 1 minute, run `\/deploy list`/);
  });

  void it('createdBy carries the Slack user, and the marker does too (T-GRA-2, T-AUD-3)', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    const c = h.grafana.creates[0];
    assert.equal(c?.createdBy, `slack:${USER} (example)`);
    // Grafana may overwrite createdBy; the marker still names the user.
    for (const s of h.grafana.silences) s.createdBy = 'service-account';
    await h.run('list');
    assert.match(h.slack.lastEphemeral(), new RegExp(`<@${USER}>`));
  });

  void it('subset selection and the env choose the mute definitions (T-CHN-3, T-ENV-2)', async () => {
    const h = makeHarness();
    await h.run('start 30m integ web');
    assert.deepEqual(h.grafana.creates.map((c) => c.matchers[0]?.value), ['example-integ-web']);
  });

  void it('select: explicit with no target replies with the list and does nothing (T-CHN-3)', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.channels[CH_A].select = 'explicit'; }) });
    await h.run('start 30m');
    assert.match(h.slack.lastEphemeral(), /Name at least one target: api, web/);
    assert.equal(h.grafana.creates.length, 0);
    assert.equal(h.slack.posts.length, 0);
    await h.run('end');
    assert.match(h.slack.lastEphemeral(), /Name at least one target/);
  });

  void it('a message that looks like a matcher only reaches the comment (T-CFG-7, T-MSG-3)', async () => {
    const h = makeHarness();
    await h.run('start 30m api -- target_id=x .* {$MACRO} ${x}');
    const c = h.grafana.creates[0];
    assert.deepEqual(c?.matchers, [{ name: 'target_id', value: 'example-integ-api', isRegex: false }]);
    assert.ok(c?.comment.endsWith(' | target_id=x .* (MACRO) (x)'));
  });

  void it('escapes mentions in the announcement, with verbatim blocks (T-MSG-2)', async () => {
    const h = makeHarness();
    await h.run('start 30m -- <!channel> hi');
    const p = h.slack.posts[0];
    assert.match(p?.text ?? '', /&lt;!channel&gt; hi/);
    assert.doesNotMatch(p?.text ?? '', /<!channel>/);
    assert.equal(p?.blocks[0]?.text.verbatim, true);
    await h.run('list');
    assert.match(h.slack.lastEphemeral(), /&lt;!channel&gt;/);
    await h.run('end -- <@U0OTHER> done');
    const reply = h.slack.posts.at(-1);
    assert.equal(reply?.threadTs, p?.ts);
    assert.match(reply?.text ?? '', /&lt;@U0OTHER&gt; done/);
  });

  void it('announcement post fails: no Grafana change (T-FAIL-6); bot not in channel (T-SLK-7)', async () => {
    const h = makeHarness();
    h.slack.failPost = () => 'not_in_channel';
    await h.run('start 30m');
    assert.equal(h.grafana.creates.length, 0);
    assert.match(h.slack.lastEphemeral(), /not a member of this channel/);
    assert.equal(audits(h.lines, 'start_failed').length, 1);
  });

  void it('announcement update fails: the result goes out as a new message (T-FAIL-4)', async () => {
    const h = makeHarness();
    h.slack.failUpdate = true;
    await h.run('start 30m');
    assert.equal(h.slack.posts.length, 2);
    assert.match(h.slack.posts[1]?.text ?? '', /\*active\*/);
  });

  void it('times are Slack date tokens with a UTC fallback (T-ANN-1, T-GRA-9)', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    assert.match(h.slack.lastUpdate(), /<!date\^1768471200\^\{date_short_pretty\} \{time\}\|2026-01-15 10:00 UTC>/);
    assert.ok(h.grafana.creates[0]?.endsAt.toISOString().endsWith('Z'));
  });
});

void describe('limits', () => {
  void it('conflict on one of three targets blocks all and changes nothing (T-LIM-3)', async () => {
    const h = makeHarness();
    await h.run('start 30m PROD web');
    const creates = h.grafana.creates.length;
    await h.run('start 30m PROD api,web', CH_A, USER2);
    assert.equal(h.grafana.creates.length, creates);
    assert.match(h.slack.lastEphemeral(), /already active.*Nothing was changed/s);
    // a different env does not conflict (DWA-ENV-003)
    await h.run('start 30m INTEG web', CH_A, USER2);
    assert.equal(h.grafana.creates.length, creates + 1);
  });

  void it('conflict detection is by name: two names with identical matchers do not conflict (T-ENV-3)', async () => {
    const h = makeHarness({
      config: yamlWith((d) => {
        d.channels[CH_A].targets.web.PROD = d.channels[CH_A].targets.api.PROD;
      }),
    });
    await h.run('start 30m PROD api');
    await h.run('start 30m PROD web');
    assert.equal(h.grafana.active().length, 4);
  });

  void it('rate limit: 10 starts per user per hour (T-LIM-4)', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.limits.max_concurrent_windows = 50; }) });
    for (let i = 0; i < 10; i++) {
      await h.run('start 30m INTEG api');
      await h.run('end');
    }
    await h.run('start 30m INTEG api');
    assert.match(h.slack.lastEphemeral(), /Too many starts/);
    h.clock.t += 3_600_000;
    await h.run('start 30m INTEG api');
    assert.match(h.slack.lastUpdate(), /\*active\*/);
  });

  void it('max_silences_per_window (T-LIM-6) and max_concurrent_windows (T-LIM-7)', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.limits.max_silences_per_window = 2; d.limits.max_concurrent_windows = 1; }) });
    await h.run('start 30m PROD');
    assert.match(h.slack.lastEphemeral(), /would need 3 silences; the limit is 2/);
    await h.run('start 30m INTEG');
    await h.run('start 30m', CH_B);
    assert.match(h.slack.lastEphemeral(), /1 windows are active; the limit is 1/);
  });

  void it('no path ends a window early or extends it (T-LIM-2)', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    const ends = h.grafana.silences.map((s) => s.endsAt);
    h.timers.advance(29 * 60_000);
    await h.run('list');
    assert.deepEqual(h.grafana.silences.map((s) => s.endsAt), ends);
    assert.equal(h.grafana.calls.filter((c) => c.startsWith('expire')).length, 0);
  });

  void it('max_matched refuses a start whose matchers match too many alerts (T-CFG-10 runtime part)', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.limits.max_matched = 5; }) });
    h.grafana.alertCounts = (m) => (m[0]?.value === 'example-integ-web' ? 6 : 1);
    await h.run('start 30m');
    assert.match(h.slack.lastEphemeral(), /match 6 alerts; the limit is 5/);
    assert.equal(h.grafana.creates.length, 0);
  });

  void it('a reminder is posted 5 minutes before the end, in the thread (T-LIM-8)', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    const ts = h.slack.posts[0]?.ts;
    h.timers.advance(24 * 60_000);
    await Promise.resolve();
    assert.equal(h.slack.posts.length, 1);
    h.timers.advance(60_000);
    await new Promise((r) => setImmediate(r));
    const last = h.slack.posts.at(-1);
    assert.equal(last?.threadTs, ts);
    assert.match(last?.text ?? '', /ends <!date/);
  });

  void it('no reminder after the window was ended', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    await h.run('end');
    const posts = h.slack.posts.length;
    h.timers.advance(30 * 60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.slack.posts.length, posts);
  });
});

void describe('partial failure', () => {
  const reject = () => new GrafanaError('rejected', 'bad', 400);

  void it('keep: created silences stay, window is partial (T-FAIL-1)', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.channels[CH_A].on_partial = 'keep'; }) });
    h.grafana.onCreate = (_s, n) => (n === 2 ? reject() : 'ok');
    await h.run('start 30m INTEG');
    assert.match(h.slack.lastUpdate(), /\*partial\*/);
    assert.match(h.slack.lastUpdate(), /web: failed \(rejected\)/);
    assert.equal(h.grafana.active().length, 1);
  });

  void it('rollback (default): created silences are expired, window failed (T-FAIL-2)', async () => {
    const h = makeHarness();
    h.grafana.onCreate = (_s, n) => (n === 2 ? reject() : 'ok');
    await h.run('start 30m INTEG');
    assert.match(h.slack.lastUpdate(), /\*failed\*/);
    assert.equal(h.grafana.active().length, 0);
    assert.match(h.slack.lastEphemeral(), /was not opened: failed/);
  });

  void it('rollback also expires a silence whose create timed out after Grafana accepted it (T-FAIL-7)', async () => {
    const h = makeHarness();
    // first create: accepted but the answer is lost; its retry finds it. Second target: rejected.
    h.grafana.onCreate = (_s, n) => (n === 1 ? 'accept-then-timeout' : n === 2 ? reject() : 'ok');
    await h.run('start 30m INTEG');
    assert.equal(h.grafana.silences.length, 1);
    assert.equal(h.grafana.active().length, 0);
  });

  void it('a failing rollback step: "failed, silences still active" with ids', async () => {
    const h = makeHarness();
    h.grafana.onCreate = (_s, n) => (n === 2 ? reject() : 'ok');
    h.grafana.onExpire = () => new GrafanaError('rejected', 'no', 400);
    await h.run('start 30m INTEG');
    assert.match(h.slack.lastUpdate(), /failed, silences still active/);
    assert.match(h.slack.lastUpdate(), /still active, could not end it.*`sil0001`/);
  });

  void it('every silence fails: failed under keep too', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.channels[CH_A].on_partial = 'keep'; }) });
    h.grafana.onCreate = () => reject();
    await h.run('start 30m INTEG');
    assert.match(h.slack.lastUpdate(), /\*failed\*/);
  });

  void it('a limit rejection is failure class limit and is not retried (T-GRA-8)', async () => {
    const h = makeHarness();
    h.grafana.onCreate = () => new GrafanaError('limit', 'limit', 400);
    await h.run('start 30m INTEG api');
    assert.equal(h.grafana.creates.length, 1);
    assert.match(h.slack.lastUpdate(), /failed \(limit\)/);
  });

  void it('a create timeout without acceptance is retried after a find (T-GRA-6, T-GRA-7)', async () => {
    const h = makeHarness();
    h.grafana.onCreate = (_s, n) => (n === 1 ? new GrafanaError('timeout', 't') : 'ok');
    await h.run('start 30m INTEG api');
    assert.equal(h.grafana.creates.length, 2);
    assert.equal(h.grafana.active().length, 1);
    const i = h.grafana.calls.indexOf('create');
    assert.equal(h.grafana.calls[i + 1], 'list'); // find before the retry
  });

  void it('accepted-then-timeout creates no second silence (T-GRA-7)', async () => {
    const h = makeHarness();
    h.grafana.onCreate = (_s, n) => (n === 1 ? 'accept-then-timeout' : 'ok');
    await h.run('start 30m INTEG api');
    assert.equal(h.grafana.creates.length, 1);
    assert.equal(h.grafana.active().length, 1);
    assert.match(h.slack.lastUpdate(), /\*active\*/);
  });
});

void describe('two instances (T-LIM-5, T-DEP-6)', () => {
  void it('the lower window id stays; the other expires every silence with its id', async () => {
    const h = makeHarness();
    // Another instance created window "aaaaaaaa" for the same pair between our find and our re-check.
    let injected = false;
    h.grafana.onCreate = () => {
      if (!injected) {
        injected = true;
        h.grafana.silences.push({
          id: 'other1',
          state: 'active',
          comment: `dwa:v1 w=aaaaaaaa ch=${CH_A} env=INTEG t=api n=1 u=${USER2} ts=1768471200.999999`,
          createdBy: 'x',
          startsAt: new Date(T0).toISOString(),
          endsAt: new Date(T0 + 1_800_000).toISOString(),
          matchers: [{ name: 'target_id', value: 'example-integ-api', isRegex: false }],
        });
      }
      return 'ok';
    };
    h.idQueue.push('zzzzzzzz');
    await h.run('start 30m INTEG api');
    assert.match(h.slack.lastUpdate(), /`aaaaaaaa`.*wins/);
    const live = h.grafana.active().map((s) => s.id);
    assert.deepEqual(live, ['other1']);
  });
});

void describe('end', () => {
  void it('ends the one active window and replies in its thread (T-END-1, T-ANN-2)', async () => {
    const h = makeHarness();
    await h.run('start 30m PROD');
    const ts = h.slack.posts[0]?.ts;
    await h.run('end -- deploy done', CH_A, USER2); // another allowed user (T-AUTH-5)
    assert.equal(h.grafana.active().length, 0);
    const reply = h.slack.posts.at(-1);
    assert.equal(reply?.threadTs, ts);
    assert.match(reply?.text ?? '', /ended by <@U0EXAMPLE02>/);
    assert.match(reply?.text ?? '', /deploy done/);
    assert.match(h.slack.lastUpdate(), /\*ended\*/);
    assert.equal(audits(h.lines, 'end')[0]?.user, USER2);
  });

  void it('no active window (T-END-2)', async () => {
    const h = makeHarness();
    await h.run('end');
    assert.match(h.slack.lastEphemeral(), /No active window/);
  });

  void it('INTEG and PROD active: bare end ends nothing and lists both (T-END-3)', async () => {
    const h = makeHarness();
    await h.run('start 30m INTEG');
    await h.run('start 30m PROD');
    await h.run('end');
    assert.match(h.slack.lastEphemeral(), /Several windows match; nothing was ended/);
    assert.equal(h.grafana.active().length, 5);
    await h.run('end PROD');
    assert.equal(h.grafana.active().length, 2);
  });

  void it('end on a subset leaves the rest: partly ended; list is not incomplete (T-END-4, T-ST-3)', async () => {
    const h = makeHarness();
    await h.run('start 30m PROD');
    await h.run('end api');
    assert.deepEqual(h.grafana.active().map((s) => s.matchers[0]?.value), ['example-prod-web']);
    assert.match(h.slack.lastUpdate(), /\*partly ended\*/);
    await h.run('list');
    assert.match(h.slack.lastEphemeral(), /PROD: web;/);
    assert.doesNotMatch(h.slack.lastEphemeral(), /incomplete/);
  });

  void it('a target with fewer live silences than n shows as incomplete (T-ST-3)', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.channels[CH_A].on_partial = 'keep'; }) });
    h.grafana.onCreate = (_s, n) => (n === 2 ? new GrafanaError('rejected', 'x', 400) : 'ok');
    await h.run('start 30m PROD');
    await h.run('list');
    assert.match(h.slack.lastEphemeral(), /api \(incomplete: 1 of 2\)/);
  });

  void it('end tries every silence and reports the ones that remain (T-FAIL-3)', async () => {
    const h = makeHarness();
    await h.run('start 30m PROD');
    h.grafana.onExpire = (id) => (id === 'sil0001' ? new GrafanaError('rejected', 'x', 400) : undefined);
    await h.run('end');
    assert.equal(h.grafana.active().length, 1);
    assert.match(h.slack.posts.at(-1)?.text ?? '', /could not end `sil0001`/);
    assert.match(h.slack.lastUpdate(), /partly ended/);
  });

  void it('end works on C without env_required (G36)', async () => {
    const h = makeHarness();
    await h.run('start 30m PROD', CH_C);
    await h.run('end', CH_C);
    assert.equal(h.grafana.active().length, 0);
  });

  void it('bot not in channel: end still expires and tells the user (T-SLK-7)', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    h.slack.failPost = () => 'not_in_channel';
    await h.run('end');
    assert.equal(h.grafana.active().length, 0);
    assert.match(h.slack.lastEphemeral(), /ended by/);
  });
});

void describe('channels and state', () => {
  void it('a window of channel X is invisible in channel Y (T-CHN-2)', async () => {
    const h = makeHarness();
    await h.run('start 30m', CH_B);
    await h.run('list', CH_A);
    assert.match(h.slack.lastEphemeral(), /No active window in this channel/);
    await h.run('end', CH_A);
    assert.match(h.slack.lastEphemeral(), /No active window/);
    assert.equal(h.grafana.active().length, 1);
  });

  void it('a restart loses no window; the end time comes from endsAt (T-ST-2, T-GEN-3)', async () => {
    const h = makeHarness();
    await h.run('start 30m');
    for (const s of h.grafana.silences) s.endsAt = new Date(T0 + 20 * 60_000).toISOString();
    const h2 = makeHarness();
    h2.grafana.silences = h.grafana.silences;
    await h2.run('list');
    assert.match(h2.slack.lastEphemeral(), /until <!date\^1768472400\^/);
    await h2.app.logActiveAtStart();
    assert.equal(audits(h2.lines, 'active_at_start').length, 2);
  });

  void it('foreign silences are never returned or expired (T-GRA-4, T-CFG-9)', async () => {
    const h = makeHarness();
    h.grafana.addForeign('maintenance by hand');
    h.grafana.addForeign(`other:v1 w=aaaaaaaa ch=${CH_A} env=INTEG t=api n=1 u=${USER} ts=1.1`);
    h.grafana.addForeign(`dwa:v1 w=aaaaaaaa ch=${CH_A} env=INTEG t=api n=1 u=${USER} ts=1.1 | x`.replace('w=aaaaaaaa', 'w=AAAA'));
    await h.run('start 30m INTEG api');
    await h.run('end');
    const live = h.grafana.active().map((s) => s.id);
    assert.equal(live.length, 3);
    assert.ok(live.every((id) => id.startsWith('foreign')));
    await h.run('start 30m INTEG api');
    await h.run('list');
    assert.match(h.slack.lastEphemeral(), /1 silence\(s\) with a foreign marker/);
  });

  void it('signed markers: a forged or unsigned marker is foreign (DWA-ST-006)', async () => {
    const h = makeHarness({ markerKey: Buffer.from('secret-key') });
    h.grafana.addForeign(`dwa:v1 w=aaaaaaaa ch=${CH_A} env=INTEG t=api n=1 u=${USER} ts=1.1`);
    await h.run('start 30m INTEG api');
    await h.run('list');
    assert.match(h.slack.lastEphemeral(), /foreign marker/);
    assert.equal(parseMarker(h.grafana.creates[0]?.comment ?? '', 'dwa', Buffer.from('secret-key')).kind, 'own');
  });

  void it('start and end of one channel serialize; other channels run in parallel (T-GEN-4)', async () => {
    const h = makeHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const orig = h.grafana.listSilences.bind(h.grafana);
    h.grafana.listSilences = async () => {
      if (first) {
        first = false;
        await gate;
      }
      return orig();
    };
    const a1 = h.run('start 30m INTEG api');
    const a2 = h.run('start 30m INTEG api', CH_A, USER2);
    await h.run('list', CH_B); // not blocked by the slow call in channel A
    assert.match(h.slack.lastEphemeral(), /No active window/);
    release();
    await Promise.all([a1, a2]);
    assert.equal(h.grafana.active().length, 1);
    assert.match(h.slack.lastEphemeral(), /already active/);
  });
});

void describe('authorization and refusals', () => {
  void it('unknown channel: refusal, no Grafana call, no post, audit without text (T-CHN-1, T-AUD-2)', async () => {
    const h = makeHarness();
    await h.run('start 30m -- secret plan', 'C0UNMAPPED1');
    assert.match(h.slack.lastEphemeral(), /not set up for deploy windows/);
    assert.equal(h.grafana.calls.length, 0);
    assert.equal(h.slack.posts.length, 0);
    const a = audits(h.lines, 'refused_unmapped_channel')[0];
    assert.equal(a?.channel, 'C0UNMAPPED1');
    assert.equal(JSON.stringify(a).includes('secret plan'), false);
  });

  void it('DMs and group DMs are refused; a channel id in the text changes nothing (T-AUTH-7)', async () => {
    const h = makeHarness();
    await h.run('start 30m', 'D0EXAMPLE01');
    assert.match(h.slack.lastEphemeral(), /not set up/);
    await h.run(`start 30m ${CH_B}`, CH_A);
    assert.match(h.slack.lastEphemeral(), /unknown_env_or_target/);
    assert.equal(h.grafana.creates.length, 0);
  });

  void it('help is open; list, start and end need an allowed user (T-AUTH-3, T-AUTH-4)', async () => {
    const h = makeHarness();
    await h.run('help', CH_A, STRANGER);
    assert.match(h.slack.lastEphemeral(), /opens a deploy window/);
    for (const text of ['list', 'start 30m', 'end']) {
      await h.run(text, CH_A, STRANGER);
      assert.equal(h.slack.lastEphemeral(), 'You are not allowed to run this command in this channel.');
    }
    assert.equal(audits(h.lines, 'denied').length, 3);
    assert.equal(h.grafana.calls.length, 0);
  });

  void it('groups allow; a failed lookup denies, the channel allow_users still allows (T-AUTH-1, T-AUTH-2)', async () => {
    const config = yamlWith((d) => {
      d.channels[CH_A].auth = { allow_users: [USER2], allow_usergroups: ['S0EXAMPLE01', 'S0MISSING01'] };
    });
    const h = makeHarness({ config, groups: { S0EXAMPLE01: [STRANGER] } });
    await h.run('list', CH_A, STRANGER);
    assert.match(h.slack.lastEphemeral(), /No active window/);
    await h.run('list', CH_A, 'U0NOBODY001');
    assert.equal(audits(h.lines, 'denied')[0]?.reason, 'group_lookup_failed');
    await h.run('list', CH_A, USER2);
    assert.match(h.slack.lastEphemeral(), /No active window/);
    // the global allow_users does not rescue a user when the channel has its own block
    await h.run('list', CH_A, USER);
    assert.match(h.slack.lastEphemeral(), /not allowed/);
  });

  void it('grammar errors and help are audited (T-AUD-2); a grammar error posts nothing and calls no Grafana (T-CMD-5)', async () => {
    const h = makeHarness();
    await h.run('start 90');
    await h.run('stop');
    await h.run('');
    assert.equal(audits(h.lines, 'grammar_error').length, 2);
    assert.equal(audits(h.lines, 'help').length, 1);
    assert.match(h.slack.ephemerals[1]?.text ?? '', /unknown_subcommand.*\n.*opens a deploy window/s);
    assert.equal(h.grafana.calls.length, 0);
    assert.equal(h.slack.posts.length, 0);
  });

  void it('ephemeral replies fall back to response_url (DWA-CMD-008)', async () => {
    const h = makeHarness();
    h.slack.failEphemeral = true;
    await h.run('help');
    assert.equal(h.slack.responds.length, 1);
  });
});

void describe('audit and progress', () => {
  void it('one JSON line per start and end with all fields; tokens redacted (T-AUD-1)', async () => {
    const h = makeHarness();
    await h.run(`start 30m PROD api -- token ${'xox' + 'b-1234-abcd'} here`);
    await h.run('end');
    const s = audits(h.lines, 'start')[0];
    assert.ok(s);
    for (const k of ['time', 'level', 'event', 'window', 'channel', 'env', 'targets', 'user', 'duration', 'message', 'silences']) {
      assert.ok(k in s, `missing ${k}`);
    }
    assert.equal(s.message, 'token REDACTED here');
    assert.ok(audits(h.lines, 'end')[0]);
  });

  void it('a command that takes over 30 s gets "still working"; a failing one a failure notice (T-SLK-6)', async () => {
    const h = makeHarness();
    let release: () => void = () => undefined;
    h.grafana.listSilences = () => new Promise((_res, rej) => { release = () => { rej(new Error('boom')); }; });
    const p = h.run('list');
    await new Promise((r) => setImmediate(r));
    h.timers.advance(30_000);
    await new Promise((r) => setImmediate(r));
    assert.match(h.slack.lastEphemeral(), /Still working/);
    release();
    await p;
    assert.match(h.slack.lastEphemeral(), /Grafana is not reachable/);
  });

  void it('Grafana down: commands fail with a clear message (T-FAIL-5)', async () => {
    const h = makeHarness();
    h.grafana.listError = new GrafanaError('timeout', 'down');
    await h.run('start 30m');
    assert.match(h.slack.lastEphemeral(), /Grafana is not reachable \(timeout\)\. Nothing was changed\./);
    assert.equal(h.slack.posts.length, 0);
  });
});

void describe('create retry without proof (review finding)', () => {
  void it('a create timeout followed by a failing find does not create again', async () => {
    const h = makeHarness({ config: yamlWith((d) => { d.channels[CH_A].on_partial = 'keep'; }) });
    h.grafana.onCreate = () => 'accept-then-timeout';
    const list = h.grafana.listSilences.bind(h.grafana);
    let calls = 0;
    h.grafana.listSilences = () => {
      calls++;
      // the conflict find works; the find after the failed create does not
      return calls === 1 ? list() : Promise.reject(new GrafanaError('timeout', 'flapping'));
    };
    await h.run('start 30m INTEG api');
    assert.equal(h.grafana.creates.length, 1);
    assert.equal(h.grafana.silences.length, 1);
  });

  void it('drain waits for a running command', async () => {
    const h = makeHarness();
    let release: () => void = () => undefined;
    h.grafana.listSilences = () => new Promise((r) => { release = () => { r([]); }; });
    let done = false;
    void h.run('list').then(() => { done = true; });
    const drained = h.app.drain(1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(done, false);
    release();
    await drained;
    assert.equal(done, true);
  });
});

void describe('end with named targets (council finding 2)', () => {
  void it('a named target that is not in the window is named in the reply', async () => {
    const h = makeHarness();
    await h.run('start 30m PROD api');
    await h.run('end PROD api web');
    assert.equal(h.grafana.active().length, 0);
    assert.match(h.slack.posts.at(-1)?.text ?? '', /Not part of this window, so not ended: web\./);
  });
  void it('the rate limit message follows the configured limit (council finding 4)', async () => {
    const h = makeHarness();
    const app = new DeployWindowApp({ ...h.deps, rateLimit: new RateLimit(1, 1_800_000, () => h.clock.t) });
    await app.handle(cmd('start 30m INTEG api'));
    await app.handle(cmd('end'));
    await app.handle(cmd('start 30m INTEG api'));
    assert.match(h.slack.lastEphemeral(), /at most 1 per 30m per user/);
  });
  void it('a refused start counts before Grafana is called (council finding 5)', async () => {
    const h = makeHarness();
    const lists = () => h.grafana.calls.filter((c) => c === 'list').length;
    for (let i = 0; i < 10; i++) await h.run('start 30m PROD api', CH_A, USER2); // 1 start, then 9 conflicts
    const before = lists();
    await h.run('start 30m PROD api', CH_A, USER2);
    assert.match(h.slack.lastEphemeral(), /Too many starts/);
    assert.equal(lists(), before);
  });
});
