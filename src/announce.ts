// Text of the announcement, thread replies and list output (DWA-ANN-*, DWA-MSG-003).
import type { FailureClass } from './grafana.js';
import { slackEscape } from './message.js';
import { type Block, textBlock } from './slack.js';

export type WindowStatus =
  | 'starting'
  | 'active'
  | 'partial'
  | 'failed'
  | 'failed, silences still active'
  | 'partly ended'
  | 'ended';

export interface SilenceLine {
  target: string;
  state: 'created' | 'failed' | 'expired' | 'expire failed';
  id?: string;
  failure?: FailureClass;
}

export interface Announcement {
  command: string;
  status: WindowStatus;
  windowId: string;
  env: string;
  targets: string[];
  startsAt: Date;
  endsAt: Date;
  userId: string;
  message: string;
  silences: SilenceLine[];
  note?: string;
}

/** Slack date token with a UTC fallback (DWA-GRA-009, DWA-ANN-003). */
export function slackDate(d: Date): string {
  const unix = Math.floor(d.getTime() / 1000);
  const fallback = `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `<!date^${String(unix)}^{date_short_pretty} {time}|${fallback}>`;
}

function silenceText(s: SilenceLine): string {
  const id = s.id === undefined ? '' : ` \`${s.id}\``;
  switch (s.state) {
    case 'created':
      return `• ${s.target}: silenced${id}`;
    case 'expired':
      return `• ${s.target}: ended${id}`;
    case 'failed':
      return `• ${s.target}: failed (${s.failure ?? 'rejected'})${id}`;
    case 'expire failed':
      return `• ${s.target}: still active, could not end it (${s.failure ?? 'rejected'})${id}`;
  }
}

export function renderAnnouncement(a: Announcement): { text: string; blocks: Block[] } {
  const lines = [
    `*Deploy window* \`${a.windowId}\` · *${a.status}* · ${a.env}`,
    `Targets: ${a.targets.join(', ')}`,
    `From ${slackDate(a.startsAt)} to ${slackDate(a.endsAt)}, started by <@${a.userId}>`,
  ];
  if (a.message !== '') lines.push(`> ${slackEscape(a.message)}`);
  if (a.status === 'starting') {
    lines.push(
      `If this message does not change within 1 minute, run \`${a.command} list\` and check the silences in Grafana.`,
    );
  }
  if (a.silences.length > 0) lines.push(...a.silences.map(silenceText));
  if (a.note !== undefined) lines.push(a.note);
  const text = lines.join('\n');
  return { text, blocks: [textBlock(text)] };
}

export function plain(text: string): { text: string; blocks: Block[] } {
  return { text, blocks: [textBlock(text)] };
}
