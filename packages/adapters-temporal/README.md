# @amca/adapters-temporal

Proposal and activity-envelope helper for Temporal-shaped AMCA boundary data.

## Maturity

This package models deterministic Temporal-shaped activity envelopes,
idempotency metadata, structured workflow-output conversion, and
non-authoritative correlation helpers. Phase 53 also exposes non-executing
worker-wrapper boundary shapes so later phases can wire a real Temporal worker
only after explicit service access and certification approval.

It imports official `@temporalio/common` types for envelope compatibility, but
it does not start workers, connect to a Temporal server, execute activities, or
turn Temporal history into AMCA proof.

## Boundaries

- May represent Temporal-shaped activity data at the AMCA boundary.
- May use official Temporal common SDK types for deterministic envelope shape.
- Must not run Temporal workers, workflows, or activities.
- Must not treat Temporal history or activity results as AMCA proof, receipts,
  ledger truth, or release authority.
- Must not emit AMCA receipts, release decisions, proof verdicts, or governed
  tool execution.
