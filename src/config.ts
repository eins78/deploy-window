// Configuration file: one YAML file, validated as a whole at start (spec section 4).
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';
import { parseDuration } from './duration.js';
import { MAX_COMMENT, markerOverhead } from './marker.js';
import { hasTokenShape } from './message.js';

export const DEFAULT_CONFIG_PATH = '/etc/deploy-window/config.yaml';

export interface Matcher {
  name: string;
  value: string;
  isRegex: boolean;
}

export interface Entry {
  matchers: Matcher[];
}

export interface AuthLists {
  allowUsers: string[];
  allowUsergroups: string[];
}

export interface ChannelConfig {
  id: string;
  label: string | undefined;
  environments: string[];
  defaultEnvironment: string | undefined;
  select: 'all' | 'explicit';
  onPartial: 'rollback' | 'keep';
  /** Minutes. */
  maxDuration: number | undefined;
  /** Canonical env name → minutes. */
  envMaxDuration: Record<string, number>;
  /** The effective allow lists (DWA-CFG-012): the channel block, or else the global block. */
  auth: AuthLists;
  /** Target name → canonical env name → entries. Insertion order is the configured order. */
  targets: Map<string, Map<string, Entry[]>>;
}

export interface Config {
  version: 1;
  slack: { command: string; botTokenEnv: string; appTokenEnv: string };
  grafana: { url: string; tokenEnv: string; alertmanager: string };
  limits: {
    minDuration: number;
    maxDuration: number;
    maxMessageLength: number;
    instance: string;
    maxSilencesPerWindow: number;
    maxConcurrentWindows: number;
    maxMatched: number | undefined;
  };
  markerKeyEnv: string | undefined;
  auditFile: string | undefined;
  channels: Map<string, ChannelConfig>;
}

export interface ConfigError {
  path: string;
  message: string;
}

export class ConfigInvalid extends Error {
  constructor(readonly errors: ConfigError[]) {
    super(errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
  }
}

const KEYWORDS = new Set(['start', 'end', 'list', 'help']);
const ENV_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const TARGET_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const SLACK_ID = /^[A-Z0-9]{1,16}$/;
const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

const durationText = z.string().refine((s) => parseDuration(s) !== undefined, {
  message: 'not a duration (examples: 30m, 4h, 1h30m)',
});

const matcherSchema = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
  is_regex: z.boolean().default(false),
});

const entrySchema = z.strictObject({
  matchers: z.array(matcherSchema),
  allow_regex: z.boolean().default(false),
});

const authSchema = z.strictObject({
  allow_users: z.array(z.string().regex(SLACK_ID, 'not a Slack user id')).optional(),
  allow_usergroups: z.array(z.string().regex(SLACK_ID, 'not a Slack user group id')).optional(),
});

const channelSchema = z.strictObject({
  label: z.string().optional(),
  environments: z.array(z.string()).min(1),
  default_environment: z.string().optional(),
  select: z.enum(['all', 'explicit']).default('all'),
  on_partial: z.enum(['rollback', 'keep']).default('rollback'),
  max_duration: durationText.optional(),
  env_max_duration: z.record(z.string(), durationText).default({}),
  auth: authSchema.optional(),
  targets: z.record(z.string(), z.record(z.string(), z.array(entrySchema))),
});

const envVarName = z.string().regex(ENV_VAR, 'not an environment variable name');

const fileSchema = z.strictObject({
  version: z.literal(1, { message: 'unknown version (supported: 1)' }),
  slack: z.strictObject({
    command: z.string().regex(/^\/[a-z0-9_-]{1,31}$/, 'not a slash command such as /deploy'),
    bot_token_env: envVarName,
    app_token_env: envVarName,
  }),
  grafana: z.strictObject({
    url: z.url(),
    token_env: envVarName,
    alertmanager: z.string().regex(/^[A-Za-z0-9_-]+$/).default('grafana'),
  }),
  limits: z
    .strictObject({
      min_duration: durationText.default('5m'),
      max_duration: durationText.default('4h'),
      max_message_length: z.number().int().min(0).default(300),
      instance: z.string().regex(/^[a-z0-9]{1,16}$/, 'must match [a-z0-9]{1,16}').default('dwa'),
      max_silences_per_window: z.number().int().min(1).default(20),
      max_concurrent_windows: z.number().int().min(1).default(10),
      max_matched: z.number().int().min(0).optional(),
    })
    .prefault({}),
  marker_key_env: envVarName.optional(),
  audit_file: z.string().min(1).optional(),
  auth: authSchema.default({}),
  channels: z.record(z.string(), channelSchema),
});

type FileConfig = z.infer<typeof fileSchema>;

const SECRET_KEYS = new Set(['token', 'password', 'secret']);

/** T-CFG-2: no token-shaped value anywhere, and no key that names a secret. */
function findSecrets(node: unknown, path: string, out: ConfigError[]): void {
  if (typeof node === 'string') {
    if (hasTokenShape(node) || /^(?:xox[a-z]-|xapp-|glsa_)/.test(node)) {
      out.push({ path, message: 'looks like a token; secrets belong in the environment (DWA-CFG-002)' });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => { findSecrets(v, `${path}[${String(i)}]`, out); });
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = path === '' ? k : `${path}.${k}`;
      if (SECRET_KEYS.has(k.toLowerCase()) && v !== null && v !== '') {
        out.push({ path: p, message: 'secret keys are not allowed; name an environment variable with *_env' });
      }
      findSecrets(v, p, out);
    }
  }
}

/** True when a regex matcher would match everything or the empty string (DWA-CFG-008). */
function regexTooBroad(source: string): string | undefined {
  if (source.trim() === '.*') return 'regex .* matches everything';
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`, 'u');
  } catch {
    return 'not a valid regular expression';
  }
  if (re.test('')) return 'regex matches the empty string';
  return undefined;
}

function validateChannel(
  id: string,
  raw: FileConfig['channels'][string],
  file: FileConfig,
  minDuration: number,
  globalMax: number,
  errors: ConfigError[],
): ChannelConfig | undefined {
  const at = (p: string) => `channels.${id}${p === '' ? '' : `.${p}`}`;
  const before = errors.length;
  if (!/^[CG][A-Z0-9]{2,15}$/.test(id)) {
    errors.push({ path: at(''), message: 'channels are keyed by Slack channel id (C…), not by name (DWA-CFG-005)' });
  }

  const envs: string[] = [];
  const envByLower = new Map<string, string>();
  raw.environments.forEach((env, i) => {
    const p = at(`environments[${String(i)}]`);
    if (!ENV_NAME.test(env)) errors.push({ path: p, message: `environment "${env}" must match [A-Za-z][A-Za-z0-9_.-]{0,31}` });
    else if (KEYWORDS.has(env.toLowerCase())) errors.push({ path: p, message: `environment "${env}" is a command keyword` });
    else if (parseDuration(env) !== undefined) errors.push({ path: p, message: `environment "${env}" looks like a duration` });
    if (envByLower.has(env.toLowerCase())) errors.push({ path: p, message: `environment "${env}" is listed twice (names are case-insensitive)` });
    envByLower.set(env.toLowerCase(), env);
    envs.push(env);
  });

  let defaultEnvironment: string | undefined;
  if (raw.default_environment !== undefined) {
    defaultEnvironment = envByLower.get(raw.default_environment.toLowerCase());
    if (defaultEnvironment === undefined) {
      errors.push({ path: at('default_environment'), message: `"${raw.default_environment}" is not in environments` });
    }
  }

  let maxDuration: number | undefined;
  if (raw.max_duration !== undefined) {
    maxDuration = parseDuration(raw.max_duration);
    if (maxDuration !== undefined && maxDuration < minDuration) {
      errors.push({ path: at('max_duration'), message: 'max_duration is below min_duration' });
    }
  }
  const envMaxDuration: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.env_max_duration)) {
    const env = envByLower.get(key.toLowerCase());
    const minutes = parseDuration(value);
    if (env === undefined) {
      errors.push({ path: at(`env_max_duration.${key}`), message: `"${key}" is not an environment of this channel` });
    } else if (minutes !== undefined) {
      if (minutes < minDuration) errors.push({ path: at(`env_max_duration.${key}`), message: 'below min_duration' });
      envMaxDuration[env] = minutes;
    }
  }
  if (maxDuration !== undefined && maxDuration > globalMax) {
    // A channel cap above the global cap is harmless (the lowest applies), but likely a mistake.
    maxDuration = globalMax;
  }

  const targetNames = Object.keys(raw.targets);
  if (targetNames.length === 0) errors.push({ path: at('targets'), message: 'a channel needs at least one target' });
  const targets = new Map<string, Map<string, Entry[]>>();
  const targetByLower = new Map<string, string>();
  for (const name of targetNames) {
    const tp = at(`targets.${name}`);
    if (!TARGET_NAME.test(name)) errors.push({ path: tp, message: `target "${name}" must match [a-z0-9][a-z0-9_.-]{0,62}` });
    else if (/^[0-9]+$/.test(name)) errors.push({ path: tp, message: `target "${name}" is all digits` });
    else if (parseDuration(name) !== undefined) errors.push({ path: tp, message: `target "${name}" looks like a duration` });
    if (KEYWORDS.has(name.toLowerCase())) errors.push({ path: tp, message: `target "${name}" is a command keyword` });
    if (envByLower.has(name.toLowerCase())) errors.push({ path: tp, message: `target "${name}" equals an environment name` });
    if (targetByLower.has(name.toLowerCase())) errors.push({ path: tp, message: `target "${name}" differs from another only in case` });
    targetByLower.set(name.toLowerCase(), name);

    const defs = raw.targets[name] ?? {};
    const byEnv = new Map<string, Entry[]>();
    for (const [envKey, entries] of Object.entries(defs)) {
      const env = envByLower.get(envKey.toLowerCase());
      const ep = `${tp}.${envKey}`;
      if (env === undefined) {
        errors.push({ path: ep, message: `"${envKey}" is not in environments` });
        continue;
      }
      if (entries.length === 0) errors.push({ path: ep, message: 'a mute definition needs at least one entry' });
      byEnv.set(
        env,
        entries.map((entry, i) => {
          const xp = `${ep}[${String(i)}]`;
          if (entry.matchers.length === 0) errors.push({ path: `${xp}.matchers`, message: 'empty matchers list' });
          entry.matchers.forEach((m, j) => {
            const mp = `${xp}.matchers[${String(j)}]`;
            if (m.value.trim() === '') errors.push({ path: mp, message: 'empty or white-space matcher value' });
            if (m.is_regex) {
              if (!entry.allow_regex) errors.push({ path: mp, message: 'regex matcher needs allow_regex: true on the entry' });
              const broad = regexTooBroad(m.value);
              if (broad) errors.push({ path: mp, message: broad });
            }
          });
          const hasEquality = entry.matchers.some((m) => !m.is_regex && m.value.trim() !== '');
          if (entry.matchers.length > 0 && !hasEquality) {
            errors.push({ path: xp, message: 'an entry needs at least one equality matcher with a value (DWA-CFG-008)' });
          }
          return { matchers: entry.matchers.map((m) => ({ name: m.name, value: m.value, isRegex: m.is_regex })) };
        }),
      );
    }
    for (const env of envs) {
      if (!byEnv.has(env)) errors.push({ path: tp, message: `no mute definition for environment ${env}` });
    }
    targets.set(name, byEnv);
  }

  const globalAuth = file.auth;
  const block = raw.auth ?? globalAuth;
  const auth: AuthLists = {
    allowUsers: block.allow_users ?? [],
    allowUsergroups: block.allow_usergroups ?? [],
  };
  if (auth.allowUsers.length === 0 && auth.allowUsergroups.length === 0) {
    errors.push({ path: at('auth'), message: 'no allowed user or user group for this channel (DWA-AUTH-006)' });
  }

  if (errors.length > before) return undefined;
  return {
    id,
    label: raw.label,
    environments: envs,
    defaultEnvironment,
    select: raw.select,
    onPartial: raw.on_partial,
    maxDuration,
    envMaxDuration,
    auth,
    targets,
  };
}

/** Validates parsed YAML. Throws ConfigInvalid with every error found. */
export function validateConfig(data: unknown): Config {
  const errors: ConfigError[] = [];
  findSecrets(data, '', errors);
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ path: issue.path.map(String).join('.') || '(root)', message: issue.message });
    }
    throw new ConfigInvalid(errors);
  }
  const file = parsed.data;
  const minDuration = parseDuration(file.limits.min_duration) ?? 5;
  const maxDuration = parseDuration(file.limits.max_duration) ?? 240;
  if (maxDuration < minDuration) errors.push({ path: 'limits.max_duration', message: 'max_duration is below min_duration' });
  if (minDuration < 1) errors.push({ path: 'limits.min_duration', message: 'min_duration must be at least 1m' });
  if (file.grafana.url.endsWith('/')) errors.push({ path: 'grafana.url', message: 'must not end with a slash' });
  if (!/^https?:\/\//.test(file.grafana.url)) errors.push({ path: 'grafana.url', message: 'must be an http or https URL' });

  const channels = new Map<string, ChannelConfig>();
  for (const [id, raw] of Object.entries(file.channels)) {
    const ch = validateChannel(id, raw, file, minDuration, maxDuration, errors);
    if (ch) channels.set(id, ch);
  }
  if (Object.keys(file.channels).length === 0) errors.push({ path: 'channels', message: 'no channel configured' });

  // DWA-CFG-013: marker plus message fit into one silence comment.
  let longestEnv = 0;
  let longestTarget = 0;
  let longestChannel = 0;
  for (const [id, raw] of Object.entries(file.channels)) {
    longestChannel = Math.max(longestChannel, id.length);
    for (const e of raw.environments) longestEnv = Math.max(longestEnv, e.length);
    for (const t of Object.keys(raw.targets)) longestTarget = Math.max(longestTarget, t.length);
  }
  const overhead = markerOverhead({
    instance: file.limits.instance,
    longestChannelId: longestChannel,
    longestEnv,
    longestTarget,
    signed: file.marker_key_env !== undefined,
  });
  if (file.limits.max_message_length > MAX_COMMENT - overhead) {
    errors.push({
      path: 'limits.max_message_length',
      message: `at most ${String(MAX_COMMENT - overhead)} with this configuration (500 minus a marker of ${String(overhead)})`,
    });
  }

  if (errors.length > 0) throw new ConfigInvalid(errors);
  return {
    version: 1,
    slack: { command: file.slack.command, botTokenEnv: file.slack.bot_token_env, appTokenEnv: file.slack.app_token_env },
    grafana: { url: file.grafana.url, tokenEnv: file.grafana.token_env, alertmanager: file.grafana.alertmanager },
    limits: {
      minDuration,
      maxDuration,
      maxMessageLength: file.limits.max_message_length,
      instance: file.limits.instance,
      maxSilencesPerWindow: file.limits.max_silences_per_window,
      maxConcurrentWindows: file.limits.max_concurrent_windows,
      maxMatched: file.limits.max_matched,
    },
    markerKeyEnv: file.marker_key_env,
    auditFile: file.audit_file,
    channels,
  };
}

export function parseConfigText(text: string): Config {
  let data: unknown;
  try {
    data = loadYaml(text);
  } catch (e) {
    throw new ConfigInvalid([{ path: '(file)', message: `YAML: ${(e as Error).message}` }]);
  }
  return validateConfig(data);
}

/** DWA-CFG-001: the path comes from DWA_CONFIG, default /etc/deploy-window/config.yaml. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.DWA_CONFIG;
  return p === undefined || p === '' ? DEFAULT_CONFIG_PATH : p;
}

export function loadConfigFile(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigInvalid([{ path: '(file)', message: `cannot read ${path}: ${(e as Error).message}` }]);
  }
  return parseConfigText(text);
}

/** Every env variable that holds a secret, for redaction (DWA-DEP-004). */
export function secretEnvNames(c: Config): string[] {
  const names = [c.slack.botTokenEnv, c.slack.appTokenEnv, c.grafana.tokenEnv];
  if (c.markerKeyEnv !== undefined) names.push(c.markerKeyEnv);
  return names;
}
