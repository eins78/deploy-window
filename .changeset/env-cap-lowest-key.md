---
"deploy-window": patch
---

When `env_max_duration` names one environment twice in different case (`{PROD: 1h, prod: 3h}`), the lower cap now applies, as DWA-CMD-006 says ("the lowest applicable cap"). Before, the later key won, so the window could be longer than the lower cap.
