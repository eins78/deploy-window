---
"deploy-window": patch
---

When `env_max_duration` names one environment twice in different case (`{PROD: 1h, prod: 3h}`), the lower cap now applies ("the lowest applicable cap", DWA-CMD-006; the key rule is now stated in DWA-LIM-001). Before, the later key won, so the window could be longer than the lower cap.
