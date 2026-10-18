# Operations

How to install, run and maintain Deploy Window. The requirements are in `docs/spec.md`; the ids
in brackets point there.

## Install

1. Create the Slack app from `manifest.example.yaml` (change the command if `/deploy` is taken by
   another app in the workspace). Install it to the workspace. Create an app-level token with the
   scope `connections:write`. Add `usergroups:read` to the bot scopes only if the configuration uses
   `allow_usergroups`.
2. Invite the app to every mapped channel (`/invite @Deploy Window`).
3. Create a Grafana service account with the actions `alert.instances:read`,
   `alert.instances:create` and `alert.instances:write` (on Grafana OSS the fixed roles for alert
   instances), and a token with an expiry date (DWA-GRA-003).
4. Write `/etc/deploy-window/config.yaml` from `config.example.yaml` or
   `config.free-plan.example.yaml`, and `/etc/deploy-window/env` from `deploy/env.example` (mode
   `0600`). Check it: `DWA_CONFIG=/etc/deploy-window/config.yaml node dist/main.js check-config`.
   With `max_matched` set, also run `check-config --dry-run` (it needs `DWA_GRAFANA_TOKEN`) to see
   how many alerts each entry matches now.
5. Build the app (`pnpm install --frozen-lockfile && pnpm build`), copy it to `/opt/deploy-window`,
   install `deploy/deploy-window.service.example` as `/etc/systemd/system/deploy-window.service`, and
   start it. Run one instance per Slack app and Grafana (DWA-DEP-005).
6. Add the guard alert from `deploy/alert-rule.example.yaml` (DWA-OPS-005).

The service needs outbound HTTPS and WSS to `*.slack.com` and to the Grafana URL. It listens on no
port. At start it logs `self_check_slack` and `self_check_grafana`; a failed Slack check ends the
process and systemd restarts it.

## Token rotation

Rotate a token when it expires, when staff change, or when it may have leaked (DWA-OPS-004).

- **Grafana service-account token:** create a new token for the same service account, write it to
  `/etc/deploy-window/env`, restart the service (`systemctl restart deploy-window`), check the log
  for `self_check_grafana` with `"ok":true`, then delete the old token in Grafana.
- **Slack bot token:** reinstall the app or use "Revoke tokens" on the app's OAuth page, which
  issues a new bot token; write it to the env file and restart.
- **Slack app-level token:** generate a new app-level token (`connections:write`), write it to the
  env file, restart, check for `slack_connected`, then revoke the old token. A leaked app-level
  token lets someone receive a share of the commands, so revoke it at once.
- **Marker key (`marker_key_env`):** a new key makes the silences of running windows look foreign
  (they show as "foreign marker" in `list` and DWA will not end them). Rotate the key when no window
  is active, or end the old windows by hand in Grafana (see below).

Running windows are not affected by a token rotation: they live in Grafana as silences.

## Upgrade

1. Read the changelog of the new release.
2. `systemctl stop deploy-window`.
3. Replace `/opt/deploy-window` with the new build (`pnpm install --frozen-lockfile && pnpm build`).
4. `DWA_CONFIG=/etc/deploy-window/config.yaml node dist/main.js check-config`.
5. `systemctl start deploy-window` and check the log for `started` and the two self-checks.

A running window is unaffected: its silences stay in Grafana and end at their end time. After the
start, the log has one `active_at_start` line per active window silence (DWA-ST-007). In-memory
state is lost: reminders of running windows are not posted, and the rate limit restarts.

A configuration change does not need a restart: `systemctl reload deploy-window` sends `SIGHUP`. A
file with errors is refused and the old configuration stays (log line `config_reload_failed`). A
change of the token variable names or the slash command needs a restart.

## Manual fallback

When the app is down, or a window must end and the app cannot do it:

1. Open Grafana, **Alerting → Silences**.
2. Search the silences for the marker prefix (the configured `limits.instance`, default `dwa:v1`).
   The comment of each DWA silence starts with
   `dwa:v1 w=<window id> ch=<channel id> env=<ENV> t=<target> …`.
3. Expire the silences of the window (same `w=` value). Expiring them ends the window; the next
   `list` no longer shows it.
4. Post a note in the channel, because the announcement is not updated.

To open a window without the app, create a silence by hand with the same matchers as the target's
entries in the configuration. Do not copy the DWA marker into a hand-made silence: DWA would then
treat it as its own.

## Logs

One JSON object per line on stdout (journald), with `time`, `level` and `event` (DWA-OPS-003).
Audit lines carry `"audit": true`. Tokens and token-shaped strings are replaced by `REDACTED`.

```sh
journalctl -u deploy-window -o cat | jq -c 'select(.audit)'
```
