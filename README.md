# Deploy Window

A slash command for Slack that opens a maintenance window in Grafana. A user in a mapped channel
types

```
/deploy start 30m PROD -- release 2.4
```

and Deploy Window silences the Grafana alerts of the targets that the channel maps, announces the
window in the channel, and records it. `/deploy end` expires the silences early; otherwise they end
by themselves. Version 0.1.0.

There is no AI, no free-text interpretation and no database: a fixed command grammar, one YAML
configuration file, and Grafana silences as the only state.

Deploy Window is a small, independent project. It is not made by, affiliated with or endorsed by
Slack or Grafana Labs. It was built for one setup and is published as a reference implementation;
there is no support promise, and issues or pull requests may go unanswered.

**Specification (source of truth):** [`docs/spec.md`](docs/spec.md), requirement ids `DWA-*`. Each
test file names the requirement ids it covers. Operations: [`docs/operations.md`](docs/operations.md).
Licence: Apache-2.0 ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)). Security reports:
[`SECURITY.md`](SECURITY.md).

## How it works

- **Channels map to targets.** The configuration maps a Slack channel id to targets (`api`, `web`,
  …) and environments (`INTEG`, `PROD`, …). Each target has, per environment, a list of Grafana
  matcher sets. Users never type a host name, a label or a matcher; they pick configured targets.
- **One silence per matcher set.** `start` creates one Grafana silence per entry, with a marker
  line at the start of the comment: `dwa:v1 w=<window> ch=<channel> env=<ENV> t=<target> …`. The
  marker is how Deploy Window finds its own silences again; it never touches any other silence.
- **Announce first.** The announcement is posted before any silence is created. If it cannot be
  posted (for example, the app is not in the channel), nothing changes in Grafana. The announcement
  is then updated with the result of every silence.
- **No database.** The active windows are derived from the marked silences each time. A restart
  loses no window. Durable record: the announcement in Slack, the marker in each silence, and one
  JSON audit line per command on stdout.
- **Socket Mode.** The app opens outbound WebSocket connections to Slack and listens on no port.

## Commands

| Command | Effect |
|---|---|
| `/deploy start 30m` | Window over all targets of the channel, default environment |
| `/deploy start 1h30m PROD api,web -- release 2.4` | Window for two targets in `PROD`, with a note |
| `/deploy end` | Ends the active window of the channel (asks which one if several match) |
| `/deploy end PROD api -- done` | Ends only `api` in `PROD` |
| `/deploy list` | Active windows of the channel (only for allowed users) |
| `/deploy help` | Help text (for everyone in a mapped channel) |

Durations are `30m`, `2h` or `1h30m`. Targets are separated by spaces or commas. Everything after
`--` (or an em or en dash, which phone keyboards produce) is a note for people and is never parsed.
The full grammar with 48 cases is in the specification, section 5 and section 12.

The command name is configurable (`slack.command`). Another app in the workspace may already use
`/deploy`; pick a different name in the configuration and the manifest if it does.

## Quick start

Requirements: Node 22 or later, pnpm, a Grafana with Grafana-managed alerting (the API calls follow
the behaviour verified on Grafana 13, see the specification, section 14), and a Slack workspace where
you can create an app. Version 0.1.0 has passed its unit tests but has not yet run against a live
workspace and Grafana (see "Test status").

```sh
pnpm install --frozen-lockfile
pnpm build
cp config.example.yaml /etc/deploy-window/config.yaml    # then edit
DWA_CONFIG=/etc/deploy-window/config.yaml pnpm start check-config
```

1. Create the Slack app from [`manifest.example.yaml`](manifest.example.yaml), install it, create an
   app-level token with `connections:write`, and invite the app to each mapped channel.
2. Create a Grafana service account with `alert.instances:read`, `alert.instances:create` and
   `alert.instances:write`, and a token with an expiry.
3. Put the three tokens into the environment (see [`deploy/env.example`](deploy/env.example)) and
   run `pnpm start` (or install [`deploy/deploy-window.service.example`](deploy/deploy-window.service.example)).

The full steps, token rotation, upgrades and the manual fallback are in
[`docs/operations.md`](docs/operations.md).

## Configuration

Two complete examples:

- [`config.example.yaml`](config.example.yaml): a paid-plan workspace with Slack user groups.
- [`config.free-plan.example.yaml`](config.free-plan.example.yaml): a Free-plan workspace (no user
  groups there, so the allow list names users), a different command name and a remote Grafana.

The file holds no secret: it names environment variables (`*_env`), and a token-shaped value in the
file is rejected. The whole file is validated at start; every error is printed with its path and the
process exits with status 2. `SIGHUP` reloads the file and keeps the old configuration if the new one
is invalid. The schema and every validation rule are in the specification, section 4.

## Safety model, in short

- Only configured users or user-group members run `start`, `end` and `list`; a failed group lookup
  denies access.
- Matchers come only from the configuration; every entry needs at least one equality matcher, and a
  regex needs `allow_regex: true` and may not match everything.
- Durations are capped (globally, per channel, per environment). A forgotten `end` is bounded by the
  cap; nothing extends a window.
- One window per target and environment; a conflict refuses the whole `start` before any change.
- Partial failure rolls back by default (`on_partial: rollback`) and is shown per silence.
- The note is cleaned of control and bidi characters and escaped, so it cannot mention `@channel` or
  inject markup or template syntax.
- Optional: an HMAC-signed marker (`marker_key_env`), an audit file (`audit_file`), and a
  `max_matched` cap that refuses entries whose matchers match more alerts than expected.

The threat model and the accepted limitations are in [`SECURITY.md`](SECURITY.md).

## Development

```sh
pnpm test            # node:test with fake Slack and fake Grafana clients
pnpm typecheck
pnpm lint
pnpm lint:tokens     # token shapes; set DWA_DENY_LIST to also scan for a private word list
pnpm check:licenses  # production dependency licences
```

### Test status

The unit tests cover the requirements of the specification with a fake Slack and a fake Grafana.
These checks of the specification's test plan are **not** automated here:

- the live tests L-GRA-1, L-GRA-2, L-CFG-1 and L-E2E-1 (they need a throwaway Slack workspace and a
  test Grafana; L-CFG-1, a non-zero alert count through the alerts endpoint, is still open);
- T-DEP-1 as a `systemd-analyze security` score, T-DEP-2 (egress only), T-OPS-1 and T-OPS-2 (self-check
  and watchdog on a running service) and T-OPS-5 (the example alert rule evaluated on a Grafana);
- the adapter to the real Slack Web API (`WebSlackOut`) is exercised only through its interface.

## Licence

Copyright 2026 Max Albrecht. Licensed under the Apache License, Version 2.0. See `LICENSE` and
`NOTICE`. Slack is a trademark of Slack Technologies, LLC; Grafana is a trademark of Grafana Labs.
