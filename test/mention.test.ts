// covers: DWA-MEN-001..007 (T-MEN-1..5), DWA-AUTH-001, DWA-SLK-001
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { SlashCommand } from '../src/commands.js';
import { createLogger } from '../src/log.js';
import { Dedupe } from '../src/memory.js';
import { type MentionEvent, mentionToCommand } from '../src/mention.js';
import { type SocketLike, wireSockets } from '../src/socket.js';
import { audits, CH_A, CH_B, makeHarness, STRANGER, USER } from './helpers.js';

const BOT = 'U0EXAMPLEBOT';
const CMD = '/deploy';
const ev = (text: string, over: Partial<MentionEvent> = {}): MentionEvent => ({
  user: USER,
  channel: CH_A,
  text,
  ts: '1768471000.000100',
  ...over,
});
const parse = (text: string, over: Partial<MentionEvent> = {}) => mentionToCommand(ev(text, over), BOT, CMD, 'env1');

void describe('mention parsing (T-MEN-1)', () => {
  void it('a leading mention of the bot is a command; the text is the command line', () => {
    assert.equal(parse(`<@${BOT}> start 30m PROD -- release`)?.text, 'start 30m PROD -- release');
    assert.equal(parse(`  <@${BOT}>   list`)?.text, 'list');
  });
  void it('the label form <@U…|name> is accepted', () => {
    assert.equal(parse(`<@${BOT}|Deploy Window> list`)?.text, 'list');
  });
  void it('only the first line is the command: a line a client appends is ignored', () => {
    assert.equal(parse(`<@${BOT}> start 5m INTEG -- why\n\n*Sent using* Example Client`)?.text, 'start 5m INTEG -- why');
  });
  void it('an optional leading slash command name is ignored', () => {
    assert.equal(parse(`<@${BOT}> /deploy list`)?.text, 'list');
    assert.equal(parse(`<@${BOT}> /deploy`)?.text, '');
    assert.equal(parse(`<@${BOT}> /deployment list`)?.text, '/deployment list');
  });
  void it('a mention that is not leading, or of another user, is chat', () => {
    assert.equal(parse(`please ask <@${BOT}> to start 5m`), undefined);
    assert.equal(parse('<@U0OTHER00001> start 5m'), undefined);
  });
  void it('carries channel, user and the thread of the mention; user comes from the event only', () => {
    const c = parse(`<@${BOT}> list -- <@U0FAKE000001>`, { thread_ts: '1768470000.000001' });
    assert.equal(c?.channelId, CH_A);
    assert.equal(c?.userId, USER);
    assert.deepEqual(c?.mention, { ts: '1768471000.000100', threadTs: '1768470000.000001' });
    assert.equal(parse(`<@${BOT}> list`)?.mention?.threadTs, '1768471000.000100');
  });
});

void describe('mention guard (T-MEN-2)', () => {
  void it('ignores: no user, the bot itself, any subtype', () => {
    assert.equal(parse(`<@${BOT}> list`, { user: undefined }), undefined);
    assert.equal(parse(`<@${BOT}> list`, { user: BOT }), undefined);
    assert.equal(parse(`<@${BOT}> list`, { subtype: 'message_changed' }), undefined);
    assert.equal(parse(`<@${BOT}> list`, { subtype: 'bot_message' }), undefined);
  });
  void it('bot_id is not a filter: a post made through an app with a user token carries it (DWA-MEN-003)', () => {
    assert.ok(parse(`<@${BOT}> list`, { bot_id: 'B0EXAMPLE001' }));
  });
});

void describe('mention handling (T-MEN-3)', () => {
  const mention = (text: string, over: Partial<MentionEvent> = {}): SlashCommand => {
    const c = parse(text, over);
    assert.ok(c);
    return c;
  };

  void it('an allowed user opens a window: same audit, announcement and silences as the slash command; audit says via mention', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG -- agent test`, { ts: '7.1' }));
    const start = audits(h.lines, 'start');
    assert.equal(start.length, 1);
    assert.equal(start[0]?.user, USER);
    assert.equal(start[0]?.via, 'mention');
    assert.equal(h.grafana.silences.length > 0, true);
    assert.ok(h.slack.posts[0]?.text.includes('Deploy window'));
    assert.equal(h.slack.posts[0]?.threadTs, undefined);
    assert.match(h.slack.lastUpdate(), /active/);
  });
  void it('a slash command audit line has no via', async () => {
    const h = makeHarness();
    await h.run('start 5m INTEG');
    assert.equal(audits(h.lines, 'start')[0]?.via, undefined);
  });
  void it('the final result of start is a thread reply with broadcast (DWA-MEN-005)', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG`, { ts: '7.1' }));
    const finals = h.slack.posts.filter((p) => p.threadTs === '7.1');
    assert.equal(finals.length, 1);
    assert.equal(finals[0]?.broadcast, true);
    assert.equal(h.slack.ephemerals.length, 0);
  });
  void it('end: the reply in the announcement thread broadcasts for a mention, not for a slash command', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG`, { ts: '7.1' }));
    await h.app.handle(mention(`<@${BOT}> end INTEG -- done`, { ts: '8.1' }));
    const ended = h.slack.posts.find((p) => p.text.includes('ended'));
    assert.equal(ended?.broadcast, true);

    const h2 = makeHarness();
    await h2.run('start 5m INTEG');
    await h2.run('end INTEG');
    assert.equal(h2.slack.posts.find((p) => p.text.includes('ended'))?.broadcast, false);
  });
  void it('errors, refusals and conflicts reply in the thread without broadcast (DWA-MEN-004)', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> start 99h INTEG`, { ts: '9.1' }));
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG`, { ts: '9.2' }));
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG`, { ts: '9.3' }));
    for (const t of ['9.1', '9.3']) {
      const r = h.slack.posts.filter((p) => p.threadTs === t && p.text !== '');
      assert.equal(r.length, 1, t);
      assert.equal(r[0]?.broadcast, false, t);
    }
    assert.equal(h.slack.ephemerals.length, 0);
  });
  void it('list stays private: ephemeral, never in the thread (DWA-MEN-004)', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> list`, { ts: '9.9' }));
    assert.equal(h.slack.ephemerals.length, 1);
    assert.equal(h.slack.posts.length, 0);
  });
  void it('a user who is not allowed is denied through the same allowlist, with a generic thread reply (DWA-MEN-002)', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG`, { user: STRANGER, ts: '6.1' }));
    assert.equal(audits(h.lines, 'denied').length, 1);
    assert.equal(audits(h.lines, 'start').length, 0);
    assert.equal(h.grafana.silences.length, 0);
    const r = h.slack.posts.filter((p) => p.threadTs === '6.1');
    assert.equal(r.length, 1);
    assert.equal(r[0]?.broadcast, false);
    assert.match(r[0]?.text ?? '', /not allowed/);
  });
  void it('a mention in a channel that is not mapped gets no reply (DWA-MEN-007)', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG`, { channel: 'C0UNMAPPED01' }));
    assert.equal(audits(h.lines, 'refused_unmapped_channel').length, 1);
    assert.equal(h.slack.posts.length, 0);
    assert.equal(h.slack.ephemerals.length, 0);
    // the slash command in the same channel still gets its ephemeral answer
    await h.run('list', 'C0UNMAPPED01');
    assert.equal(h.slack.ephemerals.length, 1);
  });
  void it('the other channel of the fixture is unaffected by a mention in this one', async () => {
    const h = makeHarness();
    await h.app.handle(mention(`<@${BOT}> start 5m INTEG`, { ts: '7.1' }));
    await h.run('list', CH_B);
    assert.equal(h.slack.ephemerals.length, 1);
  });
});

class FakeSocket extends EventEmitter implements SocketLike {
  start() { return Promise.resolve(); }
  disconnect() { return Promise.resolve(); }
}

void describe('mention wiring (T-MEN-4)', () => {
  function setup(enabled: boolean) {
    const order: string[] = [];
    const handled: SlashCommand[] = [];
    const sockets = [new FakeSocket(), new FakeSocket()];
    wireSockets({
      sockets,
      app: { handle: (c) => { order.push('handle'); handled.push(c); return Promise.resolve(); } },
      dedupe: new Dedupe(600_000, () => 0),
      log: createLogger({ write: () => undefined }),
      command: () => CMD,
      mentions: () => ({ enabled, botUserId: BOT }),
    });
    const deliver = async (s: FakeSocket, envelope: string, event: MentionEvent) => {
      s.emit('app_mention', { ack: () => { order.push('ack'); return Promise.resolve(); }, envelope_id: envelope, event });
      await new Promise((r) => setImmediate(r));
    };
    return { order, handled, sockets, deliver };
  }

  void it('acks first, then handles; the same envelope or message runs once on any connection', async () => {
    const s = setup(true);
    await s.deliver(s.sockets[0]!, 'e1', ev(`<@${BOT}> list`));
    assert.deepEqual(s.order.slice(0, 2), ['ack', 'handle']);
    await s.deliver(s.sockets[1]!, 'e1', ev(`<@${BOT}> list`));
    await s.deliver(s.sockets[1]!, 'e2', ev(`<@${BOT}> list`)); // same channel and ts
    assert.equal(s.handled.length, 1);
    assert.equal(s.order.filter((x) => x === 'ack').length, 3);
  });
  void it('with mentions off, the event is acked and ignored', async () => {
    const s = setup(false);
    await s.deliver(s.sockets[0]!, 'e1', ev(`<@${BOT}> start 5m INTEG`));
    assert.deepEqual(s.order, ['ack']);
  });
  void it('events that are not commands are acked and dropped', async () => {
    const s = setup(true);
    await s.deliver(s.sockets[0]!, 'e1', ev(`<@${BOT}> list`, { subtype: 'message_changed' }));
    await s.deliver(s.sockets[0]!, 'e2', ev('hello'));
    assert.equal(s.handled.length, 0);
    assert.equal(s.order.filter((x) => x === 'ack').length, 2);
  });
});
