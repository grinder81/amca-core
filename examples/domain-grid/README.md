# AMCA Domain Integration Grid

These examples are domain-lite AMCA acceptance fixtures. They do not add domain
semantics to AMCA Core and they do not execute real domain systems.

The Phase 59 grid covers:

- coding static analysis
- trading analysis controls
- genomics/DNA QC
- weather analysis validation

Each domain is represented as a capability contract plus two deterministic
scenarios:

- supported claim: an admitted `test_run` receipt supports a structured
  `test_result` claim;
- blocked claim: the same claim shape has no admitted evidence and is blocked.

The executable fixtures live in `packages/testing/src/domain-grid.ts`; the
mission litmus lives in
`packages/testing/src/mission/domain-integration-grid.mission.test.ts`.
