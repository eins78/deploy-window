# Deploy Window — specification

**Version:** 1 (specification for release 0.1). **Repository:** `eins78/deploy-window`. This document is the source of truth for the behaviour of the app.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY have the meaning given in RFC 2119. Requirement ids have the form `DWA-<AREA>-<nnn>`. Every requirement has a test in section 13.

## 1. Purpose and scope

The deploy-window app (DWA) is a Slack slash-command app. A user in a mapped Slack channel types `/deploy start 30m PROD -- release 2.4`. DWA then mutes the alerts of the targets that the channel maps (Grafana silences), announces the window in the channel, and records the window. `/deploy end` expires the silences.

DWA has no AI, no LLM, no interpretation of free text and no database. It has a fixed command grammar, one configuration file and one Grafana client.

**Out of scope:** any mute mechanism other than Grafana silences, call from CI or deploy scripts, window extension, recurring windows, modal forms, Slack Marketplace distribution.

**Normative and informative parts.** Sections 1 to 13 are normative. Section 14 (verified platform facts) is informative.

**Genericity.** The code and the normative text MUST NOT contain the name of any organization, host, channel or customer. All such data lives in the configuration file. A second organization MUST be able to run DWA with its own Slack workspace, channels, environments and Grafana by configuration only (DWA-GEN-001). Examples use the placeholders `org-a`, `org-b`, `example-integ` and `#deploys-example`.

## 2. Terms

| Term | Meaning |
|---|---|
| Target | A named thing that a channel can put into a window, for example `api`. A target has one mute definition per environment. |
| Environment | A label such as `INTEG` or `PROD`. A channel lists its environments. The environment selects which mute definition of a target applies. |
| Mute definition | A list of silence entries. Each entry is a set of Grafana matchers. |
| Window | One successful `start`. It has an id, a channel, an environment, a set of targets, an end time, a user and an optional message. |
| Silence | One Grafana silence created for one entry of one target in a window. |
| Marker | The text prefix `<instance>:v1` (default `dwa:v1`) at the start of a silence comment. DWA finds its own silences by the marker. |
| Message | The optional free text after `--`. It is for humans only. |

## 3. General requirements

- **DWA-GEN-001** MUST: The code contains no organization-specific value. All organization data comes from the configuration file and the environment.
- **DWA-GEN-002** MUST: DWA does not call an LLM, and does not interpret any user text other than through the grammar in section 5.
- **DWA-GEN-003** MUST: DWA does not require a database. State follows section 8.
- **DWA-GEN-004** MUST: DWA processes the commands of one channel one at a time (a lock per channel; `start`, `end` and `list` of one channel serialize, commands of other channels run in parallel). Slow Grafana calls never block the event loop. `limits.max_concurrent_windows` is checked with the result of the command's own `find`, so simultaneous starts in different channels can exceed it by the number of such starts. Two instances MUST NOT run against the same Slack app and Grafana (DWA-DEP-005). The lock does not span processes, so DWA-LIM-005 re-checks after creation.
- **DWA-GEN-006** MUST: DWA keeps no persistent state. The only memory is the group cache (DWA-AUTH-002), the dedupe set (DWA-SLK-002) and the rate-limit counters (DWA-LIM-004). A restart resets them; the dedupe and the rate limit are therefore best-effort.
- **DWA-GEN-007** MUST: Keywords (`start`, `end`, `list`, `help`), error codes and the duration syntax are fixed in version 1. Durations in the configuration use the same syntax as commands (`30m`, `4h`, `1h30m`).

## 4. Configuration

### 4.1 Rules

- **DWA-CFG-001** MUST: The configuration is one YAML file. Its path comes from the environment variable `DWA_CONFIG`. The default is `/etc/deploy-window/config.yaml`.
- **DWA-CFG-002** MUST: The file contains no secret. Secrets are named by environment variable (`token_env`) and read from the environment at start (DWA-DEP-003).
- **DWA-CFG-003** MUST: DWA validates the whole file at start. On any error it prints every error with its path and exits with status 2 before it connects to Slack. An unknown key is an error, so a misspelt key is not silently ignored.
- **DWA-CFG-004** SHOULD: DWA reloads the file on `SIGHUP`. If the new file fails validation, DWA keeps the old configuration and logs the errors. A reload that changes a key bound at start (the `*_env` names, `slack.command`, `grafana.url`, `grafana.alertmanager`, `audit_file`, `limits.instance`) is refused as a whole and needs a restart. A running command finishes with the configuration it started with.
- **DWA-CFG-005** MUST: A channel is keyed by its Slack channel id (`C…`), never by its name. The optional `label` field is for humans.
- **DWA-CFG-006** MUST: Validation rejects: an environment name outside `[A-Za-z][A-Za-z0-9_.-]{0,31}` (so no `:`, comma or space; all-digit names fail), or equal to `start`, `end`, `list` or `help`, or matching the duration pattern; a target name outside `[a-z0-9][a-z0-9_.-]{0,62}`, all digits, or matching the duration pattern (such a target could never be selected); a target name that equals an environment name, or two names that differ only in case, in the same channel; a channel with no target; a target with no mute definition for a listed environment, or a definition for an unlisted environment (case-insensitive match against `environments`); a `default_environment` that is not in `environments`; an unknown `version`; a Grafana `url` that ends with a slash; an entry with an empty `matchers` list; a `max_duration` below `min_duration`; an `env_max_duration` key that is not an environment of the channel.
- **DWA-CFG-007** MUST: Matchers come only from the configuration file. No user input becomes a matcher (DWA-CMD-009).
- **DWA-CFG-008** MUST: Every entry has at least one equality matcher (`is_regex: false`) with a non-empty value. Validation rejects an entry that lacks it, an empty or white-space matcher value, a regex matcher without `allow_regex: true` on the entry, and a regex that matches the empty string or `.*`.
- **DWA-CFG-013** MUST: Validation computes the marker overhead from the configuration (length of `limits.instance`, the longest target name and environment name, and 69 more characters when `marker_key_env` is set) and rejects a `max_message_length` that is larger than 500 minus this overhead. `limits.instance` matches `[a-z0-9]{1,16}`. With the defaults (no signing, target names up to 63 and environment names up to 32 characters) the overhead is at most 191 characters, so the default message length of 300 fits.
- **DWA-CFG-009** SHOULD: DWA offers `check-config --dry-run`. For each entry it prints how many alerts currently match the matchers (through the alerts endpoint of the Grafana Alertmanager API). An entry whose count exceeds `limits.max_matched` (if set) is refused. When `max_matched` is set, DWA also runs this count before each `start` and refuses the `start` with failure class `limit` if an entry exceeds it, so a regex that became broader after a label change does not mute more than intended. Both depend on the alerts endpoint (F12, test L-CFG-1).
- **DWA-CFG-010** MUST: `limits.instance` (default `dwa`) is the marker prefix (section 8.1). Two DWA deployments that share one Grafana MUST use different values. Every `find` filters on it.
- **DWA-CFG-011** MUST: `on_partial` is optional and defaults to `rollback` (DWA-FAIL-002). Any other value is invalid.
- **DWA-CFG-012** MUST: A channel `auth` block replaces the global block as a whole: a list that the channel block omits is empty, not inherited. A channel with no effective allowed user or group, including an empty `auth` block, is invalid (DWA-AUTH-006). `is_regex` defaults to `false`.

### 4.2 Schema

```yaml
version: 1
slack:
  command: /deploy                # the slash command registered in the Slack app
  bot_token_env: DWA_SLACK_BOT_TOKEN      # xoxb-…
  app_token_env: DWA_SLACK_APP_TOKEN      # xapp-… (Socket Mode)
grafana:
  url: http://127.0.0.1:3000      # base URL; no trailing slash (DWA-CFG-006)
  token_env: DWA_GRAFANA_TOKEN    # service-account token
  alertmanager: grafana           # the alertmanager name in the URL path
limits:
  min_duration: 5m
  max_duration: 4h                # global cap; a channel or environment may lower it
  max_message_length: 300
  instance: dwa                   # marker prefix; unique per deployment (DWA-CFG-010)
  max_silences_per_window: 20     # DWA-LIM-006
  max_concurrent_windows: 10      # active windows over all channels, DWA-LIM-007
  max_matched: 50                 # optional; used by check-config --dry-run
marker_key_env: DWA_MARKER_KEY    # optional; enables signed markers (DWA-ST-006)
audit_file: /var/log/deploy-window/audit.jsonl  # optional; DWA-AUD-005
auth:
  allow_users: []                 # Slack user ids, global
  allow_usergroups: []            # Slack user group ids (S…), global
channels:
  C0EXAMPLE01:
    label: "#deploys-example"
    environments: [INTEG, PROD]
    default_environment: INTEG    # optional; see DWA-ENV-002
    select: all                   # all | explicit; see DWA-CHN-004
    on_partial: rollback          # rollback (default) | keep (DWA-FAIL-002)
    max_duration: 2h              # optional channel cap
    env_max_duration: {PROD: 1h}  # optional per-environment caps
    auth:                         # optional; replaces the global block as a whole
      allow_users: [U0EXAMPLE01]
      allow_usergroups: [S0EXAMPLE01]
    targets:
      api:
        INTEG:
          - matchers: [{name: target_id, value: example-integ-api}]
        PROD:
          - matchers: [{name: target_id, value: example-prod-api}]
          - matchers: [{name: target_id, value: example-prod-api-worker}]
```

An entry has `matchers`, a list of `{name, value, is_regex}` (all ANDed, as in Grafana), and optional `allow_regex`. Each entry becomes one silence per `start`.

### 4.3 Example for two organizations

Org A has one channel, two environments, two targets. Org B has a different Slack workspace, command name and Grafana, and a channel with one environment.

```yaml
# org-a/config.yaml
version: 1
slack: {command: /deploy, bot_token_env: DWA_SLACK_BOT_TOKEN, app_token_env: DWA_SLACK_APP_TOKEN}
grafana: {url: "http://127.0.0.1:3000", token_env: DWA_GRAFANA_TOKEN, alertmanager: grafana}
limits: {min_duration: 5m, max_duration: 4h, max_message_length: 300}
auth: {allow_usergroups: [S0ORGAOPS1]}
channels:
  C0ORGA0001:
    label: "#deploys-example"
    environments: [INTEG, PROD]
    default_environment: INTEG
    select: all
    on_partial: keep
    targets:
      api:
        INTEG: [{matchers: [{name: target_id, value: example-integ-api}]}]
        PROD:  [{matchers: [{name: target_id, value: example-prod-api}]}]
      web:
        INTEG: [{matchers: [{name: target_id, value: example-integ-web}]}]
        PROD:  [{matchers: [{name: target_id, value: example-prod-web}]}]
```

```yaml
# org-b/config.yaml
version: 1
slack: {command: /window, bot_token_env: B_BOT, app_token_env: B_APP}
grafana: {url: "https://grafana.org-b.example", token_env: B_GRAFANA, alertmanager: grafana}
limits: {min_duration: 10m, max_duration: 2h, max_message_length: 200}
auth: {allow_users: [U0ORGB0001, U0ORGB0002]}
channels:
  C0ORGB0001:
    label: "#releases-example"
    environments: [PROD]          # one environment: the word is optional
    select: explicit              # the user must name at least one target
    on_partial: rollback
    targets:
      shop: {PROD: [{matchers: [{name: service, value: shop}, {name: stage, value: prod}]}]}
      mail: {PROD: [{matchers: [{name: service, value: mail}]}]}
```

## 5. Commands

### 5.1 Grammar

Slack delivers the text after the command name in the field `text`. The grammar applies to that text. Keywords, environment names and target names are case-insensitive; DWA matches them with the canonical spelling from the configuration.

```
text        = [ head ] [ SEP message ]                 ; SEP: see DWA-CMD-004
head        = start / end / list / help / ""
start       = "start" *( SP item )                     ; semantic rules require a duration
end         = "end"   *( SP item )
list        = "list"  *( SP item )                     ; items are rejected by DWA-CMD-002
help        = "help"  *( SP item )
item        = token *( "," token )                     ; an empty token is an error
token       = 1*( any character except white space and "," )
SEP         = ( "--" / %x2014 / %x2013 ) at a token boundary
duration    = [ 1*2DIGIT "h" ] [ 1*3DIGIT "m" ]        ; at least one part; DIGIT = %x30-39
message     = *( any character )                       ; verbatim, see DWA-MSG-*
```

The BNF only shows the shape. The rules DWA-CMD-001 to 007 decide how a token is classified and which error wins, and they override the BNF. `api.*` and fullwidth digits are tokens that fail classification, not syntax errors. A text that starts with a separator has an empty head and shows the help text with the message ignored.

**Which error wins.** DWA reports the first failing check in this order: `unknown_subcommand`, `empty_list_item`, `unexpected_argument` (`list` and `help` with items), item classification (`duration_needs_unit`, `unknown_env_or_target`, `unexpected_duration`, `duplicate_duration`, `duplicate_env`), `duration_missing`, `duration_too_short`, `duration_too_long`, `env_required`, `message_too_long`, then the checks of sections 6 and 9.

- **DWA-CMD-001** MUST: DWA classifies each token (after splitting on spaces and commas) in this order: all digits without a unit → `duration_needs_unit`; matches `duration` → duration; equals an environment of the channel → env; equals a target of the channel → target; otherwise → `unknown_env_or_target`. The order of the tokens before `--` does not matter.
- **DWA-CMD-002** MUST: A `start` has exactly one duration. Zero → `duration_missing`; two → `duplicate_duration`. `end` takes no duration (`unexpected_duration`). `list` and `help` take no item (`unexpected_argument`). A comma followed by a space (`api, web`) leaves an empty token (`empty_list_item`).
- **DWA-CMD-003** MUST: A command has at most one env (`duplicate_env`). A repeated target counts once.
- **DWA-CMD-004** MUST: The message starts after the first separator token. The separator token is `--` (two hyphen-minus characters), the em dash U+2014 or the en dash U+2013, with white space or the text boundary on both sides. Phone keyboards replace `--` with a dash character, so the dash forms are equal. Everything after the separator belongs to the message, including further `--`.
- **DWA-CMD-005** MUST: DIGIT in `duration` is ASCII `0`–`9`. Other Unicode digits are not digits.
- **DWA-CMD-006** MUST: The duration is validated against `min_duration` (`duration_too_short`) and against the lowest applicable cap: global, channel, and `env_max_duration` of the env (`duration_too_long`). The error text names the limit.
- **DWA-CMD-007** MUST: An empty text or `help` returns the help text as an ephemeral message. An unknown first word returns `unknown_subcommand` plus the help text.
- **DWA-CMD-008** MUST: Every error is an ephemeral reply to the user. An error never changes Grafana and never posts to the channel. DWA sends ephemeral replies with `chat.postEphemeral` (channel id and user id from the envelope), and uses `response_url` as the fallback. Errors that need no Grafana call MAY go in the body of the acknowledgement.
- **DWA-CMD-009** MUST: Neither the message nor any other part of the text becomes a matcher, a regular expression or a part of a Grafana call other than the comment text (DWA-MSG-005).
- **DWA-CMD-010** MUST: The Slack app setting "Escape channels, users, and links sent to your app" stays off, so that `text` arrives as typed. DWA still treats the message as untrusted input (DWA-MSG-002).
- **DWA-CMD-011** MUST: DWA acknowledges the Slack envelope within 3 seconds, before any Grafana call, and sends the result afterwards (DWA-SLK-002).

### 5.2 Meaning of the commands

**`start`**

1. Resolve the channel (DWA-CHN-001), the user (DWA-AUTH-*), the environment (DWA-ENV-*) and the target set (DWA-CHN-003/004).
2. Check the limits (DWA-LIM-*) and conflicts (DWA-LIM-003).
3. Post the announcement with status "starting" and keep its timestamp `ts` (DWA-SLK-004). If the post fails, stop with no Grafana change.
4. Create the silences, with the marker and `ts` in each comment (section 8).
5. Update the announcement with the result per silence (DWA-ANN-*).

**`end`** resolves the channel and the target set as `start` does. It does not apply `default_environment` (DWA-END-001). It finds the active windows in the channel through the markers, expires the silences, and replies in the thread of the announcement. `end` accepts a message; it appears in the thread reply.

**`list`** shows the active windows of the channel as an ephemeral reply: window id, env, targets, end time, user, message.

## 6. Channels, targets, environments

- **DWA-CHN-001** MUST: A command from a channel that is not in the configuration gets the ephemeral reply "this channel is not set up for deploy windows" and nothing else. DWA does not post and does not call Grafana.
- **DWA-CHN-002** MUST: A window started in channel X mutes only targets of channel X. `end` and `list` in channel X see only windows of channel X (marker field `ch`).
- **DWA-CHN-003** MUST: A command may name a subset of the targets of the channel. A name that is not a target of the channel is an error (DWA-CMD-001). DWA never accepts a host name, id or matcher from the user.
- **DWA-CHN-004** MUST: If the command names no target, then with `select: all` (the default) DWA uses every target of the channel. With `select: explicit` DWA replies with the list of valid targets and does nothing (also for `end`).
- **DWA-ENV-001** MUST: The `environments` list of a channel defines the valid env words. Each target defines a mute definition for every listed environment (DWA-CFG-006).
- **DWA-ENV-002** MUST: When a `start` names no env: a channel with one environment uses it; a channel with `default_environment` uses it; any other channel gets `env_required` with the list of choices. The announcement shows the env that DWA used.
- **DWA-ENV-003** MUST: The env decides which mute definition of each target applies. Conflict detection (DWA-LIM-003) works on the name pair (channel, target, env) only. DWA does not detect two definitions that mute the same alerts through different names; the configuration owner avoids such overlaps.
- **DWA-END-001** MUST: For `end`, DWA collects the active windows of the channel that match the given env (if any) and the given targets (if any). If exactly one window matches, DWA ends it. If none matches, DWA replies "no active window". If more than one matches, DWA ends nothing and replies with the list (env, targets, user, end time), so that the user repeats `end` with an env or targets. `default_environment` and the single-environment shortcut apply to `start` only.
- **DWA-END-002** MUST: `end` on a subset of the targets of a window expires the silences of those targets only. The other targets stay muted until their end time or a later `end`.

## 7. Message

- **DWA-MSG-001** MUST: The message is optional. An empty message after the separator equals no message.
- **DWA-MSG-002** MUST: Before use, DWA replaces characters of the Unicode categories Cc, Cf, Zl and Zp (control, format, bidirectional override, zero-width, line and paragraph separators) with a space, trims the ends, and rejects a message longer than `max_message_length` Unicode code points with `message_too_long`. It does not truncate silently.
- **DWA-MSG-003** MUST: In every Slack output (announcement, thread reply, `list`, ephemeral reply) DWA replaces `&`, `<` and `>` in the message with `&amp;`, `&lt;` and `&gt;`. This stops mentions such as `<!channel>`, `<@U…>` and link markup. DWA sets `parse: none`, does not set `link_names`, and uses `verbatim: true` in the announcement block. Slack markup characters (`*`, `` ` ``, `~`) are not escaped; the message MAY show as formatted text.
- **DWA-MSG-004** MUST: The message is not parsed, split, looked up, or used as a command, matcher, env or target.
- **DWA-MSG-005** MUST: In the silence comment, DWA stores the message as plain text, with `{` and `}` replaced by `(` and `)` and every `$` removed, so that no template syntax in a later consumer of the comment expands.

## 8. Grafana client and state

### 8.1 Silences and marker

| Operation | Call |
|---|---|
| create | `POST {url}/api/alertmanager/{am}/api/v2/silences` with `{"matchers":[{"name","value","isRegex","isEqual":true}],"startsAt":<RFC 3339>,"endsAt":<RFC 3339>,"createdBy":"<slack user>","comment":"<marker line>"}`. The response is `{"silenceID":"…"}`. |
| find | `GET …/silences`; DWA keeps entries whose `comment` starts with `<instance>:v1 ` and whose `status.state` is `active` or `pending`. |
| end | `DELETE …/silence/{id}` (singular). It expires the silence. |

The comment of every silence has this form:

```
<instance>:v1 w=<window id> ch=<channel id> env=<ENV> t=<target> n=<entries> u=<slack user id> ts=<announcement ts> | <message>
```

`n` is the number of entries that the target has for this env, so `list` can tell a failed creation from a normal subset `end`.

- **DWA-GRA-001** MUST: `startsAt` is the window start minus 60 seconds. Grafana sets a start in the past to the time of the call (observed, F8), so the backdating costs nothing and stops a DWA clock that runs ahead of Grafana from leaving the silence "pending". A successful create answers HTTP 202 with `{"silenceID":"…"}`. `endsAt` is the window start plus the duration. `isEqual` is `true`. `isRegex` follows the configuration. One silence is created per entry of each selected target. To mute several hosts with one silence, an entry MAY use one regex matcher (`allow_regex: true`).
- **DWA-GRA-002** MUST: DWA sends `createdBy` with the Slack user's display name or id and does not rely on it. Grafana may replace it with the service account. The Slack user is always in the marker line.
- **DWA-GRA-003** MUST: The service account holds the actions `alert.instances:read`, `alert.instances:create` and `alert.instances:write`. It SHOULD hold no more, if the Grafana edition allows such a role. These actions are organization-wide: a leaked token can silence every alert of the organization. The token SHOULD have an expiry and a rotation date. The `alert.silences:*` actions are not enough for label matchers (they cover rule-scoped silences).
- **DWA-GRA-004** MUST: The marker plus the message stays under 500 characters; DWA-CFG-013 guarantees this by construction. `find` is a full list of the silences filtered on the marker prefix on the client side, because the endpoint has no comment filter; one `find` per command is reused for the conflict checks and for retries. Grafana limits the total size of a silence, and an administrator can limit the count of silences; both limits are reported as failure class `limit` (DWA-GRA-008).
- **DWA-GRA-005** MUST: `find` returns only silences with the marker prefix of this deployment. DWA never modifies or expires a silence without the marker (DWA-GRA-010).
- **DWA-GRA-006** MUST: `end` is idempotent. It maps these answers to ok: 404, and a silence that is already expired. Any other 4xx is a failure of that silence.
- **DWA-GRA-007** MUST: Each Grafana call has a timeout (default 10 s) and at most 2 retries with back-off for network errors and HTTP 5xx. A 4xx is not retried. `create` is retried only after a `find` by the window id shows that the silence does not exist, so a timeout after Grafana accepted the call does not create a duplicate.
- **DWA-GRA-008** MUST: A 4xx that reports a limit (silence count or size) is failure class `limit`, shown in the announcement. DWA does not retry it.
- **DWA-GRA-009** MUST: All times are UTC (`Z` suffix). The host runs NTP. `find` trusts `status.state`, not the local clock. In Slack, DWA renders times with the `<!date^unix^…|fallback>` token (fallback in UTC).
- **DWA-GRA-010** MUST NOT: DWA does not modify, extend or expire a silence that lacks the marker of this deployment.

### 8.2 State without a database

- **DWA-ST-001** MUST: The window id is 8 characters from `[a-z2-7]`, taken from a cryptographically secure random source, and checked against `find` before use.
- **DWA-ST-002** MUST: The set of active windows is derived only from the marked silences (`find`). The end time comes from the silence field `endsAt`, not from the comment. Between commands DWA keeps no record of windows (DWA-GEN-006), so a restart loses no window.
- **DWA-ST-003** MUST: A window is active when at least one of its silences is active. For each target of a window, `list` compares the number of live silences with `n`; fewer (but at least one) means the target is incomplete and `list` says so. A target with no live silence is absent from `list`, whether `end` removed it or all its creations failed; the announcement and the audit line hold the record of a total failure (DWA-FAIL-001). An `end` that runs between the creations of one `start` is serialized by the channel lock (DWA-GEN-004), so it never sees a half-created window.
- **DWA-ST-004** MUST: The fields `ts` and `ch` let `end` find the announcement thread without Slack search.
- **DWA-ST-005** SHOULD: A silence keeps the message in full, within DWA-GRA-004.
- **DWA-ST-006** MUST: DWA parses the marker strictly: it splits at the first ` | `; everything after it is the message and is never parsed. A comment that does not match the field format is foreign. If `marker_key_env` is set (the key is 32 bytes written as 64 hex characters; any other value stops DWA with status 2), DWA SHOULD add a field `sig=<hex>` (HMAC-SHA256 over the other fields) and treat a silence without a valid signature as foreign and show it in `list` as "foreign marker".
- **DWA-ST-007** MUST: The "starting" announcement says "if this message does not change within 1 minute, run `list` and check Grafana". A crash between the announcement and the creation of the silences leaves such a message; DWA cannot repair it without state, and the text tells the reader what to do. After a restart, DWA logs one audit line per active marked silence (window id, `ts`, end time).

**Why no database works.** A window is fully described by its silences: Grafana keeps them durably and lists them quickly. Cases that fail without a database: (a) Grafana is down at `list` or `end` time, so DWA cannot see the silences; (b) an operator edits the comment of a silence in the Grafana UI. DWA reports both cases in the reply instead of hiding them. A database would not solve (a) either, because the silence itself still needs Grafana to end it.

## 9. Authorization, limits, partial failure

### 9.1 Authorization

- **DWA-AUTH-001** MUST: Only the allowed users run `start` and `end`. A user is allowed if their Slack id is in `allow_users`, or they belong to a Slack user group in `allow_usergroups`, of the channel (when the channel has an `auth` block) or of the global block.
- **DWA-AUTH-002** MUST: DWA resolves groups with `usergroups.users.list` (the method returns all members in one response) and caches the result for at most 60 seconds. For `start` and `end` the cache lifetime is at most 10 seconds. A failed refresh never reuses an expired entry. If the lookup fails, DWA denies access (fail closed) unless the user is in the effective `allow_users` of that channel (the channel block when it exists, otherwise the global block; DWA-CFG-012).
- **DWA-AUTH-003** MUST: `help` is open to every member of a mapped channel. `list` requires an allowed user, because it shows users and messages.
- **DWA-AUTH-004** MUST: A denied user gets an ephemeral reply and the denial goes to the audit log (DWA-AUD-002). The reply does not reveal the configuration.
- **DWA-AUTH-005** MUST: Any allowed user in the channel MAY end any window of the channel, not only their own. The audit line records who.
- **DWA-AUTH-006** MUST: A configuration with neither `allow_users` nor `allow_usergroups` for a channel (after DWA-CFG-012) is invalid.
- **DWA-AUTH-008** MUST: Slack user groups need a paid plan, and on the Free plan the user-group API answers without an error (`usergroups.list` returns an empty list; `usergroups.users.list` returns `no_such_subteam` for an id that does not exist; F5). At start, for every id in `allow_usergroups`, DWA calls `usergroups.users.list`. If Slack answers `no_such_subteam` or `plan_upgrade_required`, DWA stops with status 2 and the message "user group <id> is not available in this workspace; use allow_users or fix the id". A workspace on the Free plan therefore configures `allow_users` only.
- **DWA-AUTH-007** MUST: DWA takes `channel_id` and `user_id` only from the Slack envelope, never from `text`. DWA refuses commands from direct messages and group direct messages (channel ids that start with `D`, and conversations that are not in the configuration). The slash-command payload does not say whether a channel is shared with another organization, and checking it would need an extra scope; DWA therefore does not check it. The operator MUST NOT map a channel that is shared with another organization, because members of the other organization could read `help` there; `start`, `end` and `list` stay limited to allowed users either way.

### 9.2 Limits

- **DWA-LIM-001** MUST: Minimum duration `min_duration` (default 5 minutes). Maximum duration: the lowest of global, channel and per-environment cap. The default global maximum is 4 hours.
- **DWA-LIM-002** MUST: DWA never ends a window by itself before its end time and never extends one; only an authorized `end` shortens a window. The silence ends by itself at `endsAt`, so a forgotten `end` is bounded by the cap.
- **DWA-LIM-003** MUST: There is at most one active window per target and environment. If any selected target-env pair already has an active window, `start` fails for all targets before any change. The reply names the existing window (id, user, end).
- **DWA-LIM-004** MUST: A rate limit of 10 `start` commands per user per hour (best-effort, DWA-GEN-006).
- **DWA-LIM-005** MUST: After creating the silences, `start` runs `find` again for each target-env pair. If another window (a different window id) is active for the same pair, the window with the lexically lower id stays and the other expires every silence that carries its window id (found by `find`, not only the ones with a known silence id, DWA-FAIL-002); the loser reports the conflict like DWA-LIM-003. This covers two instances and a retried envelope.
- **DWA-LIM-006** MUST: A `start` that would create more than `limits.max_silences_per_window` silences fails before any change.
- **DWA-LIM-007** MUST: A `start` fails before any change when `limits.max_concurrent_windows` active windows exist over all channels.
- **DWA-LIM-008** SHOULD: DWA posts a reminder in the announcement thread 5 minutes before the end time of a window. The reminder is a best-effort timer in the process; a restart loses it, like the dedupe set (DWA-GEN-006). DWA does not use Slack scheduled messages, because they cannot be cancelled when the window ends early.

### 9.3 Partial failure

- **DWA-FAIL-001** MUST: DWA never reports a success it did not observe. The announcement lists each silence as created (with id) or failed (with the reason class: auth, timeout, rejected, limit).
- **DWA-FAIL-002** MUST: The channel setting `on_partial` is `rollback` (the default) or `keep`. With `keep`, silences that were created stay, the window is marked "partial", and the reply tells the user which silences failed. With `rollback`, DWA runs `find` for the window id and expires every silence that carries it, including a silence whose create timed out after Grafana accepted it (DWA-GRA-007), and marks the window "failed"; if a rollback step fails, the window is marked "failed, silences still active" with their ids. If every silence fails, the window is "failed" under both settings. Partial muting has a cost either way: `keep` leaves some alerts firing during the deploy, `rollback` leaves all of them firing.
- **DWA-FAIL-003** MUST: `end` tries every silence even if one fails, and reports the silences that remain.
- **DWA-FAIL-004** MUST: If the announcement cannot be updated at the end of `start`, DWA posts the result as a new message in the same channel and logs the error.
- **DWA-FAIL-005** SHOULD: If Grafana is unreachable when DWA starts, DWA still runs; commands that need Grafana fail with a clear message.

## 10. Slack interaction, announcement, audit

- **DWA-SLK-001** MUST: DWA uses Socket Mode with an app-level token. It opens no inbound port.
- **DWA-SLK-002** MUST: DWA acknowledges each command immediately (`ack()`), then works. It dedupes redelivered commands by `envelope_id` and by `trigger_id` for 10 minutes, across all of its connections. The dedupe is best-effort (DWA-GEN-006); DWA-LIM-005 is the safeguard.
- **DWA-SLK-003** MUST: DWA reconnects on its own when the WebSocket closes or when Slack asks for a refresh (the `disconnect` message with reason `warning` or `refresh_requested`). DWA keeps two Socket Mode connections open, so that one connection stays open while the other reconnects.
- **DWA-SLK-004** MUST: The announcement is posted with `chat.postMessage` as the bot, and updated with `chat.update`. It is not sent through `response_url`, because that URL has limits (5 uses in 30 minutes).
- **DWA-SLK-005** MUST: Bot scopes: `commands`, `chat:write`, and `usergroups:read` only if a user group is configured. The app-level token has the scope `connections:write` only. The bot MUST be a member of every mapped channel. If the bot is not a member, `start` stops at the announcement step with no Grafana change, and `end` still expires the silences and tells the user by ephemeral reply.
- **DWA-SLK-006** MUST: If the work of a command takes longer than 30 seconds, DWA sends an ephemeral "still working" reply; if it fails, DWA sends an ephemeral failure notice. A command never ends silently after the ack.
- **DWA-ANN-001** MUST: The announcement shows: status (starting, active, partial, failed, partly ended, ended), env, targets, start and end time, the user as a mention, the window id, the message (escaped), and one line per silence with its id.
- **DWA-ANN-002** MUST: For each window that `end` ends, DWA replies in the thread of that window's announcement. The announcement status becomes "ended" when all silences of the window are expired, and "partly ended" when only some targets ended. If no announcement is found, DWA posts the reply as a new message.
- **DWA-ANN-003** MUST: Times in the announcement use the Slack date token (DWA-GRA-009).
- **DWA-AUD-001** MUST: Every start and end, successful or not, writes one JSON line to stdout (journald): time, event, window id, channel, env, targets, user, duration, message, silence ids and results. The message in the line passes DWA-MSG-002 and has strings shaped like tokens (`xox[a-z]-`, `xapp-`, `glsa_`) replaced by `REDACTED`.
- **DWA-AUD-002** MUST: A denied command, a limit refusal, a grammar error, a `list`, a `help` and a refusal from an unmapped channel also write an audit line (for an unmapped channel: time, channel id, user id, no text).
- **DWA-AUD-003** MUST: The announcement in Slack and the marker in each silence are the durable audit record. The journald line is the third copy.
- **DWA-AUD-004** SHOULD: The marker carries the Slack user even when Grafana replaces `createdBy` (DWA-GRA-002).
- **DWA-AUD-005** SHOULD: The audit lines also go to an append-only file or the central log pipeline of the operator, since the journal rotates.

## 11. Deployment, operation, secrets

- **DWA-DEP-001** MUST: DWA runs as one systemd service under a dedicated user (`DynamicUser=yes` is enough), with `Restart=always`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectProc=invisible`, `PrivateTmp=yes`, `PrivateUsers=yes` and `CapabilityBoundingSet=` (empty). It listens on no port. A container is an accepted alternative with the same restrictions: one container, a non-root user, no published port, no new privileges, all capabilities dropped and a read-only root file system with a writable `/tmp` only.
- **DWA-DEP-002** MUST: The host needs outbound HTTPS and WSS to `*.slack.com` (the Socket Mode host name varies) and to the Grafana URL. DWA verifies TLS certificates for every non-loopback URL; a setting that turns verification off is invalid, and a plain `http` Grafana URL is valid only for a loopback address.
- **DWA-DEP-003** MUST: Secrets (Slack bot token, Slack app token, Grafana token, optional marker key) are in an environment file with mode `0600` outside any repository, or in systemd credentials. The repository holds only `config.example.yaml` with placeholders.
- **DWA-DEP-004** MUST NOT: A secret appears in the configuration file, the log, the announcement or an error reply. DWA redacts the values of the configured `*_env` variables and the `Authorization` header from any logged text, including HTTP client debug output.
- **DWA-DEP-005** MUST: One instance runs per Slack app and Grafana. Slack may deliver a command to any open Socket Mode connection (up to 10 per app), so a second instance would handle an arbitrary share of the commands, and the channel lock does not cover it. Two instances are an unsupported but tolerated state: DWA-LIM-005 resolves conflicting windows after the fact and T-LIM-5 tests it; a cross-process lease would need shared state and is not part of version 1. A leaked app-level token allows a rogue connection; the operator rotates the token when staff change.
- **DWA-DEP-006** SHOULD: The host is one that runs when Grafana runs. If the host is down, no alerts arrive either, so a failed command is acceptable.
- **DWA-DEP-007** SHOULD: The reference implementation uses TypeScript (strict mode) on Node 22 or later, Slack's Socket Mode client and Web API client (`@slack/socket-mode` 2 and `@slack/web-api` 7, the transport and client inside `@slack/bolt` 4), Zod for the configuration, `js-yaml`, pnpm, and `node:test`. It does not use Bolt itself, because Bolt's command handler does not expose the Socket Mode `envelope_id` that DWA-SLK-002 deduplicates on. Slack output goes through a small interface (post, post ephemeral, update) so tests can inject a fake.
- **DWA-DEP-008** MUST: The Slack app is created from a manifest kept in the repository (`manifest.example.yaml`): slash command, `socket_mode_enabled: true`, `should_escape: false`, bot scopes as in DWA-SLK-005.
- **DWA-OPS-001** MUST: At start DWA runs a self-check and logs the result: Slack `auth.test`; a `GET …/silences` with the Grafana token (read access). DWA does not check bot membership at start, because that would need channel-read scopes; a missing membership shows at the first post as `not_in_channel` and follows DWA-SLK-005. A failed Slack check ends the process with status 1 (systemd retries); a failed Grafana check follows DWA-FAIL-005.
- **DWA-OPS-006** SHOULD: The repository keeps one example configuration per plan class: a paid-plan workspace (user groups allowed) and a Free-plan workspace (`allow_users` only, at most 10 installed apps in the workspace). A test workspace uses its own Slack app and its own configuration; it never shares tokens with the production app.
- **DWA-OPS-002** SHOULD: The unit sets `WatchdogSec` and DWA notifies systemd (`sd_notify`, through `systemd-notify` with `NotifyAccess=all`) while at least one Slack connection is up, so a stuck process restarts.
- **DWA-OPS-007** SHOULD: When `DWA_HEALTH_FILE` names a path, DWA writes that file at once and every 15 seconds while at least one Slack connection is up, and stops when none is (the same rule as DWA-OPS-002). A container health check reads the file's age; a file older than 60 seconds means unhealthy. A failed write is logged once as a warning and does not stop DWA.
- **DWA-OPS-003** MUST: Logs are one JSON object per line with `time`, `level`, `event`. Levels: `info` for commands, `warning` for refusals and retries, `error` for failed Grafana or Slack calls.
- **DWA-OPS-004** MUST: The repository documents: token rotation (Grafana service-account token, Slack tokens, marker key), the upgrade steps (stop, replace, start; a running window is unaffected because it lives in Grafana), and the manual fallback (expire a DWA silence in the Grafana UI by its marker).
- **DWA-OPS-005** SHOULD: The operator adds a Grafana alert on the number of active silences with the DWA marker above `max_concurrent_windows`, routed through a channel that DWA cannot mute.


## 12. Grammar cases

Channel fixtures: **A** has envs `INTEG`, `PROD`, default `INTEG`, targets `api`, `web`, cap 4 h. **B** has env `PROD`, target `app`, cap 2 h. **C** has envs `INTEG`, `PROD`, no default, target `api`.

| Id | Ch | Input | Expected |
|---|---|---|---|
| G01 | B | `start 30m` | start, PROD, [app], 30 min |
| G02 | A | `start 30m` | start, INTEG (default), [api, web], 30 min |
| G03 | A | `start 1h30m PROD -- release 2.4` | start, PROD, all, 90 min, message `release 2.4` |
| G04 | A | `start PROD 30m` | same as `start 30m PROD` (order free) |
| G05 | A | `start 30m integ api` | INTEG, [api] (case-insensitive) |
| G06 | A | `start 30m PROD api,web` | PROD, [api, web] |
| G07 | A | `start 30m PROD web api` | PROD, [web, api] (space-separated list) |
| G08 | A | `start 30m api,api` | [api] once |
| G09 | A | `START 2H` | 120 min |
| G10 | A | `start 30m -- a -- b` | message `a -- b` |
| G11 | A | `start 30m — phone dash` | message `phone dash` (em dash) |
| G12 | A | `start 30m --` | no message |
| G13 | A | `start 30m -- <!channel> <@U123\|someone> & "q"` | message `&lt;!channel&gt; &lt;@U123\|max&gt; &amp; "q"` (Slack-escaped form) |
| G14 | A | `start 30m -- api PROD 99m` | env INTEG, targets all; message `api PROD 99m` (never parsed) |
| G15 | A | `start 30m -- line1⏎line2` | message `line1 line2` |
| G16 | C | `start 30m` | error `env_required` |
| G17 | A | `start` | error `duration_missing` |
| G18 | A | `start PROD` | error `duration_missing` |
| G19 | A | `start 0m` | error `duration_too_short` |
| G20 | A | `start 3m` | error `duration_too_short` |
| G21 | A | `start 25h` | error `duration_too_long` |
| G22 | A | `start 90` | error `duration_needs_unit` |
| G23 | A | `start 30m 45m` | error `duplicate_duration` |
| G24 | A | `start 30m PROD INTEG` | error `duplicate_env` |
| G25 | A | `start 30m nosuch` | error `unknown_env_or_target` |
| G26 | A | `start 30m STAGE` | error `unknown_env_or_target` |
| G27 | A | `start 30m api.*` | error `unknown_env_or_target` (no patterns) |
| G28 | A | `start 30m api,,web` | error `empty_list_item` |
| G29 | A | `start 30m -- ` + 301 × `x` | error `message_too_long` |
| G30 | A | `start ３０m` (fullwidth digits) | error `unknown_env_or_target` |
| G31 | A | `start 30m -- ` + 300 × `x` | accepted |
| G32 | A | `end` | end, no env (all envs), all targets |
| G33 | A | `end PROD api` | end, PROD, [api] |
| G34 | A | `end -- deploy done` | end, no env, message `deploy done` |
| G35 | A | `end 30m` | error `unexpected_duration` |
| G36 | C | `end` | end, no env, [api] (no `env_required` for `end`) |
| G37 | A | `list` | list |
| G38 | A | `list PROD` | error `unexpected_argument` |
| G39 | A | (empty) | help |
| G40 | A | `help` | help |
| G41 | A | `stop` | error `unknown_subcommand` |
| G42 | A | `30m` | error `unknown_subcommand` |
| G43 | A | `list 30m` | error `unexpected_argument` |
| G44 | A | `help foo` | error `unexpected_argument` |
| G45 | A | `-- just a message` | help (empty head; message ignored) |
| G46 | A | `start 30m api, web` | error `empty_list_item` |
| G47 | A | `start 30m--x` | error `unknown_env_or_target` (`--` inside a token is no separator) |
| G48 | A | `end PROD 30m` | error `unexpected_duration` |

Targets that look like a duration or are all digits cannot be selected, so DWA-CFG-006 rejects them. The table assumes fixed limits (5-minute floor, one cap per channel) and shows the message in its Slack-escaped form; the per-environment caps, `min_duration` from the configuration, the order of the error checks and the raw message in the silence comment are covered by T-CMD-4, T-CMD-7 and T-MSG-3.

## 13. Test plan

Unit tests run with a fake Grafana and a fake Slack client. Live tests (L) run on throwaway silences in a test Slack workspace, with matchers that match no alert.

| Requirement | Test |
|---|---|
| DWA-GEN-001 | T-GEN-1: CI scans the tree for token shapes (`xox[a-z]-`, `xapp-`, `glsa_`) and for host names outside example files. An operator MAY add a private deny list of organization, host and channel names: the test reads it from the path in `DWA_DENY_LIST` and skips when the variable is unset. A deny list never lives in this repository, because it would publish what it hides. A match outside `test/` and `*.example.*` fails the build. T-CFG-8 runs both example configs on the same code. |
| DWA-GEN-002, 003 | T-GEN-2: the dependency list has no LLM client; T-GEN-3: a restart between `start` and `list` shows the same window (T-ST-2). |
| DWA-GEN-004 | T-GEN-4: two parallel `start` for one target in one channel: one succeeds, one gets the conflict reply; commands of two channels run in parallel (a Grafana call that takes 10 s in channel X does not delay `list` in channel Y); `start` and `end` of one channel serialize, so an `end` never sees a half-created window. |
| DWA-GEN-006, 007 | T-GEN-6: after a restart the group cache, dedupe set and rate counters are empty and nothing else is lost; T-GEN-7: keywords and the duration syntax in the configuration and in commands are the same parser. |
| DWA-CFG-001, 002 | T-CFG-1: load from `DWA_CONFIG` and the default path; T-CFG-2: a config value that starts with `xoxb-`, `xoxp-`, `xapp-` or `glsa_`, or a key `token`, `password` or `secret` (not `*_env`) with a value, is rejected. |
| DWA-CFG-003 | T-CFG-3: each rule of DWA-CFG-006 has a bad file; start exits 2 and prints all errors. |
| DWA-CFG-004 | T-CFG-4: SIGHUP with a good file changes behavior; SIGHUP with a bad file keeps the old one. |
| DWA-CFG-005 | T-CFG-5: lookup is by channel id; the `label` is ignored. |
| DWA-CFG-006, 008, 010–012 | T-CFG-6: table-driven bad configs, one row per rejection in DWA-CFG-006, 008 and 012 (env named `30m`, `123` or `a:b`; target named `2h`; target equal to env; case-only duplicates; no target; missing or extra env mute; unknown version; empty `matchers`; trailing slash in `url`; `max_duration` below `min_duration`; unknown `env_max_duration` key; regex without `allow_regex`; regex `.*`; empty matcher value; an `on_partial` value other than `keep` or `rollback`; empty channel `auth` block; these are invalid; valid replacement cases such as a channel `auth` with `allow_users` only, whose group list is then empty and does not inherit the global groups, load without error); T-CFG-9: two `instance` values on one Grafana do not see each other's silences. |
| DWA-CFG-013, DWA-GRA-004 | T-CFG-11: a `max_message_length` above 500 minus the computed overhead is rejected (with and without `marker_key_env`, with the longest target and environment names); the marker plus the longest message never exceeds 500 characters in a property test; `limits.instance` outside `[a-z0-9]{1,16}` is rejected. |
| DWA-CFG-007, DWA-CMD-009, DWA-MSG-004 | T-CFG-7: a message that looks like a matcher (`target_id=x`, regex) leaves every Grafana request body unchanged except the comment. |
| DWA-CFG-009 | T-CFG-10: `check-config --dry-run` prints match counts and refuses above `max_matched`; **L-CFG-1** (done, F12): while a real alert fires, the matching entry counts 1 and the others 0. |
| (two orgs) | T-CFG-8: both example configs load; each runs its own subset of the command suite (org-a: G01–G15 and the error cases that fit its limits; org-b: `select: explicit` refusal, 10-minute floor, 200-character message cap). |
| DWA-CMD-001–003 | T-CMD-1: grammar cases G01–G48, run as a table (the production test reads limits from the config). |
| DWA-CMD-004 | T-CMD-2: G10, G11, G12 plus en dash. |
| DWA-CMD-005 | T-CMD-3: G30. |
| DWA-CMD-006 | T-CMD-4: G19–G21 plus a channel cap and an `env_max_duration` lower than the global cap. |
| DWA-CMD-007, 008 | T-CMD-5: G39–G45; every error case posts nothing to the channel, calls no Grafana and is sent with `chat.postEphemeral` (fallback `response_url`). T-CMD-7: with several faults in one text, the error that wins follows the order in section 5.1. |
| DWA-CMD-010 | T-CMD-6: the manifest sets `should_escape: false`; the parser handles the escaped form `<#C…\|name>` as an unknown token. |
| DWA-CMD-011, DWA-SLK-002, 003 | T-SLK-1: the fake client sees `ack()` before the first Grafana call; a delayed Grafana does not delay the ack; the same `envelope_id` or `trigger_id` twice runs once; a closed socket reconnects. |
| DWA-CHN-001 | T-CHN-1: unknown channel id → ephemeral refusal, no Grafana call, no post. |
| DWA-CHN-002 | T-CHN-2: a window of channel X is invisible to `list` and `end` in channel Y. |
| DWA-CHN-003, 004 | T-CHN-3: subset selection; unknown name; `select: all` and `select: explicit` with no target (`start` and `end`: reply lists the valid targets). |
| DWA-ENV-001–003 | T-ENV-1: G02, G16; T-ENV-2: env selects the right mute definition; T-ENV-3: conflict detection is by (channel, target, env) name only: two names with identical matchers do not conflict. |
| DWA-END-001, 002 | T-END-1: G32, G36 with one active window ends it; T-END-2: no active window → "no active window"; T-END-3: INTEG and PROD windows active, bare `end` ends nothing and lists both; T-END-4: `end api` leaves the `web` silences active and the window shows "partly ended". |
| DWA-MSG-001–003, 005 | T-MSG-1: G12, G15, G29, G31; T-MSG-2: the announcement block has `verbatim: true`, `parse: none`, no `link_names`; `<!channel>` appears escaped in announcement, thread reply and `list`; T-MSG-3: the silence comment holds the raw text with `{$MACRO}` turned into `(MACRO)`; T-MSG-4: U+202E, U+200B, U+2028 and C1 controls are replaced; the limit counts code points. |
| DWA-GRA-001–004 | T-GRA-1: recorded request body for create (times, matchers, `isEqual`); T-GRA-2: `createdBy` overwritten in the response, marker still has the user; T-GRA-3: the silence count follows the number of entries; one regex matcher yields one silence; the marker plus message stays under 500 characters; **L-GRA-1** (done, F9, F10): create, list, expire one silence with a no-match matcher using the service account; **L-GRA-2** (open: needs a custom role, which OSS Grafana lacks, F10): the same with a token that has only the three actions; read back `createdBy`. |
| DWA-GRA-005, 010 | T-GRA-4: a foreign silence (no marker, or another `instance`) is never returned by `find` and never expired. |
| DWA-GRA-006–009 | T-GRA-5: `end` twice is ok; a 404 maps to ok; another 4xx is a failure; T-GRA-6: timeouts and a 5xx with retries, a 4xx without retry; T-GRA-7: a `create` timeout after Grafana accepted the call creates no second silence; T-GRA-8: a limit rejection shows as failure class `limit`; T-GRA-9: times are UTC, `find` ignores the local clock, `startsAt` is 60 s before the start and Grafana accepts it (it moves it to now); T-GRA-10: `find` lists all silences and filters on the client; one `find` serves the conflict checks and a retry. |
| DWA-ST-001–007 | T-ST-1: id format, secure random source, collision retry; T-ST-2: `list` after a simulated restart; the end time comes from `endsAt`; T-ST-3: a target with fewer live silences than `n` is incomplete, a target removed by `end api` is not; T-ST-4: `ts`, `ch` round trip; T-ST-5: the message is kept in full within the size limit; T-ST-6: a comment with a forged field after the first separator is not parsed; a comment with a wrong format or bad `sig` is foreign; T-ST-7: the "starting" text contains the instruction; a restart logs one line per active marked silence. |
| DWA-AUTH-008 | T-AUTH-8: a fake Slack answering `no_such_subteam` or `plan_upgrade_required` with `allow_usergroups` set → exit 2 with the stated message; with `allow_users` only → starts; **L-SLK-1** (done, F2, F5): the Free workspace answers `usergroups.users.list` with `no_such_subteam`. |
| DWA-AUTH-001–007 | T-AUTH-1: user list, group list, channel block replaces global as a whole; T-AUTH-2: group lookup failure denies (never reuses an expired entry), the effective `allow_users` of that channel still allows, a global `allow_users` entry does not rescue a user when the channel has its own `auth` block; the group cache expires after 60 s, and after 10 s for `start` and `end` (fake clock); T-AUTH-3: `help` open, `list` needs an allowed user; T-AUTH-4: denial reply and audit line; T-AUTH-5: user B ends a window of user A; T-AUTH-6: config without any allow list is invalid; T-AUTH-7: a DM, a group DM, an unmapped channel and a `text` that contains a channel id are refused; the configuration reference states that a channel shared with another organization must not be mapped. |
| DWA-LIM-001–008 | T-LIM-1: min and max; T-LIM-2: no code path ends a window before its end time except `end`, and none extends one; T-LIM-3: conflict on one of three targets blocks all three and changes nothing; T-LIM-4: rate limit; T-LIM-5: two instances start the same target at once, the lower window id stays, the other finds and expires every silence with its window id; T-LIM-6: `max_silences_per_window` refusal; T-LIM-7: `max_concurrent_windows` refusal; T-LIM-8: a reminder is posted 5 minutes before the end (fake clock); after a restart no reminder is posted and no scheduled Slack message exists. |
| DWA-FAIL-001–005 | T-FAIL-1: one of two silences rejected → partial under `keep`; T-FAIL-2: the same under `rollback` → the created silence is expired; a create that timed out after Grafana accepted it is found by window id and expired too (T-FAIL-7); all fail → failed; a failing rollback step → "failed, silences still active"; T-FAIL-3: `end` continues after one failure; T-FAIL-4: `chat.update` fails → new message; T-FAIL-5: Grafana down at start; T-FAIL-6: the announcement post fails → no Grafana call. |
| DWA-SLK-001, 004–006 | T-SLK-2: no listening socket (`lsof`); T-SLK-3: announcement goes through `chat.postMessage` and `chat.update`; ephemeral replies through `chat.postEphemeral`; T-SLK-4: manifest scopes are exactly the documented set; T-SLK-5: with two connections, one stays open while the other reconnects after a refresh; T-SLK-6: a command that takes over 30 s gets a "still working" reply, a failing one a failure notice; T-SLK-7: bot not in channel → `start` stops with no Grafana change, `end` still expires. |
| DWA-ANN-001–003 | T-ANN-1: announcement fields for each status, times as Slack date tokens; T-ANN-2: `end` replies in the thread of each ended window; no announcement found → new message; subset end → "partly ended". |
| DWA-AUD-001–005 | T-AUD-1: one JSON line per start and end, with all fields, and token-shaped strings redacted; T-AUD-2: denials, limit refusals, grammar errors, `list`, `help` and unmapped-channel refusals audited; T-AUD-3: marker holds the Slack user; T-AUD-4: the extra file sink receives each line. |
| DWA-DEP-001–008 | T-DEP-1: `systemd-analyze security` score and the unit flags of DWA-DEP-001; T-DEP-2: egress-only check; TLS verification cannot be switched off; T-DEP-3: token-pattern scan of the repo, the log and error replies; T-DEP-4: log redaction of `*_env` values and the `Authorization` header, with HTTP client debug on; T-DEP-5: manifest lints; T-DEP-6: a second instance is documented and DWA-LIM-005 holds (T-LIM-5). |
| DWA-OPS-001–005, 007 | T-OPS-1: the self-check output for Slack down and Grafana down; a bot that is not in the channel shows at the first post as `not_in_channel`; T-OPS-2: watchdog notifications stop when the Slack connection is down; T-OPS-3: every log line parses as JSON with `time`, `level`, `event`; T-OPS-4: the repository contains the three documents of DWA-OPS-004 (checked by a docs lint); T-OPS-5: the example alert rule for DWA-OPS-005 evaluates on a test Grafana; T-OPS-6: the health file is written while a connection is up, once per interval however many are open, and stops at zero (fake timers). |
| Whole flow | **L-E2E-1** (done, Free-plan workspace, OSS Grafana 12.4): in a test workspace, `start` → alert silenced and announcement correct → `end` → thread reply. It needs a throwaway test workspace and a test Grafana. A live check also confirmed T-AUTH-4 (a user removed from `allow_users` by a reload is refused, with an audit line) and DWA-MSG-003 (`&`, `<`, `>` escaped exactly once, F13). |

## 14. Verified platform facts (informative)

These facts about Slack and Grafana were checked before the build, from the vendor documents and with read-only or throwaway calls against a test workspace and a test Grafana. They explain choices in the requirements above. Re-check them when Slack or Grafana change.

| # | Fact | How it was checked |
|---|---|---|
| F1 | A custom app with a slash command works on the Slack Free plan. Free allows up to 10 third-party or custom app installations; one app with a bot and a slash command uses one slot. | Slack help: "limited to 10 third-party or custom app installations"; live install in a Free-plan test workspace |
| F2 | Socket Mode works on the Free plan with an app-level token (`connections:write`): `auth.test` succeeds, the socket starts and a slash command arrives over it. Slack allows up to 10 open WebSocket connections per app; Socket Mode apps cannot be listed in the public Marketplace. | live test in a Free-plan test workspace; docs.slack.dev, "Using Socket Mode" |
| F3 | Slash-command payloads carry `user_id`, `channel_id`, `text`, `trigger_id` and `response_url`. The app must acknowledge within 3 seconds. `response_url` accepts up to 5 uses in 30 minutes. An ack came back in about 1 ms in the live test. | docs.slack.dev, "Implementing slash commands" and "Handling user interaction"; live test |
| F4 | Slack text needs only `&`, `<` and `>` escaped. `@everyone`-style text in user input can notify the workspace unless escaped. The app setting "Escape channels, users, and links" is optional. | docs.slack.dev, "Formatting message text" |
| F5 | User groups need a paid plan. On the Free plan `usergroups.list` answers `ok` with no groups, and `usergroups.users.list` for an unknown id answers `no_such_subteam`, not `plan_upgrade_required` as the documents say. DWA-AUTH-008 checks both. | live test in a Free-plan test workspace |
| F6 | Free shows the last 90 days of messages; a window lasts at most 4 hours, so `chat.update` and thread replies are unaffected. `chat.postMessage` allows about 1 message per second per channel. | Slack help; docs.slack.dev, `chat.postMessage` |
| F7 | Grafana 13.0.1: a service-account token lists silences with `GET /api/alertmanager/grafana/api/v2/silences`. Its effective permissions include `alert.instances:create`, `alert.instances:read` and `alert.instances:write`, all unscoped. | live read-only calls (`/api/health`, `/api/access-control/user/permissions`) |
| F8 | Silence endpoints on Grafana 13.0.1: create `POST …/silences` answers HTTP 202 `{"silenceID":"…"}`; `GET …/silence/{id}` and the list show `status.state` `active`; `DELETE …/silence/{id}` answers 200 and the state becomes `expired` with `endsAt` set to the time of the call; the expired silence stays listable; a second `DELETE` answers 200 again; `DELETE` of an unknown id answers 404 `alerting.notifications.silences.notFound`. A `startsAt` 30 seconds in the past is stored as the time of the call. The three `alert.instances:*` actions are enough for all calls. | one throwaway silence with the matchers `example_label=example` and `dwa_spec_test=matches-nothing` (matches no alert), created, read and expired; Grafana source `pkg/services/ngalert/api/authorization.go` |
| F9 | `createdBy` comes back exactly as sent (for example `slack:U0EXAMPLE01 (Example User)`) with a service-account token on Grafana 13.0.1, and on OSS Grafana 12.4.2 with an Editor service account. Other versions or tokens may replace it, so the marker stays the primary record. | the same throwaway silence |
| F10 | Custom role management is Enterprise or Cloud only. On OSS Grafana 12.4.2 a Viewer service account cannot create silences and an Editor one can, so Editor is the least-privilege built-in role there. | Grafana docs, "Manage RBAC roles"; live test on OSS 12.4.2 |
| F11 | Expired silences stay listable for 5 days. | Grafana docs, "Create silences" |
| F12 | The alerts endpoint `GET …/api/alertmanager/grafana/api/v2/alerts` answers 200; its `filter` parameter accepts Alertmanager matchers (`=` and `=~`), and a bad matcher answers 400 `bad matcher format`. While an alert fires, the filter for its labels counts 1 and other filters 0 (L-CFG-1, OSS Grafana 12.4.2). | live read-only calls; one alert made to fire on a test service |
| F13 | With `should_escape: false`, a command text sent through the Slack client API arrives as typed for `&`, `<`, `>` and `<!here>`; a typed user mention `<@U…>` arrived as plain `@name`. DWA escapes once, so the announcement shows every character literally and nothing notifies. | live test in a Free-plan test workspace |
