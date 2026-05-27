import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  Claim,
  CurrentStatePredicate,
  EvidenceRef,
  ExternalStateObservationCandidate,
  FinalCandidate,
  MutationCommandRequest,
  MutationCommitted,
  PendingEvidenceRef,
  ReceiptCandidate,
  ReleaseDecision,
  RunEvent,
  TestResultPredicate,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
  WriteSideEffectClass,
} from "./index.js";

describe("AMCA protocol model", () => {
  it("keeps claim statements separate from machine predicates", () => {
    expectTypeOf<Claim>().toHaveProperty("statement").toEqualTypeOf<string>();
    expectTypeOf<Claim>()
      .toHaveProperty("predicate")
      .toEqualTypeOf<
        | import("./index.js").HistoricalActionPredicate
        | import("./index.js").TestResultPredicate
        | import("./index.js").CurrentStatePredicate
      >();
  });

  it("uses first-class evidence references", () => {
    expectTypeOf<EvidenceRef>()
      .toHaveProperty("evidenceId")
      .toEqualTypeOf<string>();
    expectTypeOf<EvidenceRef>()
      .toHaveProperty("sourceEventId")
      .toEqualTypeOf<string>();
    expectTypeOf<EvidenceRef>()
      .toHaveProperty("hash")
      .toEqualTypeOf<`sha256:${string}`>();
  });

  it("separates pending evidence from admitted evidence", () => {
    expectTypeOf<PendingEvidenceRef>()
      .toHaveProperty("admissionStatus")
      .toEqualTypeOf<"pending">();
    expectTypeOf<PendingEvidenceRef>()
      .toHaveProperty("pendingAdmissionToken")
      .toEqualTypeOf<string>();
    expectTypeOf<PendingEvidenceRef>().not.toExtend<EvidenceRef>();
    expectTypeOf<ReceiptCandidate>()
      .toHaveProperty("evidence")
      .toEqualTypeOf<PendingEvidenceRef[]>();
    expectTypeOf<ExternalStateObservationCandidate>()
      .toHaveProperty("evidence")
      .toEqualTypeOf<PendingEvidenceRef[]>();
  });

  it("requires release decisions to expose approved and blocking ids", () => {
    expectTypeOf<ReleaseDecision>()
      .toHaveProperty("approvedClaimIds")
      .toEqualTypeOf<string[]>();
    expectTypeOf<ReleaseDecision>()
      .toHaveProperty("blockingMismatchIds")
      .toEqualTypeOf<string[] | []>();
  });

  it("requires run events to include causation and correlation fields", () => {
    expectTypeOf<RunEvent>()
      .toHaveProperty("causationId")
      .toEqualTypeOf<string | null>();
    expectTypeOf<RunEvent>()
      .toHaveProperty("correlationId")
      .toEqualTypeOf<string | null>();
    expectTypeOf<RunEvent<"WritePreflightRequested">>()
      .toHaveProperty("payload")
      .toEqualTypeOf<import("./index.js").WritePreflightRequestedPayload>();
    expectTypeOf<RunEvent<"WritePreflightDecided">>()
      .toHaveProperty("payload")
      .toEqualTypeOf<import("./index.js").WritePreflightDecidedPayload>();
    expectTypeOf<RunEvent<"WriteQuarantined">>()
      .toHaveProperty("payload")
      .toEqualTypeOf<import("./index.js").WriteQuarantinedPayload>();
    expectTypeOf<RunEvent<"MutationCommitted">>()
      .toHaveProperty("payload")
      .toEqualTypeOf<import("./index.js").MutationCommittedPayload>();
    expectTypeOf<RunEvent<"ApprovalGranted">>()
      .toHaveProperty("payload")
      .toEqualTypeOf<import("./index.js").ApprovalGrantedPayload>();
  });

  it("keeps current-state comparisons primitive", () => {
    expectTypeOf<CurrentStatePredicate>()
      .toHaveProperty("expectedValue")
      .toEqualTypeOf<string | number | boolean>();
  });

  it("supports structured final candidates", () => {
    const predicate: TestResultPredicate = {
      kind: "test_result",
      capabilityId: "shell.run_tests",
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
    };

    const candidate: FinalCandidate = {
      kind: "final_candidate",
      candidateId: "candidate_001",
      runId: "run_001",
      claims: [
        {
          claimId: "claim_001",
          type: "test_result",
          statement: "Tests passed.",
          predicate,
          evidenceRefs: [],
          criticality: "medium",
        },
      ],
    };

    expect(candidate.claims[0]?.predicate).toEqual(predicate);
  });

  it("models write preflight separately from execution receipts", () => {
    expectTypeOf<WriteSideEffectClass>().toEqualTypeOf<
      | "idempotent_write"
      | "reversible_write"
      | "irreversible_write"
      | "critical_write"
    >();
    expectTypeOf<WritePreflightCandidate>()
      .toHaveProperty("kind")
      .toEqualTypeOf<"write_preflight_candidate">();
    expectTypeOf<WritePreflightCandidate>()
      .toHaveProperty("argsHash")
      .toEqualTypeOf<`sha256:${string}`>();
    expectTypeOf<WritePreflightDecision>()
      .toHaveProperty("status")
      .toEqualTypeOf<"allowed" | "denied" | "quarantined">();
    expectTypeOf<WriteQuarantineState>()
      .toHaveProperty("status")
      .toEqualTypeOf<"quarantined">();
    expectTypeOf<WriteQuarantineState>().not.toExtend<ReceiptCandidate>();
  });

  it("models mutation proposals separately from committed state events", () => {
    expectTypeOf<MutationCommandRequest>()
      .toHaveProperty("kind")
      .toEqualTypeOf<"mutation_command_request">();
    expectTypeOf<MutationCommandRequest>()
      .toHaveProperty("payloadHash")
      .toEqualTypeOf<`sha256:${string}`>();
    expectTypeOf<MutationCommitted>()
      .toHaveProperty("kind")
      .toEqualTypeOf<"mutation_committed">();
    expectTypeOf<MutationCommitted>()
      .toHaveProperty("previousRevision")
      .toEqualTypeOf<number>();
  });

  it("models scoped human approvals without making them evidence", () => {
    expectTypeOf<import("./index.js").ApprovalGrant>()
      .toHaveProperty("approverId")
      .toEqualTypeOf<string>();
    expectTypeOf<import("./index.js").ApprovalGrant>()
      .toHaveProperty("scope")
      .toEqualTypeOf<import("./index.js").ApprovalScope>();
    expectTypeOf<
      import("./index.js").ApprovalGrant
    >().not.toExtend<EvidenceRef>();
  });
});
