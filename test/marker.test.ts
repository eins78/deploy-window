// covers: DWA-ST-001, DWA-ST-006, DWA-CFG-010 (T-ST-1, T-ST-6)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMarker, newWindowId, parseMarker } from '../src/marker.js';

const fields = {
  instance: 'dwa',
  windowId: 'abcd2345',
  channelId: 'C0EXAMPLE01',
  env: 'PROD',
  target: 'api',
  entries: 2,
  userId: 'U0EXAMPLE01',
  ts: '1768471200.000001',
};

void describe('window id (T-ST-1)', () => {
  void it('8 characters from [a-z2-7]', () => {
    for (let i = 0; i < 500; i++) assert.match(newWindowId(), /^[a-z2-7]{8}$/);
  });
  void it('uses the given random source', () => {
    assert.equal(newWindowId(() => Buffer.from([0, 1, 25, 26, 31, 32, 255, 7])), 'abz27a7h');
  });
});

void describe('marker (T-ST-6)', () => {
  void it('round trip, message after the first separator is not parsed', () => {
    const c = formatMarker(fields, 'x | w=zzzzzzzz ch=C0OTHER0001');
    const p = parseMarker(c, 'dwa');
    assert.equal(p.kind, 'own');
    if (p.kind === 'own') {
      assert.equal(p.marker.windowId, 'abcd2345');
      assert.equal(p.marker.channelId, 'C0EXAMPLE01');
      assert.equal(p.marker.message, 'x | w=zzzzzzzz ch=C0OTHER0001');
    }
  });
  void it('no message: no separator', () => {
    assert.equal(formatMarker(fields, ''), 'dwa:v1 w=abcd2345 ch=C0EXAMPLE01 env=PROD t=api n=2 u=U0EXAMPLE01 ts=1768471200.000001');
  });
  void it('another instance prefix is not ours; a wrong format is foreign', () => {
    assert.equal(parseMarker(formatMarker({ ...fields, instance: 'other' }, ''), 'dwa').kind, 'other');
    assert.equal(parseMarker('dwa:v1 w=ABC ch=C0EXAMPLE01 | x', 'dwa').kind, 'foreign');
    assert.equal(parseMarker('dwa:v1 w=abcd2345 ch=C0EXAMPLE01 env=PROD t=api n=2 u=U0EXAMPLE01 ts=1.1 extra=1', 'dwa').kind, 'foreign');
  });
  void it('signature: valid, missing, forged', () => {
    const key = Buffer.from('k1');
    const signed = formatMarker(fields, 'm', key);
    assert.match(signed, / sig=[0-9a-f]{64} \| m$/);
    assert.equal(parseMarker(signed, 'dwa', key).kind, 'own');
    assert.equal(parseMarker(formatMarker(fields, 'm'), 'dwa', key).kind, 'foreign');
    assert.equal(parseMarker(signed.replace('env=PROD', 'env=INTEG'), 'dwa', key).kind, 'foreign');
    assert.equal(parseMarker(signed, 'dwa', Buffer.from('k2')).kind, 'foreign');
  });
});
