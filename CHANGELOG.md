# Changelog

## 0.3.0

### Minor Changes

- 512893f: **Breaking (configuration):** the keys of `env_max_duration` must be lowercase, for example `env_max_duration: {prod: 1h}`. A key with an uppercase letter is refused, with the message `env_max_duration keys are lowercase: write "prod"`: at start DWA exits with status 2, and on `SIGHUP` it keeps the old configuration. A lowercase key still caps the environment of any spelling (`prod` caps `PROD`), and commands still ignore case. Before, two keys that differed only in case (`{PROD: 1h, prod: 3h}`) both named one environment and the later key won. Upgrade: lowercase the keys first. Version 0.2.0 already reads lowercase keys, so the edited file works before and after the upgrade (DWA-CFG-006, DWA-LIM-001).

### Patch Changes

- 72f54f1: An environment named like a property that every JavaScript object has (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, …) and without its own `env_max_duration` had no duration cap at all: the cap was `NaN`, so `start 99h999m` was accepted under any global or channel cap. It now gets the lowest of the global and channel caps, as DWA-CMD-006 says.
- aeb2f9a: A window of 100 hours or more (possible only with a cap of `99h60m` or more) was written as `100h` in the audit line, which the duration syntax cannot read. It is now written as `99h60m`, the form the syntax has (DWA-AUD-001). Shorter durations are written as before.

## 0.2.0

### Minor Changes

- 29cf97b: Optional mention commands: with `slack.mentions: true` the app also accepts `@Deploy Window start 30m PROD -- note` in a mapped channel, for callers that cannot send a slash command (scripts, AI agents posting as a Slack user). Same grammar and allowlist as the slash command. Replies and errors go to the thread of the mention, the final result of `start` and `end` also goes to the channel, `list` stays ephemeral, and audit lines carry `via: mention`. The feature is off by default; turning it on needs the bot scope `app_mentions:read`, the `app_mention` event subscription and a reinstall of the Slack app (the bot token may change). See spec section 10.1 and `docs/operations.md`.

### Patch Changes

- be23b88: The container image now runs on Node.js 26 LTS (`NODE_VERSION=26`, was 22), and CI also tests Node 26. The supported range is unchanged: `engines.node` stays `>=22`.

## 0.1.0

### Minor Changes

- 6340089: First release: `start`, `end`, `list` and `help`; Grafana silences with a marker; configuration
  validation; Socket Mode with two connections; audit lines; `check-config --dry-run`; a container
  image with a health check (`DWA_HEALTH_FILE`).
