#!/usr/bin/env node
// deploy-window: run the app, or check a configuration file.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { LogLevel, SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { Authorizer } from './auth.js';
import { DeployWindowApp } from './commands.js';
import { type Config, ConfigInvalid, configPath, loadConfigFile, secretEnvNames } from './config.js';
import { reloadConfig } from './reload.js';
import { GrafanaClient } from './grafana.js';
import { HealthFile } from './health.js';
import { createLogger, type Logger, redact } from './log.js';
import { newWindowId, parseMarkerKey } from './marker.js';
import { ChannelLocks, Dedupe, RateLimit } from './memory.js';
import { SlackApiError, usergroupMembers, WebSlackOut } from './slack.js';
import { wireSockets } from './socket.js';

const EXIT_CONFIG = 2;
const CONNECTIONS = 2;

function printConfigErrors(e: ConfigInvalid, path: string): void {
  process.stderr.write(`invalid configuration ${path}:\n`);
  for (const err of e.errors) process.stderr.write(`  ${err.path}: ${err.message}\n`);
}

function loadOrExit(path: string): Config {
  try {
    return loadConfigFile(path);
  } catch (e) {
    if (e instanceof ConfigInvalid) {
      printConfigErrors(e, path);
      process.exit(EXIT_CONFIG);
    }
    throw e;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    process.stderr.write(`environment variable ${name} is not set\n`);
    process.exit(EXIT_CONFIG);
  }
  return v;
}

/** A logger for the Slack SDK that goes through our redacting JSON logger. */
function slackLogger(log: Logger, name: string) {
  let level = LogLevel.WARN;
  const at = (l: 'info' | 'warning' | 'error') => (...msg: unknown[]) => {
    log.log(l, 'slack_sdk', { source: name, message: msg.map(String).join(' ') });
  };
  return {
    debug: () => undefined,
    info: (...msg: unknown[]) => { if (level === LogLevel.INFO || level === LogLevel.DEBUG) at('info')(...msg); },
    warn: at('warning'),
    error: at('error'),
    setLevel: (l: LogLevel) => { level = l; },
    getLevel: () => level,
    setName: () => undefined,
  };
}

/** sd_notify through systemd-notify; the unit sets NotifyAccess=all (DWA-OPS-002). */
function notify(state: string): void {
  if (process.env.NOTIFY_SOCKET === undefined) return;
  execFile('systemd-notify', [`--pid=${String(process.pid)}`, state], () => undefined);
}

function refuseTlsOff(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    // DWA-DEP-002: TLS verification cannot be switched off.
    process.stderr.write('NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed\n');
    process.exit(EXIT_CONFIG);
  }
}

async function checkConfig(args: string[]): Promise<number> {
  refuseTlsOff();
  const path = configPath();
  let config: Config;
  try {
    config = loadConfigFile(path);
  } catch (e) {
    if (e instanceof ConfigInvalid) {
      printConfigErrors(e, path);
      return EXIT_CONFIG;
    }
    throw e;
  }
  process.stdout.write(`configuration ${path} is valid: ${String(config.channels.size)} channel(s)\n`);
  if (!args.includes('--dry-run')) return 0;

  // DWA-CFG-009: how many alerts each entry matches now.
  const token = requireEnv(config.grafana.tokenEnv);
  const grafana = new GrafanaClient({ url: config.grafana.url, token, alertmanager: config.grafana.alertmanager });
  let refused = 0;
  for (const ch of config.channels.values()) {
    for (const [target, byEnv] of ch.targets) {
      for (const [env, entries] of byEnv) {
        for (const [i, entry] of entries.entries()) {
          const where = `${ch.id} ${target} ${env} entry ${String(i)}`;
          try {
            const n = await grafana.countAlerts(entry.matchers);
            const max = config.limits.maxMatched;
            const over = max !== undefined && n > max;
            if (over) refused++;
            process.stdout.write(`${where}: ${String(n)} alert(s)${over ? ` — REFUSED, above max_matched ${String(max)}` : ''}\n`);
          } catch (e) {
            refused++;
            process.stdout.write(`${where}: count failed: ${redact((e as Error).message, [token])}\n`);
          }
        }
      }
    }
  }
  return refused > 0 ? 1 : 0;
}

async function run(): Promise<void> {
  const path = configPath();
  refuseTlsOff();
  let config = loadOrExit(path);
  const botToken = requireEnv(config.slack.botTokenEnv);
  const appToken = requireEnv(config.slack.appTokenEnv);
  const grafanaToken = requireEnv(config.grafana.tokenEnv);
  let markerKey: Buffer | undefined;
  if (config.markerKeyEnv !== undefined) {
    try {
      markerKey = parseMarkerKey(requireEnv(config.markerKeyEnv));
    } catch (e) {
      process.stderr.write(`${config.markerKeyEnv}: ${(e as Error).message}\n`);
      process.exit(EXIT_CONFIG);
    }
  }
  const secretNames = secretEnvNames(config);
  const log = createLogger({
    auditFile: config.auditFile,
    secrets: () => secretNames.map((n) => process.env[n] ?? '').filter((v) => v !== ''),
  });

  // Bounded retries and a timeout, so a Slack outage cannot hold a channel lock for long.
  const web = new WebClient(botToken, {
    logger: slackLogger(log, 'web-api'),
    timeout: 10_000,
    retryConfig: { retries: 2, factor: 2, minTimeout: 1000, maxTimeout: 4000 },
    rejectRateLimitedCalls: true,
  });
  // DWA-OPS-001: self-check. A failed Slack check ends the process (systemd restarts it).
  try {
    const who = await web.auth.test();
    log.log('info', 'self_check_slack', { ok: true, team: who.team_id, bot: who.user_id });
  } catch (e) {
    log.log('error', 'self_check_slack', { ok: false, error: e });
    process.exit(1);
  }
  // DWA-AUTH-008: every configured user group must exist in this workspace.
  const groups = new Set([...config.channels.values()].flatMap((c) => c.auth.allowUsergroups));
  for (const g of groups) {
    try {
      await usergroupMembers(web, g);
    } catch (e) {
      if (e instanceof SlackApiError && (e.code === 'no_such_subteam' || e.code === 'plan_upgrade_required')) {
        process.stderr.write(`user group ${g} is not available in this workspace; use allow_users or fix the id\n`);
        process.exit(EXIT_CONFIG);
      }
      log.log('warning', 'usergroup_check_failed', { group: g, error: e });
    }
  }
  const grafana = new GrafanaClient({ url: config.grafana.url, token: grafanaToken, alertmanager: config.grafana.alertmanager });
  try {
    await grafana.listSilences();
    log.log('info', 'self_check_grafana', { ok: true });
  } catch (e) {
    // DWA-FAIL-005: keep running; commands that need Grafana fail with a clear message.
    log.log('error', 'self_check_grafana', { ok: false, error: e });
  }

  const app = new DeployWindowApp({
    config: () => config,
    grafana,
    slack: new WebSlackOut(web),
    auth: new Authorizer({ usergroupMembers: (id) => usergroupMembers(web, id) }),
    log,
    locks: new ChannelLocks(),
    rateLimit: new RateLimit(),
    now: Date.now,
    newId: () => newWindowId(),
    markerKey,
    sleep: (ms) => sleep(ms),
    timers: {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => { clearTimeout(h as NodeJS.Timeout); },
    },
  });
  await app.logActiveAtStart();

  // DWA-CFG-004: reload on SIGHUP; a bad file keeps the old configuration.
  process.on('SIGHUP', () => {
    config = reloadConfig(path, config, log);
  });

  let watchdog: NodeJS.Timeout | undefined;
  const usec = Number(process.env.WATCHDOG_USEC ?? '0');
  // DWA-OPS-007: a file whose age a container health check reads.
  const healthPath = process.env.DWA_HEALTH_FILE;
  let healthFailed = false;
  const health = healthPath === undefined || healthPath === ''
    ? undefined
    : new HealthFile({
        touch: () => {
          try {
            writeFileSync(healthPath, `${new Date().toISOString()}\n`);
          } catch (e) {
            if (!healthFailed) log.log('warning', 'health_file_failed', { path: healthPath, error: String(e) });
            healthFailed = true;
          }
        },
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (h) => { clearInterval(h as NodeJS.Timeout); },
      });
  const sockets = Array.from(
    { length: CONNECTIONS },
    () => new SocketModeClient({ appToken, logger: slackLogger(log, 'socket-mode') }),
  );
  let ready = false;
  const wiring = wireSockets({
    sockets,
    app,
    dedupe: new Dedupe(),
    log,
    command: () => config.slack.command,
    onConnectedChange: (open) => {
      if (open > 0 && !ready) {
        ready = true;
        notify('READY=1');
      }
      // DWA-OPS-002: feed the watchdog only while a Slack connection is up.
      if (open > 0 && watchdog === undefined && usec > 0) {
        notify('WATCHDOG=1');
        watchdog = setInterval(() => { notify('WATCHDOG=1'); }, Math.max(1000, usec / 2000));
      } else if (open === 0 && watchdog !== undefined) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
      health?.onConnectedChange(open);
    },
  });
  for (const s of sockets) await s.start();
  log.log('info', 'started', { connections: CONNECTIONS, channels: config.channels.size, instance: config.limits.instance });

  const shutdown = (signal: string) => {
    log.log('info', 'stopping', { signal });
    if (watchdog !== undefined) clearInterval(watchdog);
    health?.stop();
    // Stop taking commands, then give running ones up to 20 s to finish.
    void wiring
      .stop()
      .then(() => app.drain(20_000))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}

async function main(argv: string[]): Promise<void> {
  const [sub = 'run', ...rest] = argv;
  if (sub === 'run') return run();
  if (sub === 'check-config') process.exit(await checkConfig(rest));
  process.stderr.write('usage: deploy-window [run | check-config [--dry-run]]\n');
  process.exit(64);
}

await main(process.argv.slice(2));
