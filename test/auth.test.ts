// covers: DWA-AUTH-001, 002 (T-AUTH-2 cache part)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Authorizer } from '../src/auth.js';

void describe('group cache (T-AUTH-2)', () => {
  void it('60 s for list, 10 s for start and end; a failed refresh never reuses an expired entry', async () => {
    const clock = { t: 0 };
    let calls = 0;
    let fail = false;
    const a = new Authorizer({
      usergroupMembers: () => {
        calls++;
        return fail ? Promise.reject(new Error('down')) : Promise.resolve(['U1']);
      },
    }, () => clock.t);
    const lists = { allowUsers: [], allowUsergroups: ['S1'] };
    assert.equal((await a.decide(lists, 'U1', 'list')).allowed, true);
    clock.t = 59_000;
    assert.equal((await a.decide(lists, 'U1', 'list')).allowed, true);
    assert.equal(calls, 1);
    assert.equal((await a.decide(lists, 'U1', 'start')).allowed, true); // 59 s > 10 s: refresh
    assert.equal(calls, 2);
    clock.t += 9_000;
    assert.equal((await a.decide(lists, 'U1', 'end')).allowed, true);
    assert.equal(calls, 2);
    clock.t += 61_000;
    fail = true;
    const d = await a.decide(lists, 'U1', 'list');
    assert.deepEqual(d, { allowed: false, reason: 'group_lookup_failed' });
  });
  void it('allow_users allows without a lookup', async () => {
    const a = new Authorizer({ usergroupMembers: () => Promise.reject(new Error('never')) });
    assert.equal((await a.decide({ allowUsers: ['U1'], allowUsergroups: ['S1'] }, 'U1', 'start')).allowed, true);
  });
});
