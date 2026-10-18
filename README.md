# Deploy Window

A slash command for Slack that opens a maintenance window in Grafana. A user in a mapped channel
types `/deploy start 30m PROD -- release 2.4`; the app silences the Grafana alerts of the targets that
the channel maps, announces the window in the channel, and `/deploy end` expires the silences.

Status: specification only. See `docs/spec.md`.

Licence: Apache-2.0 (`LICENSE`, `NOTICE`). Security reports: `SECURITY.md`.
