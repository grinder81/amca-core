import type {
  Claim,
  CurrentStatePredicate,
  EffectReceipt,
  EffectStatus,
  EvidenceRef,
  ExternalStateObservation,
  FinalCandidate,
  HistoricalActionPredicate,
  JsonObject,
  Sha256Hash,
  TestResultPredicate,
} from "@amca/protocol";
import { canonicalObjectHash } from "@amca/contracts";
import { describe, expect, it } from "vitest";

import { evaluateProof } from "./proof-engine.js";

const GENERATED_AT = "2026-05-24T12:00:00.000Z";
const FRESH_OBSERVED_AT = "2026-05-24T11:59:30.000Z";
const STALE_OBSERVED_AT = "2026-05-24T11:00:00.000Z";
const EXPIRES_AT = "2026-05-24T12:05:00.000Z";
const UNKNOWN_RECEIPT_HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" satisfies Sha256Hash;

describe("evaluateProof", () => {
  it("blocks an unsupported tests-passed claim without test receipt evidence", () => {
    const claim = testResultClaim({ evidenceRefs: [] });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.approvedClaimIds).toEqual([]);
    expect(proof.rejectedClaimIds).toEqual([claim.claimId]);
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
    expect(proof.claims).toContainEqual(
      expect.objectContaining({
        claimId: claim.claimId,
        supported: false,
      }),
    );
  });

  it("passes a test-result claim with a matching succeeded test receipt", () => {
    const payload = {
      result: "passed",
    };
    const evidenceRef = effectEvidenceRef(
      "ev_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("pass");
    expect(proof.approvedClaimIds).toEqual([claim.claimId]);
    expect(proof.rejectedClaimIds).toEqual([]);
    expect(proof.blockingMismatches).toEqual([]);
    expect(proof.claims).toContainEqual({
      claimId: claim.claimId,
      supported: true,
      evidenceRefs: [evidenceRef],
      mismatchIds: [],
    });
  });

  it("blocks a test-result claim when the optional test suite id mismatches", () => {
    const payload = {
      result: "passed",
      testSuiteId: "integration",
    };
    const evidenceRef = effectEvidenceRef(
      "ev_test_suite_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({
      evidenceRefs: [evidenceRef],
      testSuiteId: "unit",
    });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a historical PR action claim when the referenced PR receipt failed", () => {
    const evidenceRef = effectEvidenceRef(
      "ev_pr_receipt",
      canonicalObjectHash(pullRequestPayload()),
    );
    const claim = historicalActionClaim({ evidenceRefs: [evidenceRef] });
    const receipt = pullRequestReceipt({
      evidence: [evidenceRef],
      status: "failed",
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.approvedClaimIds).toEqual([]);
    expect(proof.rejectedClaimIds).toEqual([claim.claimId]);
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("passes a historical PR action claim with a matching succeeded PR receipt", () => {
    const evidenceRef = effectEvidenceRef(
      "ev_pr_receipt",
      canonicalObjectHash(pullRequestPayload()),
    );
    const claim = historicalActionClaim({ evidenceRefs: [evidenceRef] });
    const receipt = pullRequestReceipt({
      evidence: [evidenceRef],
      status: "succeeded",
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("pass");
    expect(proof.approvedClaimIds).toEqual([claim.claimId]);
    expect(proof.rejectedClaimIds).toEqual([]);
    expect(proof.blockingMismatches).toEqual([]);
  });

  it("blocks a current-state claim when the matching observation is stale", () => {
    const observedState = {
      state: "open",
    };
    const evidenceRef = observationEvidenceRef(
      "ev_pr_state",
      canonicalObjectHash(observedState),
    );
    const claim = currentStateClaim({ evidenceRefs: [evidenceRef] });
    const observation = pullRequestStateObservation({
      evidence: [evidenceRef],
      observedAt: STALE_OBSERVED_AT,
      observedState,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [observation],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.approvedClaimIds).toEqual([]);
    expect(proof.rejectedClaimIds).toEqual([claim.claimId]);
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "stale_external_state",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("passes a current-state claim with a matching fresh observation", () => {
    const observedState = {
      state: "open",
    };
    const evidenceRef = observationEvidenceRef(
      "ev_pr_state",
      canonicalObjectHash(observedState),
    );
    const claim = currentStateClaim({ evidenceRefs: [evidenceRef] });
    const observation = pullRequestStateObservation({
      evidence: [evidenceRef],
      observedAt: FRESH_OBSERVED_AT,
      observedState,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [observation],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("pass");
    expect(proof.approvedClaimIds).toEqual([claim.claimId]);
    expect(proof.rejectedClaimIds).toEqual([]);
    expect(proof.blockingMismatches).toEqual([]);
  });

  it("uses structured predicates and does not interpret Claim.statement", () => {
    const payload = {
      result: "passed",
    };
    const evidenceRef = effectEvidenceRef(
      "ev_statement_irrelevant",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({
      evidenceRefs: [evidenceRef],
      statement: "Tests failed.",
    });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("pass");
    expect(proof.approvedClaimIds).toEqual([claim.claimId]);
  });

  it("blocks an effect receipt claim when referenced evidence cannot be resolved", () => {
    const evidenceRef = effectEvidenceRef(
      "ev_missing_receipt",
      UNKNOWN_RECEIPT_HASH,
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a claim when a matching receipt exists but the claim has no evidence ref", () => {
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_unreferenced_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [] });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a claim that references a receipt evidence ref not admitted by the receipt", () => {
    const payload = { result: "passed" };
    const admittedEvidenceRef = effectEvidenceRef(
      "ev_admitted_test_receipt",
      canonicalObjectHash(payload),
    );
    const wrongEvidenceRef = effectEvidenceRef(
      "ev_wrong_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [wrongEvidenceRef] });
    const receipt = testRunReceipt({
      evidence: [admittedEvidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a test claim that references an unrelated valid PR receipt", () => {
    const evidenceRef = effectEvidenceRef(
      "ev_unrelated_pr_receipt",
      canonicalObjectHash(pullRequestPayload()),
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = pullRequestReceipt({
      evidence: [evidenceRef],
      status: "succeeded",
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a claim that references a receipt from a different run", () => {
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_cross_run_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
      runId: "run_other",
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a referenced receipt whose admitted evidence hash is invalid", () => {
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_bad_hash_test_receipt",
      UNKNOWN_RECEIPT_HASH,
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a test receipt whose payload result contradicts the claim", () => {
    const payload = { result: "failed" };
    const evidenceRef = effectEvidenceRef(
      "ev_failed_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a test receipt from the wrong capability", () => {
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_wrong_capability_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = testRunReceipt({
      capabilityId: "shell.run_other_tests",
      evidence: [evidenceRef],
      payload,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a test receipt with the wrong receipt type", () => {
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_wrong_type_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
      receiptType: "test_log",
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a test receipt with unknown effect status", () => {
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_unknown_status_test_receipt",
      canonicalObjectHash(payload),
    );
    const claim = testResultClaim({ evidenceRefs: [evidenceRef] });
    const receipt = testRunReceipt({
      evidence: [evidenceRef],
      payload,
      status: "unknown",
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [receipt],
      externalStateObservations: [],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a current-state claim when the fresh value mismatches", () => {
    const observedState = { state: "closed" };
    const evidenceRef = observationEvidenceRef(
      "ev_pr_state_value_mismatch",
      canonicalObjectHash(observedState),
    );
    const claim = currentStateClaim({ evidenceRefs: [evidenceRef] });
    const observation = pullRequestStateObservation({
      evidence: [evidenceRef],
      observedAt: FRESH_OBSERVED_AT,
      observedState,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [observation],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("blocks a current-state claim when the fresh observation has the wrong subject", () => {
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_pr_state_wrong_subject",
      canonicalObjectHash(observedState),
    );
    const claim = currentStateClaim({ evidenceRefs: [evidenceRef] });
    const observation = pullRequestStateObservation({
      evidence: [evidenceRef],
      observedAt: FRESH_OBSERVED_AT,
      observedState,
      subjectId: "456",
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [observation],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });

  it("treats a current-state observation exactly at the freshness boundary as fresh", () => {
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_pr_state_boundary",
      canonicalObjectHash(observedState),
    );
    const claim = currentStateClaim({ evidenceRefs: [evidenceRef] });
    const observation = pullRequestStateObservation({
      evidence: [evidenceRef],
      observedAt: "2026-05-24T11:59:00.000Z",
      observedState,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [observation],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("pass");
    expect(proof.approvedClaimIds).toEqual([claim.claimId]);
  });

  it("blocks a current-state observation from the future", () => {
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_pr_state_future",
      canonicalObjectHash(observedState),
    );
    const claim = currentStateClaim({ evidenceRefs: [evidenceRef] });
    const observation = pullRequestStateObservation({
      evidence: [evidenceRef],
      observedAt: "2026-05-24T12:00:01.000Z",
      observedState,
    });

    const proof = evaluateProof({
      candidate: candidateWith(claim),
      effectReceipts: [],
      externalStateObservations: [observation],
      generatedAt: GENERATED_AT,
    });

    expect(proof.verdict).toBe("fail");
    expect(proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "stale_external_state",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
  });
});

function candidateWith(claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${claim.claimId}`,
    runId: "run_001",
    claims: [claim],
  };
}

interface TestResultClaimOptions {
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly statement?: string;
  readonly expectedStatus?: TestResultPredicate["expectedStatus"];
  readonly testSuiteId?: string;
}

function testResultClaim(options: TestResultClaimOptions): Claim {
  const expectedStatus = options.expectedStatus ?? "passed";
  const predicate: TestResultPredicate = {
    kind: "test_result",
    capabilityId: "shell.run_tests",
    expectedStatus,
    requiredReceiptType: "test_run",
    ...(options.testSuiteId === undefined
      ? {}
      : { testSuiteId: options.testSuiteId }),
  };

  return {
    claimId: "claim_tests_passed",
    type: "test_result",
    statement: options.statement ?? "Tests passed.",
    predicate,
    evidenceRefs: [...options.evidenceRefs],
    criticality: "medium",
  };
}

interface HistoricalActionClaimOptions {
  readonly evidenceRefs: readonly EvidenceRef[];
}

function historicalActionClaim(options: HistoricalActionClaimOptions): Claim {
  const predicate: HistoricalActionPredicate = {
    kind: "historical_action",
    actionVerb: "created",
    subjectType: "agent",
    subjectId: "agent_001",
    targetType: "pull_request",
    targetId: "123",
    capabilityId: "github.create_pull_request",
    requiredReceiptType: "github.pull_request_created",
  };

  return {
    claimId: "claim_pr_opened",
    type: "historical_action",
    statement: "I opened PR #123.",
    predicate,
    evidenceRefs: [...options.evidenceRefs],
    criticality: "medium",
  };
}

interface CurrentStateClaimOptions {
  readonly evidenceRefs: readonly EvidenceRef[];
}

function currentStateClaim(options: CurrentStateClaimOptions): Claim {
  const predicate: CurrentStatePredicate = {
    kind: "current_state",
    subjectType: "pull_request",
    subjectId: "123",
    property: "state",
    operator: "equals",
    expectedValue: "open",
    observationType: "github.pull_request_state",
    freshnessRequirementMs: 60_000,
  };

  return {
    claimId: "claim_pr_currently_open",
    type: "current_state",
    statement: "PR #123 is currently open.",
    predicate,
    evidenceRefs: [...options.evidenceRefs],
    criticality: "medium",
  };
}

function effectEvidenceRef(evidenceId: string, hash: Sha256Hash): EvidenceRef {
  return {
    evidenceId,
    kind: "effect_receipt",
    sourceEventId: `event_${evidenceId}`,
    hash,
    observedAt: FRESH_OBSERVED_AT,
    sensitivity: "internal",
  };
}

function observationEvidenceRef(
  evidenceId: string,
  hash: Sha256Hash,
): EvidenceRef {
  return {
    evidenceId,
    kind: "external_observation",
    sourceEventId: `event_${evidenceId}`,
    hash,
    observedAt: FRESH_OBSERVED_AT,
    sensitivity: "internal",
  };
}

interface TestRunReceiptOptions {
  readonly evidence: readonly EvidenceRef[];
  readonly payload: JsonObject;
  readonly capabilityId?: string;
  readonly receiptType?: string;
  readonly runId?: string;
  readonly status?: EffectStatus;
}

function testRunReceipt(options: TestRunReceiptOptions): EffectReceipt {
  return {
    receiptId: "receipt_test_001",
    effectId: "effect_test_001",
    runId: options.runId ?? "run_001",
    capabilityId: options.capabilityId ?? "shell.run_tests",
    receiptType: options.receiptType ?? "test_run",
    status: options.status ?? "succeeded",
    payload: options.payload,
    payloadHash: canonicalObjectHash(options.payload),
    evidence: [...options.evidence],
    observedAt: FRESH_OBSERVED_AT,
  };
}

interface PullRequestReceiptOptions {
  readonly evidence: readonly EvidenceRef[];
  readonly status: EffectStatus;
}

function pullRequestReceipt(options: PullRequestReceiptOptions): EffectReceipt {
  const payload = pullRequestPayload();

  return {
    receiptId: "receipt_pr_001",
    effectId: "effect_pr_001",
    runId: "run_001",
    capabilityId: "github.create_pull_request",
    receiptType: "github.pull_request_created",
    status: options.status,
    payload,
    payloadHash: canonicalObjectHash(payload),
    evidence: [...options.evidence],
    observedAt: FRESH_OBSERVED_AT,
    externalRef: "https://github.example/pr/123",
  };
}

function pullRequestPayload(): JsonObject {
  return {
    actionVerb: "created",
    subjectType: "agent",
    subjectId: "agent_001",
    targetType: "pull_request",
    targetId: "123",
  };
}

interface PullRequestStateObservationOptions {
  readonly evidence: readonly EvidenceRef[];
  readonly observedAt: string;
  readonly observedState: JsonObject;
  readonly subjectId?: string;
  readonly subjectType?: string;
}

function pullRequestStateObservation(
  options: PullRequestStateObservationOptions,
): ExternalStateObservation {
  return {
    observationId: "observation_pr_state_001",
    runId: "run_001",
    observationType: "github.pull_request_state",
    subjectType: options.subjectType ?? "pull_request",
    subjectId: options.subjectId ?? "123",
    observedState: options.observedState,
    observedAt: options.observedAt,
    expiresAt: EXPIRES_AT,
    payloadHash: canonicalObjectHash(options.observedState),
    evidence: [...options.evidence],
  };
}
