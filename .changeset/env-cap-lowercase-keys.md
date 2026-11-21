---
"deploy-window": minor
---

**Breaking (configuration):** the keys of `env_max_duration` must be lowercase, for example `env_max_duration: {prod: 1h}`. A key with an uppercase letter is refused, with the message `env_max_duration keys are lowercase: write "prod"`: at start DWA exits with status 2, and on `SIGHUP` it keeps the old configuration. A lowercase key still caps the environment of any spelling (`prod` caps `PROD`), and commands still ignore case. Before, two keys that differed only in case (`{PROD: 1h, prod: 3h}`) both named one environment and the later key won. Upgrade: lowercase the keys first. Version 0.2.0 already reads lowercase keys, so the edited file works before and after the upgrade (DWA-CFG-006, DWA-LIM-001).
