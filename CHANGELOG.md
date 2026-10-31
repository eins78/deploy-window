# Changelog

## 0.1.1

### Patch Changes

- be23b88: The container image now runs on Node.js 26 LTS (`NODE_VERSION=26`, was 22), and CI also tests Node 26. The supported range is unchanged: `engines.node` stays `>=22`.

## 0.1.0

### Minor Changes

- 6340089: First release: `start`, `end`, `list` and `help`; Grafana silences with a marker; configuration
  validation; Socket Mode with two connections; audit lines; `check-config --dry-run`; a container
  image with a health check (`DWA_HEALTH_FILE`).
