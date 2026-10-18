// covers: DWA-OPS-007 (T-OPS-6)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HealthFile } from '../src/health.js';

function setup() {
  const timers = new Map<number, () => void>();
  let next = 0;
  let touches = 0;
  const hf = new HealthFile({
    touch: () => { touches += 1; },
    setInterval: (fn) => { next += 1; timers.set(next, fn); return next; },
    clearInterval: (h) => { timers.delete(h as number); },
  });
  const tick = () => { for (const fn of timers.values()) fn(); };
  return { hf, tick, touches: () => touches, active: () => timers.size };
}

void describe('health file (T-OPS-6)', () => {
  void it('is touched at once and on every tick while a connection is open', () => {
    const s = setup();
    s.hf.onConnectedChange(1);
    assert.equal(s.touches(), 1);
    s.tick();
    s.tick();
    assert.equal(s.touches(), 3);
  });
  void it('a second connection does not start a second timer', () => {
    const s = setup();
    s.hf.onConnectedChange(1);
    s.hf.onConnectedChange(2);
    assert.equal(s.active(), 1);
    assert.equal(s.touches(), 1);
  });
  void it('stops when no connection is open, and starts again on reconnect', () => {
    const s = setup();
    s.hf.onConnectedChange(1);
    s.hf.onConnectedChange(0);
    assert.equal(s.active(), 0);
    s.tick();
    assert.equal(s.touches(), 1);
    s.hf.onConnectedChange(1);
    assert.equal(s.active(), 1);
    assert.equal(s.touches(), 2);
  });
  void it('stop() ends the timer for shutdown', () => {
    const s = setup();
    s.hf.onConnectedChange(2);
    s.hf.stop();
    assert.equal(s.active(), 0);
  });
});
