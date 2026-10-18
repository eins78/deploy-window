// Window state derived from marked silences only (spec 8.2). No database, no memory between commands.
import type { Matcher } from './config.js';
import type { Silence } from './grafana.js';
import { type ParsedMarker, parseMarker } from './marker.js';

export interface OwnSilence {
  silence: Silence;
  marker: ParsedMarker;
}

export interface ForeignSilence {
  silence: Silence;
  channelId: string | undefined;
}

export interface FindResult {
  own: OwnSilence[];
  foreign: ForeignSilence[];
}

export interface WindowView {
  id: string;
  channelId: string;
  env: string;
  userId: string;
  ts: string;
  message: string;
  startsAt: Date;
  endsAt: Date;
  /** Target → live silences and the expected count `n`. */
  targets: Map<string, { live: OwnSilence[]; expected: number }>;
}

const LIVE = new Set(['active', 'pending']);

/** DWA-GRA-004/005: keep only live silences with this deployment's marker prefix. */
export function classify(silences: Silence[], instance: string, key?: Buffer): FindResult {
  const own: OwnSilence[] = [];
  const foreign: ForeignSilence[] = [];
  for (const s of silences) {
    if (!LIVE.has(s.state)) continue;
    const p = parseMarker(s.comment, instance, key);
    if (p.kind === 'own') own.push({ silence: s, marker: p.marker });
    else if (p.kind === 'foreign') foreign.push({ silence: s, channelId: p.channelId });
  }
  return { own, foreign };
}

/** Groups own silences into windows. End time comes from `endsAt`, never from the comment (DWA-ST-002). */
export function windowsOf(own: OwnSilence[]): Map<string, WindowView> {
  const out = new Map<string, WindowView>();
  for (const o of own) {
    const m = o.marker;
    let w = out.get(m.windowId);
    if (!w) {
      w = {
        id: m.windowId,
        channelId: m.channelId,
        env: m.env,
        userId: m.userId,
        ts: m.ts,
        message: m.message,
        startsAt: new Date(o.silence.startsAt),
        endsAt: new Date(o.silence.endsAt),
        targets: new Map(),
      };
      out.set(m.windowId, w);
    }
    const start = new Date(o.silence.startsAt);
    const end = new Date(o.silence.endsAt);
    if (start < w.startsAt) w.startsAt = start;
    if (end > w.endsAt) w.endsAt = end;
    const t = w.targets.get(m.target) ?? { live: [], expected: m.entries };
    t.live.push(o);
    w.targets.set(m.target, t);
  }
  return out;
}

export function sameMatchers(a: Matcher[], b: Matcher[]): boolean {
  const key = (ms: Matcher[]) =>
    JSON.stringify(ms.map((m) => JSON.stringify([m.name, m.value, m.isRegex])).sort());
  return key(a) === key(b);
}
