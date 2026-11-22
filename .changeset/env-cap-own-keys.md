---
"deploy-window": patch
---

An environment named like a property that every JavaScript object has (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, …) and without its own `env_max_duration` had no duration cap at all: the cap was `NaN`, so `start 99h999m` was accepted under any global or channel cap. It now gets the lowest of the global and channel caps, as DWA-CMD-006 says.
