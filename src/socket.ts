// Socket Mode wiring (DWA-SLK-001 to 003, DWA-CMD-011). No inbound port.
import type { DeployWindowApp, SlashCommand } from './commands.js';
import type { Logger } from './log.js';
import type { Dedupe } from './memory.js';

/** The part of SocketModeClient that DWA uses; tests pass an EventEmitter. */
export interface SocketLike {
  on(event: string, listener: (payload: unknown) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

interface SlashEnvelope {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  envelope_id?: string;
  body?: {
    command?: string;
    channel_id?: string;
    user_id?: string;
    user_name?: string;
    text?: string;
    response_url?: string;
    trigger_id?: string;
  };
}

export interface SocketOptions {
  /** Two or more connections: while one reconnects or refreshes, another is open. */
  sockets: SocketLike[];
  app: Pick<DeployWindowApp, 'handle'>;
  dedupe: Dedupe;
  log: Logger;
  command: () => string;
  onConnectedChange?: (connected: number) => void;
}

export function wireSockets(o: SocketOptions): { stop(): Promise<void> } {
  const up = new Set<number>();
  o.sockets.forEach((socket, index) => {
    socket.on('connected', () => {
      up.add(index);
      o.log.log('info', 'slack_connected', { connection: index, open: up.size });
      o.onConnectedChange?.(up.size);
    });
    const down = (event: string) => () => {
      up.delete(index);
      o.log.log('warning', event, { connection: index, open: up.size });
      o.onConnectedChange?.(up.size);
    };
    socket.on('disconnected', down('slack_disconnected'));
    socket.on('reconnecting', down('slack_reconnecting'));
    socket.on('slash_commands', (payload) => {
      void handleEnvelope(payload as SlashEnvelope);
    });
    const handleEnvelope = async (env: SlashEnvelope) => {
      // DWA-CMD-011: acknowledge first, before any other work.
      try {
        await env.ack();
      } catch (e) {
        o.log.log('error', 'ack_failed', { envelope: env.envelope_id, error: e });
      }
      const b = env.body ?? {};
      if (b.command !== o.command()) {
        o.log.log('warning', 'unexpected_command', { command: b.command });
        return;
      }
      if (o.dedupe.check([env.envelope_id, b.trigger_id])) {
        o.log.log('info', 'duplicate_delivery', { envelope: env.envelope_id });
        return;
      }
      const cmd: SlashCommand = {
        channelId: b.channel_id ?? '',
        userId: b.user_id ?? '',
        userName: b.user_name,
        text: b.text ?? '',
        responseUrl: b.response_url ?? '',
        triggerId: b.trigger_id,
      };
      if (cmd.channelId === '' || cmd.userId === '') {
        o.log.log('warning', 'malformed_command', { envelope: env.envelope_id });
        return;
      }
      await o.app.handle(cmd);
    };
  });
  return {
    async stop() {
      await Promise.allSettled(o.sockets.map((s) => s.disconnect()));
    },
  };
}
