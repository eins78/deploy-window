// covers: DWA-GRA-001, 003, 006..009, DWA-DEP-002, 004 (T-GRA-1, T-GRA-5, T-GRA-6, T-GRA-8, T-DEP-4)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GrafanaClient, GrafanaError } from '../src/grafana.js';

interface Call { url: string; init: RequestInit }

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: url.toString(), init: init ?? {} });
    const r = responses.shift();
    if (r === undefined) return Promise.reject(new Error('no response'));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { f: f as typeof fetch, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const client = (f: typeof fetch) =>
  new GrafanaClient({ url: 'http://127.0.0.1:3000', token: 'test-token-value', alertmanager: 'grafana', fetch: f, sleep: () => Promise.resolve() });

void describe('Grafana client', () => {
  void it('create: request body, URL, bearer token, UTC times (T-GRA-1)', async () => {
    const { f, calls } = fakeFetch([json(202, { silenceID: 'abc' })]);
    const id = await client(f).createSilence({
      matchers: [{ name: 'target_id', value: 'example-prod-api', isRegex: false }],
      startsAt: new Date('2026-01-15T09:59:00Z'),
      endsAt: new Date('2026-01-15T10:30:00Z'),
      createdBy: 'slack:U0EXAMPLE01 (Example User)',
      comment: 'dwa:v1 …',
    });
    assert.equal(id, 'abc');
    const c = calls[0];
    assert.equal(c?.url, 'http://127.0.0.1:3000/api/alertmanager/grafana/api/v2/silences');
    assert.equal(c?.init.method, 'POST');
    assert.equal((c?.init.headers as Record<string, string>).Authorization, 'Bearer test-token-value');
    assert.deepEqual(JSON.parse(c?.init.body as string), {
      matchers: [{ name: 'target_id', value: 'example-prod-api', isRegex: false, isEqual: true }],
      startsAt: '2026-01-15T09:59:00.000Z',
      endsAt: '2026-01-15T10:30:00.000Z',
      createdBy: 'slack:U0EXAMPLE01 (Example User)',
      comment: 'dwa:v1 …',
    });
  });

  void it('create is not retried by the client; a 5xx is a retryable error for the caller', async () => {
    const { f, calls } = fakeFetch([json(503, {})]);
    await assert.rejects(client(f).createSilence({ matchers: [], startsAt: new Date(), endsAt: new Date(), createdBy: '', comment: '' }), (e: GrafanaError) => e.retryable);
    assert.equal(calls.length, 1);
  });

  void it('expire: 200 and 404 are ok; another 4xx is a failure (T-GRA-5)', async () => {
    const { f, calls } = fakeFetch([json(200, { message: 'silence deleted' }), json(404, {}), json(400, { message: 'bad' })]);
    const g = client(f);
    await g.expireSilence('a');
    await g.expireSilence('b');
    await assert.rejects(g.expireSilence('c'), (e: GrafanaError) => e.failure === 'rejected');
    assert.equal(calls[0]?.url, 'http://127.0.0.1:3000/api/alertmanager/grafana/api/v2/silence/a');
    assert.equal(calls[0]?.init.method, 'DELETE');
  });

  void it('network errors and 5xx are retried twice; 4xx is not (T-GRA-6)', async () => {
    const a = fakeFetch([new Error('ECONNRESET'), json(502, {}), json(200, [])]);
    assert.deepEqual(await client(a.f).listSilences(), []);
    assert.equal(a.calls.length, 3);
    const b = fakeFetch([json(500, {}), json(500, {}), json(500, {})]);
    await assert.rejects(client(b.f).listSilences());
    assert.equal(b.calls.length, 3);
    const c = fakeFetch([json(400, {})]);
    await assert.rejects(client(c.f).listSilences(), (e: GrafanaError) => e.failure === 'rejected');
    assert.equal(c.calls.length, 1);
  });

  void it('a timeout is failure class timeout; every call has a timeout signal', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    const { f, calls } = fakeFetch([err, err, err]);
    await assert.rejects(client(f).listSilences(), (e: GrafanaError) => e.failure === 'timeout');
    assert.ok(calls[0]?.init.signal instanceof AbortSignal);
  });

  void it('limit rejections are class limit; 401/403 are auth (T-GRA-8)', async () => {
    const { f } = fakeFetch([json(400, { message: 'silence limit reached' }), json(403, {})]);
    const g = client(f);
    const s = { matchers: [], startsAt: new Date(), endsAt: new Date(), createdBy: '', comment: '' };
    await assert.rejects(g.createSilence(s), (e: GrafanaError) => e.failure === 'limit' && !e.retryable);
    await assert.rejects(g.createSilence(s), (e: GrafanaError) => e.failure === 'auth');
  });

  void it('list maps state and matchers; errors never contain the token (T-DEP-4)', async () => {
    const { f } = fakeFetch([
      json(200, [{ id: 's1', status: { state: 'active' }, comment: 'c', createdBy: 'u', startsAt: 'a', endsAt: 'b', matchers: [{ name: 'n', value: 'v', isRegex: false, isEqual: true }] }]),
    ]);
    const [s] = await client(f).listSilences();
    assert.deepEqual(s, { id: 's1', state: 'active', comment: 'c', createdBy: 'u', startsAt: 'a', endsAt: 'b', matchers: [{ name: 'n', value: 'v', isRegex: false }] });
    const bad = fakeFetch([new Error('x'), new Error('x'), new Error('x')]);
    await assert.rejects(client(bad.f).listSilences(), (e: Error) => !e.message.includes('test-token-value'));
  });

  void it('countAlerts sends Alertmanager filters (DWA-CFG-009)', async () => {
    const { f, calls } = fakeFetch([json(200, [{}, {}])]);
    const n = await client(f).countAlerts([{ name: 'target_id', value: 'x', isRegex: false }, { name: 'host', value: 'web-.+', isRegex: true }]);
    assert.equal(n, 2);
    const u = new URL(calls[0]?.url ?? '');
    assert.equal(u.pathname, '/api/alertmanager/grafana/api/v2/alerts');
    assert.deepEqual(u.searchParams.getAll('filter'), ['target_id="x"', 'host=~"web-.+"']);
  });

  void it('redirects are refused, so the token never goes to another host (DWA-DEP-002)', async () => {
    const { f, calls } = fakeFetch([json(200, [])]);
    await client(f).listSilences();
    assert.equal(calls[0]?.init.redirect, 'error');
  });
});
