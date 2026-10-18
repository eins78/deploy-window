// covers: DWA-CMD-011, DWA-SLK-001..003 (T-SLK-1), DWA-GEN-006 (T-GEN-6 dedupe part)
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { SlashCommand } from '../src/commands.js';
import { createLogger } from '../src/log.js';
import { Dedupe } from '../src/memory.js';
import { type SocketLike, wireSockets } from '../src/socket.js';

class FakeSocket extends EventEmitter implements SocketLike {
  start() { return Promise.resolve(); }
  disconnect() { return Promise.resolve(); }
}

const body = (trigger: string) => ({
  command: '/deploy',
  channel_id: 'C0EXAMPLE01',
  user_id: 'U0EXAMPLE01',
  text: 'list',
  response_url: 'https://hooks.slack.com/x',
  trigger_id: trigger,
});

function setup(slowHandle = false) {
  const order: string[] = [];
  const handled: SlashCommand[] = [];
  const sockets = [new FakeSocket(), new FakeSocket()];
  const counts: number[] = [];
  const clock = { t: 0 };
  wireSockets({
    sockets,
    app: {
      handle: async (c) => {
        order.push('handle');
        handled.push(c);
        if (slowHandle) await new Promise((r) => setTimeout(r, 20));
      },
    },
    dedupe: new Dedupe(600_000, () => clock.t),
    log: createLogger({ write: () => undefined }),
    command: () => '/deploy',
    onConnectedChange: (n) => counts.push(n),
  });
  const deliver = async (s: FakeSocket, envelope: string, trigger: string) => {
    s.emit('slash_commands', { ack: () => { order.push('ack'); return Promise.resolve(); }, envelope_id: envelope, body: body(trigger) });
    await new Promise((r) => setImmediate(r));
  };
  return { order, handled, sockets, counts, deliver, clock };
}

void describe('socket wiring (T-SLK-1)', () => {
  void it('acks before any work; a slow handler does not delay the ack', async () => {
    const s = setup(true);
    await s.deliver(s.sockets[0]!, 'e1', 't1');
    assert.deepEqual(s.order.slice(0, 2), ['ack', 'handle']);
  });
  void it('the same envelope_id or trigger_id runs once, on any connection, for 10 minutes', async () => {
    const s = setup();
    await s.deliver(s.sockets[0]!, 'e1', 't1');
    await s.deliver(s.sockets[1]!, 'e1', 't2'); // same envelope
    await s.deliver(s.sockets[1]!, 'e3', 't1'); // same trigger
    assert.equal(s.handled.length, 1);
    assert.equal(s.order.filter((x) => x === 'ack').length, 3); // every delivery is acked
    s.clock.t += 600_001;
    await s.deliver(s.sockets[0]!, 'e1', 't1');
    assert.equal(s.handled.length, 2);
  });
  void it('channel and user come from the envelope', async () => {
    const s = setup();
    await s.deliver(s.sockets[0]!, 'e1', 't1');
    assert.equal(s.handled[0]?.channelId, 'C0EXAMPLE01');
    assert.equal(s.handled[0]?.userId, 'U0EXAMPLE01');
  });
  void it('two connections: while one reconnects the other stays up (T-SLK-5)', () => {
    const s = setup();
    s.sockets[0]!.emit('connected');
    s.sockets[1]!.emit('connected');
    s.sockets[0]!.emit('reconnecting');
    s.sockets[0]!.emit('connected');
    assert.deepEqual(s.counts, [1, 2, 1, 2]);
  });
});
