# Visual Guide

This guide explains AMCA Core visually.

The diagrams are conceptual architecture diagrams. For concrete executed
records, run the local flight recorder:

```bash
AMCA_PROVIDER_LIVE=1 \
AMCA_PROVIDER_BASE_URL=http://localhost:11434/v1 \
AMCA_PROVIDER_MODEL=code \
AMCA_PROVIDER_API_KEY=<local-placeholder> \
pnpm demo:flight-recorder
```

The recorder writes local event/proof/release artifacts under `.amca/`.

## One-Screen Summary

```mermaid
flowchart LR
  U["User / App"] --> A["Agent or Provider"]
  A --> P["Proposal Candidate"]
  P --> C["AMCA Contract Validation"]
  C --> H["Governed Harness"]
  H --> B["Effect Broker"]
  B --> T["Tool / Adapter / Runtime"]
  T --> RC["Receipt or Observation Candidate"]
  RC --> K["AMCA Kernel Admission"]
  K --> E["Admitted EvidenceRef"]
  E --> F["FinalCandidate Claims"]
  F --> PR["Deterministic Proof"]
  PR --> RG["Release Gate"]
  RG --> OUT["Released Answer or Blocked Result"]

  A -. "not authority" .-> PR
  T -. "not proof before admission" .-> PR
```

The important idea:

```text
The model may propose.
The tool may return.
AMCA decides what is admissible, provable, and releasable.
```

## Authority Spine

```mermaid
flowchart TD
  subgraph "Proposal Zone"
    Provider["Provider / Agent Runtime"]
    Framework["LangGraph / Temporal / Agent SDK"]
    Domain["Domain Extension"]
  end

  subgraph "AMCA Governance Zone"
    Contracts["Contracts: validate strict shapes"]
    Harness["Harness: drives governed run"]
    Broker["Effect Broker: controls effects"]
    Kernel["Kernel: records accepted events"]
    Ledger["Semantic Ledger: anchors history"]
    Proof["Proof Engine: verifies predicates"]
    Release["Release Gate: publishes only supported output"]
  end

  subgraph "Mechanism Zone"
    Tools["Tools / APIs / Local compute"]
    Adapters["Adapters / Runtime bridges"]
    External["External systems"]
  end

  Provider --> Contracts
  Framework --> Contracts
  Domain --> Contracts
  Contracts --> Harness
  Harness --> Broker
  Broker --> Tools
  Broker --> Adapters
  Broker --> External
  Tools --> Broker
  Adapters --> Broker
  External --> Broker
  Broker --> Kernel
  Kernel --> Ledger
  Kernel --> Proof
  Proof --> Release

  Provider -. "cannot admit receipts" .-> Kernel
  Framework -. "state is not proof" .-> Proof
  Tools -. "candidate only" .-> Proof
  Ledger -. "history, not external truth" .-> External
```

## Data Flow

```mermaid
flowchart LR
  TC["ToolCommandRequest"] --> ER["EffectRequest"]
  ER --> RC["ReceiptCandidate"]
  RC --> RR["EffectReceiptRecorded"]
  RR --> EV["EvidenceRef"]
  EV --> CL["Claim.predicate"]
  CL --> PO["ProofObject"]
  PO --> RD["ReleaseDecision"]
  RD --> FR["FinalReleased"]

  FC["FinalCandidate"] --> CL

  CT["Claim.statement"] -. "display only" .-> RD
  PM["Provider metadata"] -. "non-proof" .-> PO
  TR["Trace / checkpoint / history"] -. "non-proof" .-> PO
```

`Claim.statement` can be useful display text, but proof uses structured
`Claim.predicate` plus admitted `EvidenceRef` values.

## Supported Claim Sequence

```mermaid
sequenceDiagram
  participant User
  participant Provider
  participant AMCA as AMCA Harness/Kernel
  participant Broker as Effect Broker
  participant Adapter
  participant Proof
  participant Release

  User->>Provider: Ask for result
  Provider->>AMCA: ToolCommandRequest candidate
  AMCA->>AMCA: Validate proposal
  AMCA->>Broker: EffectRequest
  Broker->>Adapter: Governed dispatch
  Adapter-->>Broker: ReceiptCandidate
  Broker-->>AMCA: Candidate result
  AMCA->>AMCA: Record EffectReceiptRecorded
  AMCA->>Provider: Safe admitted evidence context
  Provider->>AMCA: FinalCandidate with evidenceRefs
  AMCA->>Proof: Verify Claim.predicate
  Proof-->>AMCA: ProofObject pass
  AMCA->>Release: Decide release
  Release-->>User: FinalReleased output
```

## Blocked Claim Sequence

```mermaid
sequenceDiagram
  participant User
  participant Provider
  participant AMCA
  participant Proof
  participant Release

  User->>Provider: Ask for result
  Provider->>AMCA: FinalCandidate saying "tests passed"
  AMCA->>AMCA: Validate structure
  AMCA->>Proof: Check evidenceRefs
  Proof-->>AMCA: ProofObject fail
  AMCA->>AMCA: MismatchDetected missing_evidence
  AMCA->>Release: Decide release
  Release-->>User: Blocked result, no FinalReleased
```

Same words, different authority status:

```text
With admitted evidence: release can pass.
Without admitted evidence: release blocks.
```

## Candidate vs Admitted Evidence

```mermaid
stateDiagram-v2
  [*] --> Candidate: adapter returns result
  Candidate --> Rejected: invalid shape or unsafe source
  Candidate --> Admitted: kernel records accepted event
  Admitted --> ProofUsable: evidenceRef has sourceEventId and hash

  Candidate --> NonProof: pending output
  NonProof --> [*]
  Rejected --> [*]
  ProofUsable --> [*]
```

Adapters produce candidates. AMCA admission turns valid candidates into
event-anchored evidence.

## Current-State Freshness

```mermaid
flowchart TD
  H["Historical receipt"] --> HC["historical_action claim"]
  H -. "not enough" .-> CS["current_state claim"]
  O["Fresh ExternalStateObservation"] --> CS
  CS --> TTL["Freshness TTL check"]
  TTL -->|fresh| PASS["Proof can pass"]
  TTL -->|stale or missing| BLOCK["Proof blocks"]
```

Historical facts and current-state facts are different. A receipt that something
happened earlier does not prove what is true now.

## External Write Path

```mermaid
flowchart TD
  TC["ToolCommandRequest: write-capable"] --> PF["Preflight required"]
  PF --> ID["Idempotency key check"]
  ID --> AP["Approval or policy check when critical"]
  AP --> B["Broker dispatch"]
  B --> RC["ReceiptCandidate"]
  RC --> ADM["AMCA receipt admission"]
  ADM --> REC["EffectReceiptRecorded"]
  REC --> EV["Admitted EvidenceRef"]
  EV --> PR["Proof may use receipt"]

  PF -->|fails| Q["Blocked or quarantined"]
  B -->|uncertain outcome| Q
  Q -. "non-proof" .-> PR
```

The write path is stricter because external side effects are harder to undo.

## Runtime Substrates

```mermaid
flowchart LR
  LG["LangGraph state"] -. "metadata" .-> AMCA["AMCA proposal boundary"]
  TEMP["Temporal history"] -. "metadata" .-> AMCA
  OAI["Provider trace"] -. "metadata" .-> AMCA

  AMCA --> P["Proposal"]
  P --> E["AMCA events"]
  E --> Proof["Deterministic proof"]

  LG -. "not proof" .-> Proof
  TEMP -. "not proof" .-> Proof
  OAI -. "not proof" .-> Proof
```

Frameworks execute workflows. AMCA governs whether outputs become accepted
events and evidence.

## Package Map

```mermaid
flowchart TB
  Protocol["@amca/protocol"]
  Contracts["@amca/contracts"]
  Proof["@amca/proof"]
  Kernel["@amca/kernel"]
  Broker["@amca/effect-broker"]
  Harness["@amca/harness"]
  Ledger["@amca/ledger"]
  LocalLedger["@amca/ledger-local"]
  PostgresLedger["@amca/ledger-postgres"]
  Adapters["@amca/adapters-*"]
  Provider["@amca/provider-harness"]
  Security["@amca/security"]
  Observability["@amca/observability"]
  Service["@amca/service"]
  Testing["@amca/testing"]

  Contracts --> Protocol
  Proof --> Protocol
  Kernel --> Protocol
  Kernel --> Proof
  Broker --> Protocol
  Harness --> Kernel
  Harness --> Broker
  LocalLedger --> Ledger
  PostgresLedger --> Ledger
  Adapters --> Protocol
  Provider --> Protocol
  Security --> Protocol
  Observability --> Protocol
  Service --> Harness
  Testing --> Protocol
  Testing --> Kernel
  Testing --> Harness
  Testing --> Adapters
```

## What Users See

```mermaid
flowchart LR
  Ask["User asks question"] --> Run["AMCA run"]
  Run --> Decision{"ReleaseDecision"}
  Decision -->|released| Answer["Evidence-backed answer"]
  Decision -->|blocked| Repair["Blocked result with mismatch"]
  Repair --> Next["Request missing evidence or re-run observation"]
```

AMCA does not make every answer succeed. It makes success explainable and
failure actionable.
