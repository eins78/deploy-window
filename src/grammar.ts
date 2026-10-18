// Command grammar (spec section 5.1). Pure: no Slack, no Grafana.
import type { ChannelConfig } from './config.js';
import { parseDuration } from './duration.js';
import { codePointLength, normalizeMessage } from './message.js';

export const ERROR_CODES = [
  'unknown_subcommand',
  'empty_list_item',
  'unexpected_argument',
  'duration_needs_unit',
  'unknown_env_or_target',
  'unexpected_duration',
  'duplicate_duration',
  'duplicate_env',
  'duration_missing',
  'duration_too_short',
  'duration_too_long',
  'env_required',
  'message_too_long',
] as const;
export type GrammarErrorCode = (typeof ERROR_CODES)[number];

export type Command =
  | { kind: 'help' }
  | { kind: 'list' }
  | {
      kind: 'start';
      /** Minutes. */
      duration: number;
      env: string;
      /** True when the env came from the channel default or the single-env rule. */
      envImplied: boolean;
      /** Explicitly named targets, deduplicated, in the order typed. Empty: none named. */
      targets: string[];
      message: string;
    }
  | { kind: 'end'; env: string | undefined; targets: string[]; message: string };

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; code: GrammarErrorCode; detail: string };

export interface GrammarLimits {
  minDuration: number;
  maxDuration: number;
  maxMessageLength: number;
}

// A separator token: --, em dash or en dash, with white space or the text boundary on both sides.
const SEPARATOR = /(^|\s)(--|—|–)(?=\s|$)/u;

function splitMessage(text: string): { head: string; message: string } {
  const m = SEPARATOR.exec(text);
  if (!m) return { head: text, message: '' };
  const start = m.index + (m[1] ?? '').length;
  return { head: text.slice(0, start), message: text.slice(start + (m[2] ?? '').length) };
}

/** Lowest applicable cap: global, channel, and the env's own cap (DWA-CMD-006). */
export function capFor(channel: ChannelConfig, limits: GrammarLimits, env: string | undefined): number {
  let cap = limits.maxDuration;
  if (channel.maxDuration !== undefined) cap = Math.min(cap, channel.maxDuration);
  if (env !== undefined) {
    const e = channel.envMaxDuration[env];
    if (e !== undefined) cap = Math.min(cap, e);
  }
  return cap;
}

const fail = (code: GrammarErrorCode, detail: string): ParseResult => ({ ok: false, code, detail });

export function parseCommand(text: string, channel: ChannelConfig, limits: GrammarLimits): ParseResult {
  const { head, message: rawMessage } = splitMessage(text);
  const words = head.split(/\s+/u).filter((w) => w !== '');
  const first = words[0];
  if (first === undefined) return { ok: true, command: { kind: 'help' } };

  const sub = first.toLowerCase();
  if (sub !== 'start' && sub !== 'end' && sub !== 'list' && sub !== 'help') {
    return fail('unknown_subcommand', `unknown command "${first}"`);
  }

  const tokens: string[] = [];
  for (const item of words.slice(1)) {
    for (const token of item.split(',')) {
      if (token === '') return fail('empty_list_item', `empty item in "${item}"`);
      tokens.push(token);
    }
  }

  if (sub === 'list' || sub === 'help') {
    if (tokens.length > 0) return fail('unexpected_argument', `${sub} takes no arguments`);
    return { ok: true, command: { kind: sub } };
  }

  const envByLower = new Map(channel.environments.map((e) => [e.toLowerCase(), e]));
  const targetByLower = new Map([...channel.targets.keys()].map((t) => [t.toLowerCase(), t]));

  // Classify every token, then report the error that ranks first (spec 5.1, "Which error wins").
  const found = new Map<GrammarErrorCode, string>();
  const note = (code: GrammarErrorCode, detail: string) => {
    if (!found.has(code)) found.set(code, detail);
  };
  const durations: number[] = [];
  const envs: string[] = [];
  const targets: string[] = [];
  for (const token of tokens) {
    if (/^[0-9]+$/.test(token)) {
      note('duration_needs_unit', `"${token}" needs a unit, for example ${token}m`);
      continue;
    }
    const minutes = parseDuration(token);
    if (minutes !== undefined) {
      if (sub === 'end') note('unexpected_duration', 'end takes no duration');
      durations.push(minutes);
      continue;
    }
    const env = envByLower.get(token.toLowerCase());
    if (env !== undefined) {
      if (!envs.includes(env)) envs.push(env);
      continue;
    }
    const target = targetByLower.get(token.toLowerCase());
    if (target !== undefined) {
      if (!targets.includes(target)) targets.push(target);
      continue;
    }
    note('unknown_env_or_target', `"${token}" is not an environment or target of this channel`);
  }
  if (sub === 'start' && durations.length > 1) note('duplicate_duration', 'give one duration');
  if (envs.length > 1) note('duplicate_env', `give one environment, not ${envs.join(' and ')}`);
  for (const code of ERROR_CODES) {
    const detail = found.get(code);
    if (detail !== undefined) return fail(code, detail);
  }

  const message = normalizeMessage(rawMessage);
  if (sub === 'end') {
    if (codePointLength(message) > limits.maxMessageLength) {
      return fail('message_too_long', `the message has more than ${String(limits.maxMessageLength)} characters`);
    }
    return { ok: true, command: { kind: 'end', env: envs[0], targets, message } };
  }

  const duration = durations[0];
  if (duration === undefined) return fail('duration_missing', 'give a duration, for example 30m');
  if (duration < limits.minDuration) {
    return fail('duration_too_short', `the minimum is ${String(limits.minDuration)} minutes`);
  }
  let env = envs[0];
  let envImplied = false;
  if (env === undefined) {
    if (channel.environments.length === 1) env = channel.environments[0];
    else env = channel.defaultEnvironment;
    envImplied = true;
  }
  const cap = capFor(channel, limits, env);
  if (duration > cap) return fail('duration_too_long', `the maximum here is ${String(cap)} minutes`);
  if (env === undefined) {
    return fail('env_required', `name an environment: ${channel.environments.join(', ')}`);
  }
  if (codePointLength(message) > limits.maxMessageLength) {
    return fail('message_too_long', `the message has more than ${String(limits.maxMessageLength)} characters`);
  }
  return { ok: true, command: { kind: 'start', duration, env, envImplied, targets, message } };
}

export function helpText(command: string, channel: ChannelConfig | undefined): string {
  const lines = [
    `*${command}* opens a deploy window: it silences the Grafana alerts of this channel's targets and announces the window.`,
    `• \`${command} start <duration> [env] [targets] -- message\`, for example \`${command} start 30m PROD -- release 2.4\``,
    `• \`${command} end [env] [targets] -- message\` ends the window early`,
    `• \`${command} list\` shows the active windows of this channel`,
    'Durations: `30m`, `2h`, `1h30m`. Targets are separated by spaces or commas. Text after `--` is a note for people.',
  ];
  if (channel) {
    lines.push(`Environments: ${channel.environments.join(', ')}. Targets: ${[...channel.targets.keys()].join(', ')}.`);
  }
  return lines.join('\n');
}
