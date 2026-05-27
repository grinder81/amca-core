# Concepts

## Proposal

A provider, agent runtime, workflow engine, or domain extension may propose a
tool command, mutation command, or final candidate. Proposal does not imply
authority.

## Evidence Admission

Adapter output is a candidate until AMCA records it as an accepted semantic
event. Only admitted evidence references can support governed claims.

## Claim Predicate

`Claim.statement` is display text. Proof uses `Claim.predicate` and admitted
evidence references.

## Deterministic Proof

Proof is deterministic. LLM judges, semantic similarity, provider confidence,
and prose interpretation are not blocking proof authority for governed paths.

## Release Gate

The release gate decides whether a final candidate can publish output. A final
answer is not publishable just because a provider produced it.

## Current-State Freshness

Historical receipts do not prove current external state. Current-state claims
need fresh observations within a declared TTL.
