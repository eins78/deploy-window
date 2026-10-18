// DWA-CFG-004: reload on SIGHUP. A file that fails validation keeps the old configuration.
import { type Config, ConfigInvalid, loadConfigFile, secretEnvNames } from './config.js';
import type { Logger } from './log.js';

export function reloadConfig(path: string, current: Config, log: Logger, load = loadConfigFile): Config {
  try {
    const next = load(path);
    if (secretEnvNames(next).join() !== secretEnvNames(current).join() || next.slack.command !== current.slack.command) {
      log.log('warning', 'config_reload_needs_restart', { reason: 'token variables or command changed' });
    }
    log.log('info', 'config_reloaded', { channels: next.channels.size });
    return next;
  } catch (e) {
    const errors = e instanceof ConfigInvalid ? e.errors : [{ path: '(file)', message: (e as Error).message }];
    log.log('error', 'config_reload_failed', { errors });
    return current;
  }
}
