# Architecture

AMCA Core is organized around authority boundaries.

```text
Provider / agent runtime
  -> proposal candidate
  -> AMCA contract validation
  -> governed effect or mutation path
  -> accepted event
  -> admitted evidence
  -> deterministic proof
  -> release decision
  -> final released output
```

The central rule:

```text
Agents and frameworks propose.
AMCA governs admissibility, proof, mutation, effects, and release.
```

## Authority Spine

| Layer        | Responsibility                                                                                |
| ------------ | --------------------------------------------------------------------------------------------- |
| Protocol     | Defines proposals, effects, evidence, claims, proof, release, mutation, approval, and events. |
| Contracts    | Strict validation and parsing. Unknown or malformed authority fields fail closed.             |
| Harness      | Accepts proposals and drives governed local runs.                                             |
| Broker       | Controls effect lifecycle and adapter dispatch.                                               |
| Kernel       | Records accepted semantic events and submits final candidates to proof/release.               |
| Ledger       | Anchors AMCA-accepted event history.                                                          |
| Proof        | Verifies structured claim predicates against admitted evidence.                               |
| Release Gate | Publishes only supported final output.                                                        |

## Non-Authority Inputs

The following are useful context but are not proof by themselves:

- provider prose;
- provider metadata or trace IDs;
- tool-call IDs;
- LangGraph checkpoint state;
- Temporal workflow history;
- telemetry;
- audit exports;
- eval or benchmark output;
- replay output.

They must be converted into AMCA-accepted semantic events before they can
support governed claims.
