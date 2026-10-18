// Slack output through a small interface, so tests inject a fake (DWA-DEP-007).
import type { WebClient } from '@slack/web-api';

export interface Block {
  type: 'section';
  text: { type: 'mrkdwn'; text: string; verbatim: true };
}

export interface SlackOut {
  /** chat.postMessage as the bot; returns the message ts. */
  post(channel: string, text: string, blocks: Block[], threadTs?: string): Promise<string>;
  /** chat.update of a bot message. */
  update(channel: string, ts: string, text: string, blocks: Block[]): Promise<void>;
  /** chat.postEphemeral to one user in one channel. */
  ephemeral(channel: string, user: string, text: string): Promise<void>;
  /** POST to the slash command's response_url (the fallback for ephemeral replies). */
  respond(responseUrl: string, text: string): Promise<void>;
}

export class SlackApiError extends Error {
  constructor(readonly code: string) {
    super(`Slack API error: ${code}`);
  }
}

/** The text block of an announcement or reply: `verbatim: true`, no link parsing (DWA-MSG-003). */
export function textBlock(text: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text, verbatim: true } };
}

function slackCode(e: unknown): string {
  const data = (e as { data?: { error?: unknown } }).data;
  return typeof data?.error === 'string' ? data.error : (e as Error).message;
}

export class WebSlackOut implements SlackOut {
  constructor(
    private readonly client: WebClient,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async post(channel: string, text: string, blocks: Block[], threadTs?: string): Promise<string> {
    try {
      const r = await this.client.chat.postMessage({
        channel,
        text,
        blocks,
        parse: 'none',
        unfurl_links: false,
        unfurl_media: false,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      });
      if (typeof r.ts !== 'string') throw new SlackApiError('no_ts');
      return r.ts;
    } catch (e) {
      if (e instanceof SlackApiError) throw e;
      throw new SlackApiError(slackCode(e));
    }
  }

  async update(channel: string, ts: string, text: string, blocks: Block[]): Promise<void> {
    try {
      await this.client.chat.update({ channel, ts, text, blocks, parse: 'none' });
    } catch (e) {
      throw new SlackApiError(slackCode(e));
    }
  }

  async ephemeral(channel: string, user: string, text: string): Promise<void> {
    try {
      await this.client.chat.postEphemeral({ channel, user, text, parse: 'none' });
    } catch (e) {
      throw new SlackApiError(slackCode(e));
    }
  }

  async respond(responseUrl: string, text: string): Promise<void> {
    if (!responseUrl.startsWith('https://hooks.slack.com/')) throw new SlackApiError('bad_response_url');
    const r = await this.fetchImpl(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new SlackApiError(`response_url_http_${String(r.status)}`);
  }
}

/** usergroups.users.list for the group lookup and the start-up check (DWA-AUTH-002, 008). */
export async function usergroupMembers(client: WebClient, groupId: string): Promise<string[]> {
  try {
    const r = await client.usergroups.users.list({ usergroup: groupId });
    return r.users ?? [];
  } catch (e) {
    throw new SlackApiError(slackCode(e));
  }
}
