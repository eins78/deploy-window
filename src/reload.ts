// DWA-CFG-004: reload on SIGHUP. A file that fails validation keeps the old configuration.
// Keys that are bound at start (tokens, command, Grafana client, marker, audit file, instance)
// cannot change on reload; a file that changes them is refused and needs a restart.
import { type Config, ConfigInvalid, loadConfigFile, secretEnvNames } from './config.js';
import type { Logger } from './log.js';

export function restartOnlyChanges(current: Config, next: Config): string[] {
  const changed: string[] = [];
  if (secretEnvNames(next).join() !== secretEnvNames(current).join()) changed.push('token or key variables');
  if (next.slack.command !== current.slack.command) changed.push('slack.command');
  if (next.grafana.url !== current.grafana.url) changed.push('grafana.url');
  if (next.grafana.alertmanager !== current.grafana.alertmanager) changed.push('grafana.alertmanager');
  if (next.auditFile !== current.auditFile) changed.push('audit_file');
  // A new instance would make every running window invisible to list, end and conflict checks.
  if (next.limits.instance !== current.limits.instance) changed.push('limits.instance');
  return changed;
}

export function reloadConfig(path: string, current: Config, log: Logger, load = loadConfigFile): Config {
  let next: Config;
  try {
    next = load(path);
  } catch (e) {
    const errors = e instanceof ConfigInvalid ? e.errors : [{ path: '(file)', message: (e as Error).message }];
    log.log('error', 'config_reload_failed', { errors });
    return current;
  }
  const changed = restartOnlyChanges(current, next);
  if (changed.length > 0) {
    log.log('error', 'config_reload_needs_restart', { changed, kept: 'old configuration' });
    return current;
  }
  log.log('info', 'config_reloaded', { channels: next.channels.size });
  return next;
}
