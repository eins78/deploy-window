# Changelog

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
