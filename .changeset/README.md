# Changesets

Each pull request that changes behaviour adds a changeset: `pnpm changeset`. On `main` the Version
Packages workflow collects them into one pull request that bumps `package.json` and `CHANGELOG.md`.
After that pull request is merged, a GitHub Release `vX.Y.Z` publishes the container image (see
`docs/operations.md`).
