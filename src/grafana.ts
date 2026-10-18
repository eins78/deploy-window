// Grafana Alertmanager API client for silences (spec section 8.1).
import type { Matcher } from './config.js';

export type FailureClass = 'auth' | 'timeout' | 'rejected' | 'limit';

export class GrafanaError extends Error {
  constructor(
    readonly failure: FailureClass,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
  /** Network errors, timeouts and 5xx are retried; 4xx never (DWA-GRA-007). */
  get retryable(): boolean {
    return this.failure === 'timeout' || (this.status !== undefined && this.status >= 500);
  }
}

export interface Silence {
  id: string;
  state: string;
  comment: string;
  createdBy: string;
  startsAt: string;
  endsAt: string;
  matchers: Matcher[];
}

export interface NewSilence {
  matchers: Matcher[];
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  comment: string;
}

/** The surface the command layer needs; tests inject a fake. */
export interface GrafanaApi {
  listSilences(): Promise<Silence[]>;
  createSilence(s: NewSilence): Promise<string>;
  expireSilence(id: string): Promise<void>;
  countAlerts(matchers: Matcher[]): Promise<number>;
}

export interface GrafanaClientOptions {
  url: string;
  token: string;
  alertmanager: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const LIMIT_TEXT = /limit|maximum|too (?:large|many|long)|exceed/i;

function classify(status: number, body: string): GrafanaError {
  if (status === 401 || status === 403) return new GrafanaError('auth', `Grafana refused the token (HTTP ${String(status)})`, status);
  if (status >= 400 && status < 500 && LIMIT_TEXT.test(body)) {
    return new GrafanaError('limit', `Grafana limit reached (HTTP ${String(status)})`, status);
  }
  return new GrafanaError('rejected', `Grafana answered HTTP ${String(status)}`, status);
}

interface WireMatcher {
  name: string;
  value: string;
  isRegex: boolean;
  isEqual?: boolean;
}

interface WireSilence {
  id: string;
  status?: { state?: string };
  comment?: string;
  createdBy?: string;
  startsAt?: string;
  endsAt?: string;
  matchers?: WireMatcher[];
}

/** RFC 3339 in UTC with a Z suffix (DWA-GRA-009). */
export function utc(d: Date): string {
  return d.toISOString();
}

export class GrafanaClient implements GrafanaApi {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: GrafanaClientOptions) {
    this.base = `${opts.url}/api/alertmanager/${encodeURIComponent(opts.alertmanager)}/api/v2`;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async once(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, init);
    } catch (e) {
      const name = (e as Error).name;
      const what = name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'network error';
      // Never include the request (it carries the token); the cause message is enough.
      throw new GrafanaError('timeout', `Grafana ${what}: ${(e as Error).message}`);
    }
    try {
      return { status: res.status, text: await res.text() };
    } catch (e) {
      throw new GrafanaError('timeout', `Grafana answer could not be read: ${(e as Error).message}`);
    }
  }

  /** Runs a call with retries for network errors and 5xx; a 4xx is returned to the caller. */
  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    let last: GrafanaError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(500 * 3 ** (attempt - 1));
      try {
        const r = await this.once(method, path, body);
        if (r.status >= 500) {
          last = classify(r.status, r.text);
          continue;
        }
        return r;
      } catch (e) {
        if (!(e instanceof GrafanaError)) throw e;
        last = e;
      }
    }
    throw last ?? new GrafanaError('timeout', 'Grafana call failed');
  }

  async listSilences(): Promise<Silence[]> {
    const r = await this.call('GET', '/silences');
    if (r.status !== 200) throw classify(r.status, r.text);
    const data = JSON.parse(r.text) as WireSilence[];
    return data.map((s) => ({
      id: s.id,
      state: s.status?.state ?? 'unknown',
      comment: s.comment ?? '',
      createdBy: s.createdBy ?? '',
      startsAt: s.startsAt ?? '',
      endsAt: s.endsAt ?? '',
      matchers: (s.matchers ?? []).map((m) => ({ name: m.name, value: m.value, isRegex: m.isRegex })),
    }));
  }

  /** One attempt only: the caller retries after a find by window id (DWA-GRA-007). */
  async createSilence(s: NewSilence): Promise<string> {
    const r = await this.once('POST', '/silences', {
      matchers: s.matchers.map((m) => ({ name: m.name, value: m.value, isRegex: m.isRegex, isEqual: true })),
      startsAt: utc(s.startsAt),
      endsAt: utc(s.endsAt),
      createdBy: s.createdBy,
      comment: s.comment,
    });
    if (r.status !== 200 && r.status !== 202) throw classify(r.status, r.text);
    // Grafana accepted the call; if the id cannot be read, the result is unknown and the caller
    // must find the silence by window id before it creates again (class timeout = retry after find).
    let id: unknown;
    try {
      id = (JSON.parse(r.text) as { silenceID?: unknown }).silenceID;
    } catch {
      id = undefined;
    }
    if (typeof id !== 'string' || id === '') throw new GrafanaError('timeout', 'Grafana accepted the silence but returned no readable id');
    return id;
  }

  /** Idempotent: 404 and an already expired silence are ok (DWA-GRA-006). */
  async expireSilence(id: string): Promise<void> {
    const r = await this.call('DELETE', `/silence/${encodeURIComponent(id)}`);
    if (r.status === 200 || r.status === 404) return;
    throw classify(r.status, r.text);
  }

  async countAlerts(matchers: Matcher[]): Promise<number> {
    const q = new URLSearchParams();
    q.set('active', 'true');
    q.set('silenced', 'true');
    q.set('inhibited', 'true');
    for (const m of matchers) q.append('filter', `${m.name}${m.isRegex ? '=~' : '='}${JSON.stringify(m.value)}`);
    const r = await this.call('GET', `/alerts?${q.toString()}`);
    if (r.status !== 200) throw classify(r.status, r.text);
    return (JSON.parse(r.text) as unknown[]).length;
  }
}
