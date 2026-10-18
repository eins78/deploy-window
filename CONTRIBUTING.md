# Contributing

Deploy Window is maintained by one person and published as a reference implementation. Issues and
pull requests are welcome but may go unanswered. For a vulnerability, follow `SECURITY.md`, not an
issue.

- The specification `docs/spec.md` is the source of truth. A change of behaviour changes the
  specification in the same pull request, with the requirement id (`DWA-*`) it touches.
- Every test file names the ids it covers in its first line (`// covers: …`).
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm lint:tokens` before you push.
- Never put a real token, a real Slack id, a real Grafana URL or an organization's name into the
  repository, a test or an issue. Use the placeholders of the example files (`C0EXAMPLE01`,
  `U0EXAMPLE01`, `org-a`, `example-prod-api`).
- By contributing you agree that your contribution is licensed under the Apache License 2.0.
