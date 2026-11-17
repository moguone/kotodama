# Contributing

Issues and pull requests are welcome, in English or Japanese.

## Setup

Node.js 24 and pnpm 10 are required (versions are listed in `mise.toml` and `package.json`).

```bash
pnpm install
pnpm typecheck
pnpm build
```

Load `dist/` as an unpacked extension from `chrome://extensions`.

## Guidelines

- Keep pull requests small and focused on one change.
- Run `pnpm typecheck` and `pnpm build` before opening a pull request. CI runs the same checks.
- Describe what you checked by hand in the browser. There are no automated browser tests yet.
- Do not add runtime dependencies without discussing it first. The extension currently bundles
  only its own code.
- New dependencies must be at least two days old (`minimumReleaseAge` in `pnpm-workspace.yaml`).
- Never commit API keys, recordings, or transcripts of real videos.

## GitHub Actions

Actions are pinned with a lockfile, `.github/workflows/actions.lock`. Workflows reference actions by
tag (for example `actions/checkout@v7.0.1`), and the lockfile decides which commit runs.

Dependabot updates both the `uses:` lines and the lockfile. If you add or change a `uses:` line by
hand, update the lockfile in the same pull request:

```bash
gh extension install github/gh-actions-lock   # first time only
gh actions-lock
```

CI fails when the lockfile does not match the workflows (`gh actions-lock --verify`), and zizmor
checks the workflows.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
