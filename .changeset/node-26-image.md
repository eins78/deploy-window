---
"deploy-window": patch
---

The container image now runs on Node.js 26 LTS (`NODE_VERSION=26`, was 22), and CI also tests Node 26. The supported range is unchanged: `engines.node` stays `>=22`.
