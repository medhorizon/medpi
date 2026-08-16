# MedPi

MedPi is a minimal science platform built on Pi `0.84.1` and the editable pi-web `v0.8.6` source.

The active MedHorizon-derived code is intentionally limited to [`packages/science`](packages/science). It is loaded as a normal Pi package and does not fork Pi core or copy the legacy MedHorizon runtime/UI.

> **Development baseline, not a public-production release.** Production dependency audit is clean, and a minimal sandbox closed loop (`science_run`/`science_rollback`: default no-sandbox, Linux-optional bwrap, with audit/abort/rollback) is in place. A real-model browser flow and public deployment controls remain outside this slice. See the migration review before deployment.

## Start here

See the [User Guide](docs/userguide.md) for installation, project trust, model configuration, chat controls, science tools, Stage, provenance, sessions, troubleshooting, and security boundaries.

## Review first

See [`docs/science-platform-migration.md`](docs/science-platform-migration.md) for the detailed capability comparison, exact migration manifest, exclusions, safety boundaries, and verification status.

## Commands

```bash
npm install --include=dev
npm test
npm run typecheck
npm run lint
npm audit --include=dev
npm run audit
npm run dev
```

`npm run dev` starts the Web UI at `http://127.0.0.1:30141`. Do not run `next build` during development.

The repository-local [`.pi/settings.json`](.pi/settings.json) loads `@medpi/science` when Pi runs with this repository as its trusted project. To use it from another project, install the local package there explicitly rather than modifying Pi core.
