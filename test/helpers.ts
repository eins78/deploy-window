// Test doubles: an in-memory Grafana, a recording Slack, manual timers, the spec's channel fixtures.
import { Authorizer } from '../src/auth.js';
import type { Block, SlackOut } from '../src/slack.js';
import { SlackApiError } from '../src/slack.js';
import { DeployWindowApp, type Deps, type SlashCommand } from '../src/commands.js';
import { type Config, type Matcher, parseConfigText } from '../src/config.js';
import { GrafanaError, type GrafanaApi, type NewSilence, type Silence } from '../src/grafana.js';
import { createLogger } from '../src/log.js';
import { ChannelLocks, RateLimit } from '../src/memory.js';

export const T0 = Date.parse('2026-01-15T10:00:00Z');

export const CH_A = 'C0CHANNELA1';
export const CH_B = 'C0CHANNELB1';
export const CH_C = 'C0CHANNELC1';
export const USER = 'U0EXAMPLE01';
export const USER2 = 'U0EXAMPLE02';
export const STRANGER = 'U0STRANGER1';

/** Channel fixtures of spec section 12: A (INTEG, PROD, default INTEG, api+web, 4 h), B (PROD, app, 2 h), C (no default). */
export const FIXTURE_YAML = `
version: 1
slack: {command: /deploy, bot_token_env: DWA_SLACK_BOT_TOKEN, app_token_env: DWA_SLACK_APP_TOKEN}
grafana: {url: "http://127.0.0.1:3000", token_env: DWA_GRAFANA_TOKEN, alertmanager: grafana}
limits: {min_duration: 5m, max_duration: 4h, max_message_length: 300}
auth: {allow_users: [${USER}, ${USER2}]}
channels:
  ${CH_A}:
    label: "#deploys-example"
    environments: [INTEG, PROD]
    default_environment: INTEG
    targets:
      api:
        INTEG: [{matchers: [{name: target_id, value: example-integ-api}]}]
        PROD:
          - matchers: [{name: target_id, value: example-prod-api}]
          - matchers: [{name: target_id, value: example-prod-api-worker}]
      web:
        INTEG: [{matchers: [{name: target_id, value: example-integ-web}]}]
        PROD: [{matchers: [{name: target_id, value: example-prod-web}]}]
  ${CH_B}:
    environments: [PROD]
    max_duration: 2h
    targets:
      app: {PROD: [{matchers: [{name: target_id, value: example-app}]}]}
  ${CH_C}:
    environments: [INTEG, PROD]
    targets:
      api:
        INTEG: [{matchers: [{name: target_id, value: example-c-integ}]}]
        PROD: [{matchers: [{name: target_id, value: example-c-prod}]}]
`;

export function fixtureConfig(yaml = FIXTURE_YAML): Config {
  return parseConfigText(yaml);
}

export function channel(config: Config, id: string) {
  const c = config.channels.get(id);
  if (!c) throw new Error(`no channel ${id}`);
  return c;
}

type CreateHook = (s: NewSilence, n: number) => 'ok' | 'accept-then-timeout' | GrafanaError;

export class FakeGrafana implements GrafanaApi {
  silences: Silence[] = [];
  calls: string[] = [];
  creates: NewSilence[] = [];
  private seq = 0;
  onCreate: CreateHook = () => 'ok';
  onExpire: (id: string) => GrafanaError | undefined = () => undefined;
  listError: GrafanaError | undefined;
  alertCounts: (m: Matcher[]) => number = () => 0;

  constructor(public now: () => number = () => T0) {}

  listSilences(): Promise<Silence[]> {
    this.calls.push('list');
    if (this.listError) return Promise.reject(this.listError);
    return Promise.resolve(this.silences.map((s) => ({ ...s, matchers: [...s.matchers] })));
  }

  createSilence(s: NewSilence): Promise<string> {
    this.calls.push('create');
    this.creates.push(s);
    const hook = this.onCreate(s, this.creates.length);
    if (hook instanceof GrafanaError) return Promise.reject(hook);
    const id = `sil${String(++this.seq).padStart(4, '0')}`;
    const startsAt = new Date(Math.max(s.startsAt.getTime(), this.now()));
    this.silences.push({
      id,
      state: 'active',
      comment: s.comment,
      createdBy: s.createdBy,
      startsAt: startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      matchers: s.matchers.map((m) => ({ ...m })),
    });
    if (hook === 'accept-then-timeout') return Promise.reject(new GrafanaError('timeout', 'Grafana timed out'));
    return Promise.resolve(id);
  }

  expireSilence(id: string): Promise<void> {
    this.calls.push(`expire:${id}`);
    const err = this.onExpire(id);
    if (err) return Promise.reject(err);
    const s = this.silences.find((x) => x.id === id);
    if (s) {
      s.state = 'expired';
      s.endsAt = new Date(this.now()).toISOString();
    }
    return Promise.resolve();
  }

  countAlerts(m: Matcher[]): Promise<number> {
    this.calls.push('count');
    return Promise.resolve(this.alertCounts(m));
  }

  active(): Silence[] {
    return this.silences.filter((s) => s.state === 'active');
  }

  /** A silence that DWA did not create. */
  addForeign(comment: string): void {
    this.silences.push({
      id: `foreign${String(++this.seq)}`,
      state: 'active',
      comment,
      createdBy: 'someone',
      startsAt: new Date(this.now()).toISOString(),
      endsAt: new Date(this.now() + 3_600_000).toISOString(),
      matchers: [{ name: 'target_id', value: 'example-prod-api', isRegex: false }],
    });
  }
}

export interface Posted {
  channel: string;
  ts: string;
  text: string;
  blocks: Block[];
  threadTs: string | undefined;
}

export class FakeSlack implements SlackOut {
  posts: Posted[] = [];
  updates: { channel: string; ts: string; text: string; blocks: Block[] }[] = [];
  ephemerals: { channel: string; user: string; text: string }[] = [];
  responds: { url: string; text: string }[] = [];
  order: string[] = [];
  failPost: ((channel: string, threadTs?: string) => string | undefined) = () => undefined;
  failUpdate = false;
  failEphemeral = false;
  private seq = 0;

  post(channel: string, text: string, blocks: Block[], threadTs?: string): Promise<string> {
    this.order.push('post');
    const err = this.failPost(channel, threadTs);
    if (err !== undefined) return Promise.reject(new SlackApiError(err));
    const ts = `1768471200.${String(++this.seq).padStart(6, '0')}`;
    this.posts.push({ channel, ts, text, blocks, threadTs });
    return Promise.resolve(ts);
  }

  update(channel: string, ts: string, text: string, blocks: Block[]): Promise<void> {
    this.order.push('update');
    if (this.failUpdate) return Promise.reject(new SlackApiError('message_not_found'));
    this.updates.push({ channel, ts, text, blocks });
    return Promise.resolve();
  }

  ephemeral(channel: string, user: string, text: string): Promise<void> {
    this.order.push('ephemeral');
    if (this.failEphemeral) return Promise.reject(new SlackApiError('channel_not_found'));
    this.ephemerals.push({ channel, user, text });
    return Promise.resolve();
  }

  respond(url: string, text: string): Promise<void> {
    this.order.push('respond');
    this.responds.push({ url, text });
    return Promise.resolve();
  }

  lastEphemeral(): string {
    return this.ephemerals.at(-1)?.text ?? this.responds.at(-1)?.text ?? '';
  }

  lastUpdate(): string {
    return this.updates.at(-1)?.text ?? '';
  }
}

export class ManualTimers {
  pending = new Map<number, { fn: () => void; at: number }>();
  private seq = 0;
  constructor(public clock: { t: number }) {}
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { fn, at: this.clock.t + ms });
    return id;
  };
  clear = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  /** Advance the clock and run due timers. */
  advance(ms: number): void {
    this.clock.t += ms;
    for (const [id, p] of [...this.pending]) {
      if (p.at <= this.clock.t) {
        this.pending.delete(id);
        p.fn();
      }
    }
  }
}

export function makeHarness(opts: { config?: Config; groups?: Record<string, string[]>; markerKey?: Buffer } = {}) {
  const clock = { t: T0 };
  const config = opts.config ?? fixtureConfig();
  const grafana = new FakeGrafana(() => clock.t);
  const slack = new FakeSlack();
  const timers = new ManualTimers(clock);
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>), now: () => new Date(clock.t) });
  let ids = 0;
  const idQueue: string[] = [];
  const groups = opts.groups ?? {};
  const deps: Deps = {
    config: () => config,
    grafana,
    slack,
    auth: new Authorizer({
      usergroupMembers: (g) => {
        const m = groups[g];
        return m ? Promise.resolve(m) : Promise.reject(new SlackApiError('no_such_subteam'));
      },
    }, () => clock.t),
    log,
    locks: new ChannelLocks(),
    rateLimit: new RateLimit(10, 3_600_000, () => clock.t),
    now: () => clock.t,
    newId: () => idQueue.shift() ?? `win${'abcdefghijklmnopqrstuvwxyz'.charAt(ids++ % 26)}aaaa`,
    markerKey: opts.markerKey,
    sleep: () => Promise.resolve(),
    timers,
  };
  const app = new DeployWindowApp(deps);
  const run = (text: string, channelId = CH_A, userId = USER) =>
    app.handle(cmd(text, channelId, userId));
  return { app, deps, grafana, slack, timers, clock, lines, config, run, idQueue };
}

export function cmd(text: string, channelId = CH_A, userId = USER): SlashCommand {
  return {
    channelId,
    userId,
    userName: 'example',
    text,
    responseUrl: 'https://hooks.slack.com/commands/T0EXAMPLE/1/xyz',
    triggerId: `trig-${text}`,
  };
}

export function audits(lines: Record<string, unknown>[], event?: string): Record<string, unknown>[] {
  return lines.filter((l) => l.audit === true && (event === undefined || l.event === event));
}
