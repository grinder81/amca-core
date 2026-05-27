# @amca/effect-broker

Governed in-memory effect lifecycle skeleton for AMCA.

## Maturity

This package is the in-memory production-read and controlled-write broker slice
for AMCA v1 completion phases 47-48. It validates adapter certification,
read-only adapter opt-in, receipt/observation candidates, idempotency behavior,
and broker-issued write preflight before dispatch.

It is not a service, durable queue, real GitHub/shell/API writer, proof engine,
release gate, or receipt-admission authority.

## Boundaries

- May model AMCA effect requests, dispatch lifecycle, receipts, and quarantine
  outcomes in memory.
- May dispatch explicitly opted-in `local_readonly` and `external_read` adapters
  that return redacted receipt/observation candidates only.
- May dispatch write-capable adapters only through a persisted, broker-issued
  preflight decision and idempotency key.
- Requires explicit write lifecycle certification before any write-capable
  adapter is broker-eligible.
- Quarantines uncertain write adapter outcomes without turning them into
  receipts or evidence.
- Must not execute real external tools, APIs, services, or durable queues.
- Must not become proof, release, domain, service, or CLI authority.
