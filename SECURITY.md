# Security

## Reporting

Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a
vulnerability"). Do not open a public issue for a vulnerability. There is no bounty. Reports get a
best-effort response with no service-level promise; this project is maintained by one person.

Never put a token, a real Slack channel or user id, a Grafana URL or a silence comment from a real
deployment into a report, a screenshot or a log excerpt. Use the placeholders from
`config.example.yaml` instead.

## Scope

- The app in `src/`, run as described in `README.md` and `deploy/`.
- The example files: `config.example.yaml`, `config.free-plan.example.yaml`, `manifest.example.yaml`,
  `deploy/deploy-window.service.example` and `deploy/alert-rule.example.yaml`.

Out of scope: Slack, Grafana and the host the app runs on.

## What the design relies on

- **Fixed grammar, no free-text interpretation.** The command text is parsed by a fixed grammar
  (`docs/spec.md`, section 5). No user input becomes a matcher, a regular expression or a Grafana
  call other than the comment text (DWA-CMD-009). Matchers come only from the configuration file.
- **Allow lists per channel.** Only configured users or user groups run `start`, `end` and `list`.
  A failed group lookup denies access (fail closed).
- **The marker.** The app only touches silences whose comment starts with its own marker
  (`<instance>:v1`). It never modifies or expires any other silence. An optional HMAC key signs the
  marker (`marker_key_env`).
- **Secrets stay in the environment.** Tokens are read from environment variables named in the
  configuration; the configuration file itself is rejected if it holds a token-shaped value. Logged
  text has the token values and token-shaped strings redacted.
- **Output escaping.** The free-text message is cleaned of control and format characters and
  escaped before it reaches Slack (no `@channel`, no mentions, no link markup) and before it reaches
  the silence comment (no template syntax).
- **Bounded windows.** Every silence ends by itself at its end time; the configured maximum duration
  bounds a forgotten `end`.

## Known limitations

These are accepted in the design (see `docs/spec.md`) and listed so nobody reports them twice.

- The Grafana token needs `alert.instances:read`, `alert.instances:create` and
  `alert.instances:write`. These actions are organization-wide: a leaked token can silence every
  alert of the Grafana organization. Give the token an expiry and rotate it (`docs/operations.md`).
- A leaked Slack app-level token lets someone open a rogue Socket Mode connection and receive a
  share of the commands. Slack offers no list of open connections. Rotate the token when staff
  change.
- Two instances against one Slack app and one Grafana are unsupported. Conflicting windows are
  resolved after the fact (DWA-LIM-005), not prevented.
- Deduplication of redelivered commands and the rate limit live in memory and reset on restart.
- The app cannot tell whether a mapped channel is shared with another organization. Do not map a
  shared channel.
