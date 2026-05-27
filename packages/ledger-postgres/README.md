# @amca/ledger-postgres

Live-integration certified Postgres semantic ledger adapter for AMCA.

## Maturity

This package is live-integration certified after Phase 31 proved migration,
append-only behavior, duplicate rejection, rollback safety, tamper rejection,
projection rejection, connection failure behavior, concurrency behavior, and
read-after-write consistency against a real Postgres service.

It does not claim durable production ledger certification.

## Boundaries

- May model the Postgres-backed semantic ledger adapter behind the
  `@amca/ledger` port.
- Must store or return only accepted AMCA semantic events, subject to AMCA
  validation and hash checks.
- Must not become proof, release, projection, replay, broker, service, or domain
  authority.

See `docs/engineering/POSTGRES_LIVE_INTEGRATION_TEST_PLAN.md` for the Phase 31
live integration test plan and evidence expectations.
