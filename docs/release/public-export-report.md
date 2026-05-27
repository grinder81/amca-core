# Public Export Report

This repository was prepared as a clean public export for `amca-core`.

It is not a history-preserving mirror of the internal development repository.

## Export Shape

Included:

- AMCA source packages under `packages/`;
- public examples under `examples/`;
- public scenarios under `scenarios/`;
- public documentation under `docs/`;
- GitHub CI and contribution files;
- root TypeScript, pnpm, eslint, prettier, and vitest configuration.

Excluded:

- internal evidence bundles;
- local provider run artifacts;
- private review material;
- local machine paths;
- internal phase reports;
- temporary branch artifacts;
- generated coverage and test output;
- credentials or local service URLs.

## Public Gate

Commands run in the exported tree:

```text
pnpm install --frozen-lockfile: PASS
pnpm typecheck: PASS
pnpm lint: PASS
pnpm format:check: PASS
pnpm test: PASS
  Test Files: 78 passed | 3 skipped
  Tests: 678 passed | 18 skipped
pnpm test:mission: PASS
  Test Files: 33 passed | 1 skipped
  Tests: 204 passed | 6 skipped
git diff --check: PASS
```

## Sanitization Checks

Searches for internal local paths, local machine names, internal provider
defaults, legacy live-database environment names, private review terms, internal
evidence references, hardcoded provider keys, hardcoded database URLs, and
common credential-shaped fixture strings returned no matches in tracked source
files.

Known acceptable literals remain in implementation and tests for redaction
logic, such as `Bearer`, `Authorization`, and private-key regex patterns. They
are not committed credentials.

## Maturity Statement

AMCA Core is published as `0.1.0-alpha.0`.

The public repository includes framework source, tests, examples, and
documentation. Live external integrations and production certification remain
environment-specific and opt-in.
