// Mention commands (DWA-MEN-*): an app_mention event becomes the same command as a slash command.
import type { SlashCommand } from './commands.js';

/** The fields of a Slack `app_mention` event that DWA reads. */
export interface MentionEvent {
  user?: string;
  /** Present on posts made through an app, including with a user token. NOT a filter (DWA-MEN-003). */
  bot_id?: string;
  subtype?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

/**
 * The command in a mention, or undefined when the event is not a command (DWA-MEN-002, 003).
 *
 * Only a leading mention of the app's own bot user counts: `<@UBOT> start 30m PROD -- why`. The label form
 * `<@UBOT|name>` is accepted. Only the first line is the command, because a client may append a line of its own
 * (an AI assistant's Slack connector adds "Sent using Claude"). An optional leading slash command name is ignored, so
 * `<@UBOT> /deploy list` works too.
 */
export function mentionToCommand(
  ev: MentionEvent,
  botUserId: string,
  slashCommand: string,
  envelopeId: string,
): SlashCommand | undefined {
  const { user, channel, text, ts } = ev;
  if (user === undefined || user === '' || user === botUserId) return undefined;
  if (ev.subtype !== undefined || channel === undefined || text === undefined) return undefined;
  const m = new RegExp(`^\\s*<@${botUserId}(?:\\|[^>]*)?>[ \\t]*(.*)`, 'u').exec(text);
  if (!m) return undefined;
  let line = (m[1] ?? '').trim();
  if (line.toLowerCase().startsWith(slashCommand.toLowerCase())) {
    const rest = line.slice(slashCommand.length);
    if (rest === '' || /^\s/u.test(rest)) line = rest.trim();
  }
  return {
    channelId: channel,
    userId: user,
    userName: undefined,
    text: line,
    responseUrl: '', // an event carries no response_url; replies go to the thread of the mention
    triggerId: `${channel}:${ts ?? envelopeId}`,
    ...(ts === undefined ? {} : { mention: { ts, threadTs: ev.thread_ts ?? ts } }),
  };
}
