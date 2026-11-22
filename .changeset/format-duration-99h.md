---
"deploy-window": patch
---

A window of 100 hours or more (possible only with a cap of `99h60m` or more) was written as `100h` in the audit line, which the duration syntax cannot read. It is now written as `99h60m`, the form the syntax has (DWA-AUD-001). Shorter durations are written as before.
