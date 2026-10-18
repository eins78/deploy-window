// Command handling: start, end, list, help (spec sections 5.2, 6, 8, 9, 10).
import { type Announcement, renderAnnouncement, plain, slackDate, type SilenceLine, type WindowStatus } from './announce.js';
import type { Authorizer } from './auth.js';
import type { ChannelConfig, Config, Entry } from './config.js';
import { formatDuration } from './duration.js';
import { type FailureClass, GrafanaError, type GrafanaApi } from './grafana.js';
import { type Command, helpText, parseCommand } from './grammar.js';
import type { Logger } from './log.js';
import { formatMarker } from './marker.js';
import type { ChannelLocks, RateLimit } from './memory.js';
import { commentSafe, slackEscape } from './message.js';
import { type SlackOut, SlackApiError } from './slack.js';
import { classify, type FindResult, type OwnSilence, sameMatchers, type WindowView, windowsOf } from './state.js';

export interface SlashCommand {
  channelId: string;
  userId: string;
  userName: string | undefined;
  text: string;
  responseUrl: string;
  triggerId: string | undefined;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface Deps {
  config: () => Config;
  grafana: GrafanaApi;
  slack: SlackOut;
  auth: Authorizer;
  log: Logger;
  locks: ChannelLocks;
  rateLimit: RateLimit;
  now: () => number;
  newId: () => string;
  markerKey: Buffer | undefined;
  sleep: (ms: number) => Promise<void>;
  timers: Timers;
  /** DWA-SLK-006: "still working" after this long. */
  stillWorkingMs?: number;
  /** DWA-LIM-008: reminder this long before the end. */
  reminderLeadMs?: number;
}

const UNMAPPED = 'This channel is not set up for deploy windows.';
const DENIED = 'You are not allowed to run this command in this channel.';
const STARTING_BACKDATE_MS = 60_000;
const CREATE_ATTEMPTS = 3;

interface PlanItem {
  target: string;
  entry: Entry;
  entries: number;
}

interface CreateResult {
  target: string;
  id?: string;
  failure?: FailureClass;
}

function failureOf(e: unknown): FailureClass {
  return e instanceof GrafanaError ? e.failure : 'rejected';
}

export class DeployWindowApp {
  private readonly reminders = new Map<string, unknown>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly d: Deps) {}

  /** Entry point for one slash command, called after the envelope was acknowledged. */
  handle(cmd: SlashCommand): Promise<void> {
    const p = this.handleOne(cmd);
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
    return p;
  }

  /** Waits for running commands (on shutdown), at most `ms`. */
  async drain(ms: number): Promise<void> {
    if (this.running.size === 0) return;
    await Promise.race([Promise.allSettled([...this.running]), new Promise((r) => setTimeout(r, ms))]);
  }

  private async handleOne(cmd: SlashCommand): Promise<void> {
    const slow = this.d.timers.set(() => {
      void this.reply(cmd, 'Still working on it…');
    }, this.d.stillWorkingMs ?? 30_000);
    try {
      await this.dispatch(cmd);
    } catch (e) {
      this.d.log.log('error', 'command_failed', { channel: cmd.channelId, user: cmd.userId, error: e });
      await this.reply(cmd, 'The command failed. Run `list` to see the current state, and check the silences in Grafana.');
    } finally {
      this.d.timers.clear(slow);
    }
  }

  private async dispatch(cmd: SlashCommand): Promise<void> {
    const config = this.d.config(); // a running command keeps the configuration it started with
    const base = { channel: cmd.channelId, user: cmd.userId };
    // DWA-AUTH-007: DMs and unmapped conversations are refused; ids come from the envelope only.
    const ch = cmd.channelId.startsWith('D') ? undefined : config.channels.get(cmd.channelId);
    if (!ch) {
      this.d.log.audit('refused_unmapped_channel', base, 'warning');
      await this.reply(cmd, UNMAPPED);
      return;
    }

    const parsed = parseCommand(cmd.text, ch, config.limits);
    if (!parsed.ok) {
      this.d.log.audit('grammar_error', { ...base, code: parsed.code }, 'warning');
      const help = parsed.code === 'unknown_subcommand' ? `\n${helpText(config.slack.command, ch)}` : '';
      await this.reply(cmd, `\`${parsed.code}\`: ${slackEscape(parsed.detail)}${help}`);
      return;
    }
    const c = parsed.command;
    if (c.kind === 'help') {
      this.d.log.audit('help', base);
      await this.reply(cmd, helpText(config.slack.command, ch));
      return;
    }

    const decision = await this.d.auth.decide(ch.auth, cmd.userId, c.kind);
    if (!decision.allowed) {
      this.d.log.audit('denied', { ...base, action: c.kind, reason: decision.reason }, 'warning');
      await this.reply(cmd, DENIED);
      return;
    }

    await this.d.locks.run(ch.id, async () => {
      switch (c.kind) {
        case 'start':
          await this.start(cmd, c, ch, config);
          return;
        case 'end':
          await this.end(cmd, c, ch, config);
          return;
        case 'list':
          await this.list(cmd, ch, config);
          return;
      }
    });
  }

  // ---- shared helpers ----

  /** Ephemeral reply with chat.postEphemeral; response_url is the fallback (DWA-CMD-008). */
  private async reply(cmd: SlashCommand, text: string): Promise<void> {
    try {
      await this.d.slack.ephemeral(cmd.channelId, cmd.userId, text);
      return;
    } catch (e) {
      this.d.log.log('warning', 'ephemeral_failed', { channel: cmd.channelId, error: e });
    }
    try {
      await this.d.slack.respond(cmd.responseUrl, text);
    } catch (e) {
      this.d.log.log('error', 'reply_failed', { channel: cmd.channelId, error: e });
    }
  }

  private async find(config: Config): Promise<FindResult> {
    return classify(await this.d.grafana.listSilences(), config.limits.instance, this.d.markerKey);
  }

  private grafanaDown(cmd: SlashCommand, e: unknown): Promise<void> {
    this.d.log.log('error', 'grafana_unavailable', { channel: cmd.channelId, error: e });
    return this.reply(cmd, `Grafana is not reachable (${failureOf(e)}). Nothing was changed.`);
  }

  /** Expires every live silence of a window, found by window id (DWA-FAIL-002, DWA-LIM-005). */
  private async expireWindow(
    config: Config,
    windowId: string,
    targets?: string[],
  ): Promise<{ expired: OwnSilence[]; failed: { s: OwnSilence; failure: FailureClass }[] }> {
    const state = await this.find(config);
    const mine = state.own.filter(
      (o) => o.marker.windowId === windowId && (targets === undefined || targets.includes(o.marker.target)),
    );
    const expired: OwnSilence[] = [];
    const failed: { s: OwnSilence; failure: FailureClass }[] = [];
    for (const s of mine) {
      try {
        await this.d.grafana.expireSilence(s.silence.id);
        expired.push(s);
      } catch (e) {
        failed.push({ s, failure: failureOf(e) });
      }
    }
    return { expired, failed };
  }

  private async publish(channel: string, ts: string, a: Announcement): Promise<void> {
    const r = renderAnnouncement(a);
    try {
      await this.d.slack.update(channel, ts, r.text, r.blocks);
    } catch (e) {
      // DWA-FAIL-004: post the result as a new message.
      this.d.log.log('error', 'announcement_update_failed', { channel, ts, error: e });
      try {
        await this.d.slack.post(channel, r.text, r.blocks);
      } catch (e2) {
        this.d.log.log('error', 'announcement_post_failed', { channel, error: e2 });
      }
    }
  }

  // ---- start ----

  private async start(cmd: SlashCommand, c: Extract<Command, { kind: 'start' }>, ch: ChannelConfig, config: Config): Promise<void> {
    const base = {
      channel: ch.id,
      user: cmd.userId,
      env: c.env,
      duration: formatDuration(c.duration),
      message: c.message,
    };
    const refuse = async (reason: string, text: string, extra: Record<string, unknown> = {}) => {
      this.d.log.audit('start_refused', { ...base, reason, ...extra }, 'warning');
      await this.reply(cmd, text);
    };

    const targets = c.targets.length > 0 ? c.targets : ch.select === 'all' ? [...ch.targets.keys()] : [];
    if (targets.length === 0) {
      await refuse('targets_required', `Name at least one target: ${[...ch.targets.keys()].join(', ')}`);
      return;
    }
    const plan: PlanItem[] = [];
    for (const t of targets) {
      const entries = ch.targets.get(t)?.get(c.env) ?? [];
      for (const entry of entries) plan.push({ target: t, entry, entries: entries.length });
    }
    if (plan.length > config.limits.maxSilencesPerWindow) {
      await refuse('max_silences_per_window', `This window would need ${String(plan.length)} silences; the limit is ${String(config.limits.maxSilencesPerWindow)}.`);
      return;
    }

    let state: FindResult;
    try {
      state = await this.find(config);
    } catch (e) {
      await this.grafanaDown(cmd, e);
      return;
    }
    const windows = windowsOf(state.own);
    if (windows.size >= config.limits.maxConcurrentWindows) {
      await refuse('max_concurrent_windows', `${String(windows.size)} windows are active; the limit is ${String(config.limits.maxConcurrentWindows)}.`);
      return;
    }
    // DWA-LIM-003: one active window per (channel, target, env); a conflict blocks every target.
    const conflicts = [...windows.values()].filter(
      (w) => w.channelId === ch.id && w.env === c.env && targets.some((t) => w.targets.has(t)),
    );
    if (conflicts.length > 0) {
      const list = conflicts.map((w) => `\`${w.id}\` by <@${w.userId}> until ${slackDate(w.endsAt)}`).join('; ');
      await refuse('conflict', `A window is already active for these targets in ${c.env}: ${list}. Nothing was changed.`, {
        conflicting: conflicts.map((w) => w.id),
      });
      return;
    }
    // DWA-CFG-009: refuse when a matcher became broader than allowed.
    const maxMatched = config.limits.maxMatched;
    if (maxMatched !== undefined) {
      for (const p of plan) {
        let count: number;
        try {
          count = await this.d.grafana.countAlerts(p.entry.matchers);
        } catch (e) {
          await refuse('max_matched_unchecked', `Could not count the alerts that the matchers of ${p.target} match (${failureOf(e)}). Nothing was changed.`);
          return;
        }
        if (count > maxMatched) {
          await refuse('limit', `The matchers of ${p.target} match ${String(count)} alerts; the limit is ${String(maxMatched)}. Nothing was changed.`);
          return;
        }
      }
    }

    if (!this.d.rateLimit.take(cmd.userId)) {
      await refuse('rate_limited', 'Too many starts: at most 10 per hour per user.');
      return;
    }

    let windowId = this.d.newId();
    for (let i = 0; i < 5 && windows.has(windowId); i++) windowId = this.d.newId();
    if (windows.has(windowId)) throw new Error('window id collision');

    const now = this.d.now();
    const startsAt = new Date(now);
    const endsAt = new Date(now + c.duration * 60_000);
    const announcement: Announcement = {
      command: config.slack.command,
      status: 'starting',
      windowId,
      env: c.env,
      targets,
      startsAt,
      endsAt,
      userId: cmd.userId,
      message: c.message,
      silences: [],
    };

    // DWA-SLK-004: announce first; if that fails, change nothing in Grafana.
    let ts: string;
    try {
      const r = renderAnnouncement(announcement);
      ts = await this.d.slack.post(ch.id, r.text, r.blocks);
    } catch (e) {
      const code = e instanceof SlackApiError ? e.code : 'unknown';
      this.d.log.audit('start_failed', { ...base, window: windowId, reason: 'announcement', slack_error: code }, 'warning');
      await this.reply(
        cmd,
        code === 'not_in_channel'
          ? 'The app is not a member of this channel. Invite it, then try again. Nothing was changed.'
          : 'Could not post the announcement. Nothing was changed.',
      );
      return;
    }

    const comment = (p: PlanItem) =>
      formatMarker(
        {
          instance: config.limits.instance,
          windowId,
          channelId: ch.id,
          env: c.env,
          target: p.target,
          entries: p.entries,
          userId: cmd.userId,
          ts,
        },
        commentSafe(c.message),
        this.d.markerKey,
      );
    const createdBy = `slack:${cmd.userId}${cmd.userName === undefined ? '' : ` (${cmd.userName})`}`;

    const results: CreateResult[] = [];
    for (const p of plan) {
      results.push(
        await this.createOne(config, p, {
          matchers: p.entry.matchers,
          startsAt: new Date(now - STARTING_BACKDATE_MS),
          endsAt,
          createdBy,
          comment: comment(p),
        }, windowId),
      );
    }

    const created = results.filter((r) => r.id !== undefined);
    const failedCount = results.length - created.length;
    let status: WindowStatus = 'active';
    let lines: SilenceLine[] = results.map((r) =>
      r.id !== undefined
        ? { target: r.target, state: 'created', id: r.id }
        : { target: r.target, state: 'failed', failure: r.failure ?? 'rejected' },
    );
    let note: string | undefined;

    if (failedCount > 0) {
      if (created.length > 0 && ch.onPartial === 'keep') {
        status = 'partial';
        note = 'Some silences failed; the others stay active (on_partial: keep).';
      } else {
        const rb = await this.rollback(config, windowId);
        lines = [
          ...lines.filter((l) => l.state === 'failed'),
          ...rb.lines,
        ];
        status = rb.stillActive ? 'failed, silences still active' : 'failed';
        if (created.length > 0) note = 'Some silences failed, so the window was rolled back (on_partial: rollback).';
      }
    }

    // DWA-LIM-005: after creation, the lexically lower window id wins a race on the same pair.
    if (status === 'active' || status === 'partial') {
      const lost = await this.lostRace(config, ch.id, c.env, targets, windowId);
      if (lost !== undefined) {
        const rb = await this.rollback(config, windowId);
        lines = rb.lines;
        status = rb.stillActive ? 'failed, silences still active' : 'failed';
        note = `Window \`${lost.id}\` by <@${lost.userId}> started for the same targets at the same time and wins; this one was withdrawn.`;
      }
    }

    announcement.status = status;
    announcement.silences = lines;
    if (note !== undefined) announcement.note = note;
    await this.publish(ch.id, ts, announcement);

    if (status === 'active' || status === 'partial') this.scheduleReminder(config, ch.id, windowId, ts, endsAt);
    this.d.log.audit('start', {
      ...base,
      window: windowId,
      targets,
      status,
      ts,
      silences: lines.map((l) => ({ target: l.target, id: l.id, result: l.state, failure: l.failure })),
    }, status === 'active' ? 'info' : 'warning');
    if (status !== 'active' && status !== 'partial') {
      await this.reply(cmd, `The window \`${windowId}\` was not opened: ${status}. See the announcement.`);
    }
  }

  /** One silence; retries only after a find shows it does not exist (DWA-GRA-007). */
  private async createOne(
    config: Config,
    p: PlanItem,
    s: Parameters<GrafanaApi['createSilence']>[0],
    windowId: string,
  ): Promise<CreateResult> {
    let last: FailureClass = 'timeout';
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.d.sleep(500 * 3 ** (attempt - 1));
      try {
        return { target: p.target, id: await this.d.grafana.createSilence(s) };
      } catch (e) {
        if (!(e instanceof GrafanaError) || !e.retryable) return { target: p.target, failure: failureOf(e) };
        last = e.failure;
      }
      try {
        const state = await this.find(config);
        const existing = state.own.find(
          (o) =>
            o.marker.windowId === windowId &&
            o.marker.target === p.target &&
            sameMatchers(o.silence.matchers, p.entry.matchers),
        );
        if (existing) return { target: p.target, id: existing.silence.id };
      } catch {
        // Without a find we cannot prove the silence is absent, so we do not create again.
        // Rollback (or keep) still sweeps the window id afterwards.
        return { target: p.target, failure: last };
      }
    }
    return { target: p.target, failure: last };
  }

  private async rollback(config: Config, windowId: string): Promise<{ lines: SilenceLine[]; stillActive: boolean }> {
    try {
      const r = await this.expireWindow(config, windowId);
      return {
        lines: [
          ...r.expired.map((s): SilenceLine => ({ target: s.marker.target, state: 'expired', id: s.silence.id })),
          ...r.failed.map((f): SilenceLine => ({ target: f.s.marker.target, state: 'expire failed', id: f.s.silence.id, failure: f.failure })),
        ],
        stillActive: r.failed.length > 0,
      };
    } catch (e) {
      this.d.log.log('error', 'rollback_failed', { window: windowId, error: e });
      return { lines: [], stillActive: true };
    }
  }

  private async lostRace(
    config: Config,
    channelId: string,
    env: string,
    targets: string[],
    windowId: string,
  ): Promise<WindowView | undefined> {
    let state: FindResult;
    try {
      state = await this.find(config);
    } catch (e) {
      this.d.log.log('warning', 'race_check_failed', { window: windowId, error: e });
      return undefined;
    }
    const rivals = [...windowsOf(state.own).values()]
      .filter((w) => w.id !== windowId && w.channelId === channelId && w.env === env)
      .filter((w) => targets.some((t) => w.targets.has(t)))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const first = rivals[0];
    return first !== undefined && first.id < windowId ? first : undefined;
  }

  // ---- reminder (DWA-LIM-008): best effort, in process only ----

  private scheduleReminder(config: Config, channelId: string, windowId: string, ts: string, endsAt: Date): void {
    const lead = this.d.reminderLeadMs ?? 5 * 60_000;
    const delay = endsAt.getTime() - lead - this.d.now();
    if (delay <= 0) return;
    const handle = this.d.timers.set(() => {
      this.reminders.delete(windowId);
      void this.remind(config, channelId, windowId, ts);
    }, delay);
    this.reminders.set(windowId, handle);
  }

  private async remind(config: Config, channelId: string, windowId: string, ts: string): Promise<void> {
    try {
      const w = windowsOf((await this.find(config)).own).get(windowId);
      if (!w) return;
      const r = plain(`Deploy window \`${windowId}\` ends ${slackDate(w.endsAt)}. Run \`${config.slack.command} end\` when the deploy is done.`);
      await this.d.slack.post(channelId, r.text, r.blocks, ts);
    } catch (e) {
      this.d.log.log('warning', 'reminder_failed', { window: windowId, error: e });
    }
  }

  private cancelReminder(windowId: string): void {
    const h = this.reminders.get(windowId);
    if (h !== undefined) this.d.timers.clear(h);
    this.reminders.delete(windowId);
  }

  // ---- end ----

  private async end(cmd: SlashCommand, c: Extract<Command, { kind: 'end' }>, ch: ChannelConfig, config: Config): Promise<void> {
    const base = { channel: ch.id, user: cmd.userId, env: c.env, targets: c.targets, message: c.message };
    if (c.targets.length === 0 && ch.select === 'explicit') {
      this.d.log.audit('end_refused', { ...base, reason: 'targets_required' }, 'warning');
      await this.reply(cmd, `Name at least one target: ${[...ch.targets.keys()].join(', ')}`);
      return;
    }
    let state: FindResult;
    try {
      state = await this.find(config);
    } catch (e) {
      await this.grafanaDown(cmd, e);
      return;
    }
    const matching = [...windowsOf(state.own).values()].filter(
      (w) =>
        w.channelId === ch.id &&
        (c.env === undefined || w.env === c.env) &&
        (c.targets.length === 0 || c.targets.some((t) => w.targets.has(t))),
    );
    if (matching.length === 0) {
      this.d.log.audit('end_none', base);
      await this.reply(cmd, 'No active window matches.');
      return;
    }
    if (matching.length > 1) {
      this.d.log.audit('end_ambiguous', { ...base, windows: matching.map((w) => w.id) });
      const lines = matching.map((w) => `• \`${w.id}\` ${w.env}: ${[...w.targets.keys()].join(', ')}, by <@${w.userId}>, until ${slackDate(w.endsAt)}`);
      await this.reply(cmd, `Several windows match; nothing was ended. Repeat \`end\` with an environment or targets:\n${lines.join('\n')}`);
      return;
    }
    const w = matching[0];
    if (w === undefined) return;
    const selected = c.targets.length === 0 ? undefined : c.targets.filter((t) => w.targets.has(t));
    // DWA-FAIL-003: try every silence, report the ones that remain.
    const all = [...w.targets.values()].flatMap((t) => t.live);
    const toEnd = all.filter((o) => selected === undefined || selected.includes(o.marker.target));
    const expired: OwnSilence[] = [];
    const failed: { s: OwnSilence; failure: FailureClass }[] = [];
    for (const o of toEnd) {
      try {
        await this.d.grafana.expireSilence(o.silence.id);
        expired.push(o);
      } catch (e) {
        failed.push({ s: o, failure: failureOf(e) });
      }
    }
    const remaining = all.filter((o) => !expired.includes(o));
    const status: WindowStatus = remaining.length === 0 ? 'ended' : 'partly ended';
    if (status === 'ended') this.cancelReminder(w.id);

    const endedTargets = [...new Set(expired.map((o) => o.marker.target))];
    const replyLines = [`Window \`${w.id}\` ${status} by <@${cmd.userId}>${endedTargets.length > 0 ? `: ${endedTargets.join(', ')}` : ''}.`];
    if (c.message !== '') replyLines.push(`> ${slackEscape(c.message)}`);
    for (const f of failed) replyLines.push(`• ${f.s.marker.target}: could not end \`${f.s.silence.id}\` (${f.failure})`);
    const r = plain(replyLines.join('\n'));
    try {
      await this.d.slack.post(ch.id, r.text, r.blocks, w.ts);
    } catch (e) {
      this.d.log.log('warning', 'thread_reply_failed', { channel: ch.id, window: w.id, error: e });
      try {
        await this.d.slack.post(ch.id, r.text, r.blocks);
      } catch (e2) {
        this.d.log.log('error', 'end_reply_failed', { channel: ch.id, window: w.id, error: e2 });
        await this.reply(cmd, r.text);
      }
    }

    await this.publish(ch.id, w.ts, {
      command: config.slack.command,
      status,
      windowId: w.id,
      env: w.env,
      targets: [...w.targets.keys()],
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      userId: w.userId,
      message: w.message,
      silences: [
        ...expired.map((o): SilenceLine => ({ target: o.marker.target, state: 'expired', id: o.silence.id })),
        ...failed.map((f): SilenceLine => ({ target: f.s.marker.target, state: 'expire failed', id: f.s.silence.id, failure: f.failure })),
        ...remaining
          .filter((o) => !failed.some((f) => f.s === o))
          .map((o): SilenceLine => ({ target: o.marker.target, state: 'created', id: o.silence.id })),
      ],
    });

    this.d.log.audit('end', {
      ...base,
      window: w.id,
      status,
      silences: [
        ...expired.map((o) => ({ target: o.marker.target, id: o.silence.id, result: 'expired' })),
        ...failed.map((f) => ({ target: f.s.marker.target, id: f.s.silence.id, result: 'failed', failure: f.failure })),
      ],
    }, failed.length > 0 ? 'warning' : 'info');
  }

  // ---- list ----

  private async list(cmd: SlashCommand, ch: ChannelConfig, config: Config): Promise<void> {
    let state: FindResult;
    try {
      state = await this.find(config);
    } catch (e) {
      await this.grafanaDown(cmd, e);
      return;
    }
    const windows = [...windowsOf(state.own).values()].filter((w) => w.channelId === ch.id);
    const foreign = state.foreign.filter((f) => f.channelId === ch.id).length;
    this.d.log.audit('list', { channel: ch.id, user: cmd.userId, windows: windows.map((w) => w.id), foreign });
    const lines = windows.map((w) => {
      const targets = [...w.targets.entries()]
        .map(([t, v]) => (v.live.length < v.expected ? `${t} (incomplete: ${String(v.live.length)} of ${String(v.expected)})` : t))
        .join(', ');
      const msg = w.message === '' ? '' : ` — ${slackEscape(w.message)}`;
      return `• \`${w.id}\` ${w.env}: ${targets}; until ${slackDate(w.endsAt)}; by <@${w.userId}>${msg}`;
    });
    if (foreign > 0) lines.push(`• ${String(foreign)} silence(s) with a foreign marker (wrong format or signature); check them in Grafana.`);
    await this.reply(cmd, lines.length === 0 ? 'No active window in this channel.' : lines.join('\n'));
  }

  /** DWA-ST-007: after a restart, one audit line per active marked silence. */
  async logActiveAtStart(): Promise<void> {
    const config = this.d.config();
    try {
      const state = await this.find(config);
      for (const o of state.own) {
        this.d.log.audit('active_at_start', {
          window: o.marker.windowId,
          channel: o.marker.channelId,
          target: o.marker.target,
          ts: o.marker.ts,
          ends: o.silence.endsAt,
          silence: o.silence.id,
        });
      }
    } catch (e) {
      this.d.log.log('warning', 'active_at_start_failed', { error: e });
    }
  }
}
