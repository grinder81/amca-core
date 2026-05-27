# Contributing

Thank you for considering a contribution to AMCA Core.

AMCA's prime directive is:

```text
Agents reason.
The harness validates.
The kernel mutates.
The broker executes effects.
The ledger anchors accepted history.
The proof engine verifies.
The release gate publishes.
```

## Development Setup

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:mission
```

## Contribution Rules

- Keep AMCA Core domain-agnostic.
- Do not let providers, adapters, traces, telemetry, or framework state become
  proof authority.
- Do not add semantic coercion to normalizers for governed paths.
- Add tests for every protocol, proof, effect, release, ledger, adapter, or
  security change.
- Add negative tests when touching an authority boundary.
- Keep secrets and raw large evidence out of logs and telemetry.

## Pull Request Checklist

- [ ] Explain the AMCA layer touched.
- [ ] State whether an authority boundary changed.
- [ ] Add or update unit tests.
- [ ] Add or update mission or anti-mission tests when relevant.
- [ ] Run the full local gate.
- [ ] Document any maturity or certification boundary.
