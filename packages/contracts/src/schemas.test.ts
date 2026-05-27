import type {
  ContractValidationIssue,
  ContractValidationResult,
} from "./index.js";
import { describe, expect, it } from "vitest";

import type {
  CurrentStatePredicate,
  Claim,
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  ExternalStateObservation,
  ExternalStateObservationCandidate,
  FinalCandidate,
  Mismatch,
  PendingEvidenceRef,
  ProofObject,
  ReceiptCandidate,
  ReleasedDecision,
  RunEvent,
  TestResultPredicate,
  ToolCommandRequest,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";

import { canonicalHash } from "./hash.js";
import {
  ExternalStateObservationCandidateSchema,
  PendingEvidenceRefSchema,
  ReceiptCandidateSchema,
} from "./schemas.js";
import {
  validateClaim,
  validateClaimPredicate,
  validateEffectReceipt,
  validateEffectRequest,
  validateEvidenceRef,
  validateExternalStateObservation,
  validateFinalCandidate,
  validateMismatch,
  validateProofObject,
  validateReleaseDecision,
  validateRunEvent,
  validateToolCommandRequest,
  validateWritePreflightCandidate,
  validateWritePreflightDecision,
  validateWriteQuarantineState,
} from "./validate.js";

const observedAt = "2026-05-24T12:00:00.000Z";
const expiresAt = "2026-05-24T12:05:00.000Z";

const evidenceRef = {
  evidenceId: "evidence_001",
  kind: "effect_receipt",
  sourceEventId: "event_receipt_001",
  hash: canonicalHash({ receiptId: "receipt_001", status: "succeeded" }),
  observedAt,
  sensitivity: "internal",
} satisfies EvidenceRef;

const pendingEvidenceRef = {
  admissionStatus: "pending",
  pendingAdmissionToken: "pending_evidence_001",
  evidenceId: "pending_evidence_001",
  kind: "effect_receipt",
  hash: canonicalHash({ receiptId: "receipt_001", status: "succeeded" }),
  observedAt,
  sensitivity: "internal",
} satisfies PendingEvidenceRef;

const testPredicate = {
  kind: "test_result",
  capabilityId: "shell.run_tests",
  expectedStatus: "passed",
  requiredReceiptType: "test_run",
  testSuiteId: "unit",
} satisfies TestResultPredicate;

const testClaim = {
  claimId: "claim_tests_passed",
  type: "test_result",
  statement: "Tests passed.",
  predicate: testPredicate,
  evidenceRefs: [evidenceRef],
  criticality: "medium",
} satisfies Claim;

const currentStatePredicate = {
  kind: "current_state",
  subjectType: "package",
  subjectId: "@amca/contracts",
  property: "typecheck",
  operator: "equals",
  expectedValue: "passed",
  observationType: "command_status",
  freshnessRequirementMs: 300_000,
} satisfies CurrentStatePredicate;

const currentStateClaim = {
  claimId: "claim_current_state",
  type: "current_state",
  statement: "Contracts package typecheck is passing.",
  predicate: currentStatePredicate,
  evidenceRefs: [evidenceRef],
  criticality: "high",
} satisfies Claim;

const toolCommandRequest = {
  kind: "tool_command_request",
  commandId: "command_001",
  runId: "run_001",
  capabilityId: "shell.run_tests",
  toolId: "pnpm",
  args: { command: "pnpm test" },
  sideEffectClass: "compute",
  idempotencyKey: "run_001:pnpm-test",
  requiredEvidence: [evidenceRef],
} satisfies ToolCommandRequest;

const effectRequest = {
  effectId: "effect_001",
  commandId: "command_001",
  runId: "run_001",
  capabilityId: "shell.run_tests",
  toolId: "pnpm",
  args: { command: "pnpm test" },
  sideEffectClass: "compute",
  requestedAt: observedAt,
  idempotencyKey: "run_001:pnpm-test",
} satisfies EffectRequest;

const writePreflightCandidate = {
  kind: "write_preflight_candidate",
  preflightId: "preflight_write_001",
  runId: "run_001",
  commandId: "command_write_001",
  capabilityId: "github.create_pull_request",
  toolId: "github.create_pull_request",
  sideEffectClass: "idempotent_write",
  argsHash: canonicalHash({ title: "AMCA" }),
  requestedAt: observedAt,
  idempotencyKey: "run_001:pull_request:123",
} satisfies WritePreflightCandidate;

const writeQuarantineState = {
  kind: "write_quarantine_state",
  quarantineId: "quarantine_write_001",
  runId: "run_001",
  preflightId: "preflight_write_001",
  commandId: "command_write_001",
  capabilityId: "ops.critical_write",
  toolId: "ops.critical_write",
  sideEffectClass: "critical_write",
  status: "quarantined",
  reason: "critical_approval_required",
  message: "Critical writes require a later approval phase.",
  quarantinedAt: observedAt,
  idempotencyKey: "run_001:critical:001",
} satisfies WriteQuarantineState;

const writePreflightDecision = {
  kind: "write_preflight_decision",
  status: "allowed",
  runId: "run_001",
  preflightId: "preflight_write_001",
  commandId: "command_write_001",
  capabilityId: "github.create_pull_request",
  toolId: "github.create_pull_request",
  sideEffectClass: "idempotent_write",
  idempotencyKey: "run_001:pull_request:123",
  decidedAt: observedAt,
} satisfies WritePreflightDecision;

const writePreflightRequestedEvent = {
  eventId: "event_write_preflight_requested_001",
  runId: "run_001",
  sequence: 2,
  type: "WritePreflightRequested",
  payload: {
    candidate: writePreflightCandidate,
  },
  payloadHash: canonicalHash({
    candidate: writePreflightCandidate,
  }),
  causationId: "event_run_started_001",
  correlationId: "run_001",
  occurredAt: observedAt,
} satisfies RunEvent<"WritePreflightRequested">;

const quarantinedWritePreflightDecision = {
  kind: "write_preflight_decision",
  status: "quarantined",
  runId: "run_001",
  preflightId: "preflight_write_001",
  commandId: "command_write_001",
  capabilityId: "ops.critical_write",
  toolId: "ops.critical_write",
  sideEffectClass: "critical_write",
  quarantine: writeQuarantineState,
  decidedAt: observedAt,
  idempotencyKey: "run_001:critical:001",
} satisfies WritePreflightDecision;

const writePreflightDecidedEvent = {
  eventId: "event_write_preflight_decided_001",
  runId: "run_001",
  sequence: 3,
  type: "WritePreflightDecided",
  payload: {
    decision: writePreflightDecision,
  },
  payloadHash: canonicalHash({
    decision: writePreflightDecision,
  }),
  causationId: "event_write_preflight_requested_001",
  correlationId: "run_001",
  occurredAt: observedAt,
} satisfies RunEvent<"WritePreflightDecided">;

const writeQuarantinedEvent = {
  eventId: "event_write_quarantined_001",
  runId: "run_001",
  sequence: 4,
  type: "WriteQuarantined",
  payload: {
    quarantine: writeQuarantineState,
  },
  payloadHash: canonicalHash({
    quarantine: writeQuarantineState,
  }),
  causationId: "event_write_preflight_decided_001",
  correlationId: "run_001",
  occurredAt: observedAt,
} satisfies RunEvent<"WriteQuarantined">;

const effectReceipt = {
  receiptId: "receipt_001",
  effectId: "effect_001",
  runId: "run_001",
  capabilityId: "shell.run_tests",
  receiptType: "test_run",
  status: "succeeded",
  payload: { expectedStatus: "passed", exitCode: 0 },
  payloadHash: canonicalHash({ expectedStatus: "passed", exitCode: 0 }),
  evidence: [evidenceRef],
  observedAt,
  externalRef: "local:pnpm-test",
} satisfies EffectReceipt;

const receiptCandidate = {
  receiptId: "receipt_001",
  effectId: "effect_001",
  runId: "run_001",
  capabilityId: "shell.run_tests",
  receiptType: "test_run",
  status: "succeeded",
  payload: { expectedStatus: "passed", exitCode: 0 },
  payloadHash: canonicalHash({ expectedStatus: "passed", exitCode: 0 }),
  evidence: [pendingEvidenceRef],
  observedAt,
  externalRef: "local:pnpm-test",
} satisfies ReceiptCandidate;

const externalStateObservation = {
  observationId: "observation_001",
  runId: "run_001",
  observationType: "command_status",
  subjectType: "package",
  subjectId: "@amca/contracts",
  observedState: { typecheck: "passed" },
  observedAt,
  expiresAt,
  payloadHash: canonicalHash({ typecheck: "passed" }),
  evidence: [evidenceRef],
} satisfies ExternalStateObservation;

const externalStateObservationCandidate = {
  observationId: "observation_001",
  runId: "run_001",
  observationType: "command_status",
  subjectType: "package",
  subjectId: "@amca/contracts",
  observedState: { typecheck: "passed" },
  observedAt,
  expiresAt,
  payloadHash: canonicalHash({ typecheck: "passed" }),
  evidence: [pendingEvidenceRef],
} satisfies ExternalStateObservationCandidate;

const finalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_001",
  runId: "run_001",
  claims: [testClaim, currentStateClaim],
  narrativeDraft: "Contracts are valid.",
} satisfies FinalCandidate;

const mismatch = {
  mismatchId: "mismatch_001",
  runId: "run_001",
  type: "missing_evidence",
  blocking: true,
  message: "Claim has no matching receipt.",
  claimId: "claim_missing",
  expected: { receiptType: "test_run" },
  actual: null,
} satisfies Mismatch;

const proofObject = {
  proofId: "proof_001",
  runId: "run_001",
  candidateId: "candidate_001",
  generatedAt: observedAt,
  verdict: "pass",
  claims: [
    {
      claimId: "claim_tests_passed",
      supported: true,
      evidenceRefs: [evidenceRef],
      mismatchIds: [],
    },
  ],
  approvedClaimIds: ["claim_tests_passed"],
  rejectedClaimIds: [],
  blockingMismatches: [],
  evaluatedClaims: [testClaim],
} satisfies ProofObject;

const releasedDecision = {
  status: "released",
  runId: "run_001",
  proofId: "proof_001",
  approvedClaimIds: ["claim_tests_passed"],
  blockingMismatchIds: [],
  finalMessage: "Contracts are valid.",
} satisfies ReleasedDecision;

const finalReleasedEvent = {
  eventId: "event_final_released_001",
  runId: "run_001",
  sequence: 8,
  type: "FinalReleased",
  payload: {
    decision: releasedDecision,
    candidate: finalCandidate,
  },
  payloadHash: canonicalHash({
    decision: releasedDecision,
    candidate: finalCandidate,
  }),
  causationId: "event_release_decided_001",
  correlationId: "run_001",
  occurredAt: observedAt,
} satisfies RunEvent<"FinalReleased">;

describe("v0 protocol schemas", () => {
  it("accepts the locked v0 protocol surface", () => {
    expect(validateToolCommandRequest(toolCommandRequest).success).toBe(true);
    expect(validateEffectRequest(effectRequest).success).toBe(true);
    expect(
      validateWritePreflightCandidate(writePreflightCandidate).success,
    ).toBe(true);
    expect(validateWritePreflightDecision(writePreflightDecision).success).toBe(
      true,
    );
    expect(validateWriteQuarantineState(writeQuarantineState).success).toBe(
      true,
    );
    expect(validateRunEvent(writePreflightRequestedEvent).success).toBe(true);
    expect(validateRunEvent(writePreflightDecidedEvent).success).toBe(true);
    expect(validateRunEvent(writeQuarantinedEvent).success).toBe(true);
    expect(validateEffectReceipt(effectReceipt).success).toBe(true);
    expect(
      validateExternalStateObservation(externalStateObservation).success,
    ).toBe(true);
    expect(validateEvidenceRef(evidenceRef).success).toBe(true);
    expect(validateFinalCandidate(finalCandidate).success).toBe(true);
    expect(validateClaim(testClaim).success).toBe(true);
    expect(validateClaimPredicate(testPredicate).success).toBe(true);
    expect(validateProofObject(proofObject).success).toBe(true);
    expect(validateMismatch(mismatch).success).toBe(true);
    expect(validateReleaseDecision(releasedDecision).success).toBe(true);
    expect(validateRunEvent(finalReleasedEvent).success).toBe(true);
  });

  it("fails closed on unknown fields at strict protocol boundaries", () => {
    const evidenceIssues = expectInvalid(
      validateEvidenceRef({ ...evidenceRef, unexpected: "field" }),
    );
    expect(
      evidenceIssues.some((issue) => issue.code === "unrecognized_keys"),
    ).toBe(true);

    const claimIssues = expectInvalid(
      validateClaim({
        ...testClaim,
        predicate: { ...testPredicate, unexpected: "field" },
      }),
    );
    expect(claimIssues.length).toBeGreaterThan(0);

    const preflightEventIssues = expectInvalid(
      validateRunEvent({
        ...writePreflightRequestedEvent,
        payload: {
          candidate: {
            ...writePreflightCandidate,
            unexpected: "field",
          },
        },
      }),
    );
    expect(
      preflightEventIssues.some((issue) => issue.code === "unrecognized_keys"),
    ).toBe(true);
  });

  it("fails closed on malformed semantic fields", () => {
    expectInvalid(
      validateEvidenceRef({
        ...evidenceRef,
        hash: "not-a-sha256-digest",
      }),
    );
    expectInvalid(
      validateEvidenceRef({
        ...evidenceRef,
        observedAt: "not-an-iso-datetime",
      }),
    );
    expectInvalid(
      validateClaim({
        ...currentStateClaim,
        predicate: {
          ...currentStatePredicate,
          freshnessRequirementMs: "300000",
        },
      }),
    );
    expectInvalid(
      validateClaim({
        ...currentStateClaim,
        predicate: {
          ...currentStatePredicate,
          expectedValue: { value: "passed" },
        },
      }),
    );
    expectInvalid(
      validateClaim({
        ...testClaim,
        type: "current_state",
      }),
    );
    expectInvalid(
      validateWritePreflightCandidate({
        ...writePreflightCandidate,
        sideEffectClass: "read",
      }),
    );
    expectInvalid(
      validateRunEvent({
        ...writeQuarantinedEvent,
        payload: {
          quarantine: {
            ...writeQuarantineState,
            status: "released",
          },
        },
      }),
    );
  });

  it("pending-evidence-has-no-source-event-id", () => {
    const result = PendingEvidenceRefSchema.safeParse(pendingEvidenceRef);

    expect(result.success).toBe(true);

    if (!result.success) {
      throw new Error("Expected pending evidence to parse");
    }

    expect(Object.hasOwn(result.data, "sourceEventId")).toBe(false);
  });

  it("pending evidence requires a pending admission token", () => {
    const result = PendingEvidenceRefSchema.safeParse({
      admissionStatus: "pending",
      evidenceId: pendingEvidenceRef.evidenceId,
      kind: pendingEvidenceRef.kind,
      hash: pendingEvidenceRef.hash,
      observedAt: pendingEvidenceRef.observedAt,
      sensitivity: pendingEvidenceRef.sensitivity,
    });

    expect(result.success).toBe(false);
  });

  it("pending-evidence-with-source-event-id-rejected", () => {
    const result = PendingEvidenceRefSchema.safeParse({
      ...pendingEvidenceRef,
      sourceEventId: "event_receipt_001",
    });

    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error("Expected pending evidence with sourceEventId to fail");
    }

    expect(
      result.error.issues.some((issue) => issue.code === "unrecognized_keys"),
    ).toBe(true);
  });

  it("admitted-evidence-without-source-event-id-rejected", () => {
    expectInvalid(
      validateEvidenceRef({
        evidenceId: evidenceRef.evidenceId,
        kind: evidenceRef.kind,
        hash: evidenceRef.hash,
        observedAt: evidenceRef.observedAt,
        sensitivity: evidenceRef.sensitivity,
      }),
    );
  });

  it("candidate schemas parse pending evidence", () => {
    const receiptResult = ReceiptCandidateSchema.safeParse(receiptCandidate);
    const observationResult = ExternalStateObservationCandidateSchema.safeParse(
      externalStateObservationCandidate,
    );

    expect(receiptResult.success).toBe(true);
    expect(observationResult.success).toBe(true);
  });

  it("EffectReceipt/ExternalStateObservation/Claim reject pending evidence", () => {
    expectInvalid(
      validateEffectReceipt({
        ...effectReceipt,
        evidence: [pendingEvidenceRef],
      }),
    );
    expectInvalid(
      validateExternalStateObservation({
        ...externalStateObservation,
        evidence: [pendingEvidenceRef],
      }),
    );
    expectInvalid(
      validateClaim({
        ...testClaim,
        evidenceRefs: [pendingEvidenceRef],
      }),
    );
  });

  it("ProofObject rejects pending evidence", () => {
    const [claimProof] = proofObject.claims;
    if (claimProof === undefined) {
      throw new Error("Proof fixture must include a claim proof.");
    }

    expectInvalid(
      validateProofObject({
        ...proofObject,
        claims: [
          {
            ...claimProof,
            evidenceRefs: [pendingEvidenceRef],
          },
        ],
      }),
    );
  });

  it("preflight-decision-schema-rejects-unknown-status", () => {
    const issues = expectInvalid(
      validateWritePreflightDecision({
        ...writePreflightDecision,
        status: "executed",
      }),
    );

    expect(issues.length).toBeGreaterThan(0);
  });

  it("preflight/quarantine RunEvent payloads reject malformed shapes", () => {
    expectInvalid(
      validateRunEvent({
        ...writePreflightDecidedEvent,
        payload: {
          decision: {
            ...writePreflightDecision,
            status: "executed",
          },
        },
      }),
    );
    expectInvalid(
      validateRunEvent({
        ...writeQuarantinedEvent,
        payload: {
          quarantine: {
            ...writeQuarantineState,
            receiptId: "receipt_forbidden",
          },
        },
      }),
    );
    expect(
      validateWritePreflightDecision(quarantinedWritePreflightDecision),
    ).toMatchObject({
      success: true,
    });
  });

  it("write quarantine state is not receipt or evidence", () => {
    expect(validateWriteQuarantineState(writeQuarantineState).success).toBe(
      true,
    );
    expectInvalid(validateEffectReceipt(writeQuarantineState));
    expectInvalid(validateEvidenceRef(writeQuarantineState));
  });
});

function expectInvalid<T>(
  result: ContractValidationResult<T>,
): readonly ContractValidationIssue[] {
  expect(result.success).toBe(false);

  if (result.success) {
    throw new Error("Expected validation to fail");
  }

  return result.issues;
}
