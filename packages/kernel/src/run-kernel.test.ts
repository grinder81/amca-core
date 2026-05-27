import { canonicalObjectHash, validateRunEvent } from "@amca/contracts";
import type {
  Claim,
  CurrentStatePredicate,
  EffectReceipt,
  EffectRequest,
  EffectStatus,
  EvidenceRef,
  ExternalStateObservation,
  FinalCandidate,
  HistoricalActionPredicate,
  JsonObject,
  RunEventType,
  Sha256Hash,
  TestResultPredicate,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { InMemoryRunKernel, RunKernelError } from "./index.js";

const STARTED_AT = "2026-05-24T11:58:00.000Z";
const GENERATED_AT = "2026-05-24T12:00:00.000Z";
const FRESH_OBSERVED_AT = "2026-05-24T11:59:30.000Z";
const STALE_OBSERVED_AT = "2026-05-24T11:00:00.000Z";
const EXPIRES_AT = "2026-05-24T12:05:00.000Z";
const BAD_HASH =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" satisfies Sha256Hash;

describe("InMemoryRunKernel", () => {
  it("blocks a tests-passed final claim without a test receipt", () => {
    const runId = "run_phase_09_tests_blocked";
    const kernel = startedKernel(runId);
    const claim = testResultClaim({ evidenceRefs: [] });

    const result = kernel.submitFinalCandidate(candidateWith(runId, claim), {
      occurredAt: GENERATED_AT,
      generatedAt: GENERATED_AT,
    });

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.verdict).toBe("fail");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
    expect(eventTypes(kernel)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "ProofGenerated",
      "MismatchDetected",
      "ReleaseDecided",
    ]);
    expect(result.finalReleasedEvent).toBeUndefined();
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("releases a tests-passed final claim with a matching test receipt", () => {
    const runId = "run_phase_09_tests_released";
    const receiptEventId = "evt_receipt_tests_released";
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_test_receipt",
      canonicalObjectHash(payload),
      {
        sourceEventId: receiptEventId,
      },
    );
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(testRunEffectRequest(runId));
    kernel.recordEffectReceipt(
      testRunReceipt(runId, {
        evidence: [evidenceRef],
        payload,
      }),
      {
        eventId: receiptEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );

    const result = kernel.submitFinalCandidate(
      candidateWith(runId, testResultClaim({ evidenceRefs: [evidenceRef] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(result.decision).toMatchObject({
      status: "released",
      approvedClaimIds: ["claim_tests_passed"],
      blockingMismatchIds: [],
      finalMessage: "Tests passed.",
    });
    expect(eventTypes(kernel)).toEqual([
      "RunStarted",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
    expect(result.finalReleasedEvent?.payload.decision.status).toBe("released");
  });

  it("blocks a PR historical-action claim when the referenced receipt failed", () => {
    const runId = "run_phase_09_failed_pr_receipt";
    const receiptEventId = "evt_receipt_pr_failed";
    const evidenceRef = effectEvidenceRef(
      "ev_failed_pr_receipt",
      canonicalObjectHash(pullRequestPayload()),
      {
        sourceEventId: receiptEventId,
      },
    );
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(pullRequestEffectRequest(runId));
    kernel.recordEffectReceipt(
      pullRequestReceipt(runId, {
        evidence: [evidenceRef],
        status: "failed",
      }),
      {
        eventId: receiptEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );

    const claim = historicalActionClaim({ evidenceRefs: [evidenceRef] });
    const result = kernel.submitFinalCandidate(candidateWith(runId, claim), {
      occurredAt: GENERATED_AT,
      generatedAt: GENERATED_AT,
    });

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
    expect(eventTypes(kernel)).toContain("MismatchDetected");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("releases a current-state claim with a fresh external observation", () => {
    const runId = "run_phase_09_fresh_state";
    const observationEventId = "evt_observation_pr_fresh";
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_fresh_pr_state",
      canonicalObjectHash(observedState),
      {
        sourceEventId: observationEventId,
      },
    );
    const kernel = startedKernel(runId);

    kernel.recordExternalStateObservation(
      pullRequestStateObservation(runId, {
        evidence: [evidenceRef],
        observedAt: FRESH_OBSERVED_AT,
        observedState,
      }),
      {
        eventId: observationEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );

    const result = kernel.submitFinalCandidate(
      candidateWith(runId, currentStateClaim({ evidenceRefs: [evidenceRef] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(result.decision.status).toBe("released");
    expect(eventTypes(kernel)).toEqual([
      "RunStarted",
      "ExternalStateObserved",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
  });

  it("blocks a current-state claim with a stale external observation", () => {
    const runId = "run_phase_09_stale_state";
    const observationEventId = "evt_observation_pr_stale";
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_stale_pr_state",
      canonicalObjectHash(observedState),
      {
        sourceEventId: observationEventId,
      },
    );
    const kernel = startedKernel(runId);

    kernel.recordExternalStateObservation(
      pullRequestStateObservation(runId, {
        evidence: [evidenceRef],
        observedAt: STALE_OBSERVED_AT,
        observedState,
      }),
      {
        eventId: observationEventId,
        occurredAt: STALE_OBSERVED_AT,
      },
    );

    const claim = currentStateClaim({ evidenceRefs: [evidenceRef] });
    const result = kernel.submitFinalCandidate(candidateWith(runId, claim), {
      occurredAt: GENERATED_AT,
      generatedAt: GENERATED_AT,
    });

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "stale_external_state",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("never emits FinalReleased without a released decision", () => {
    const runId = "run_phase_09_no_final_release_without_decision";
    const kernel = startedKernel(runId);

    const result = kernel.submitFinalCandidate(
      candidateWith(runId, testResultClaim({ evidenceRefs: [] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(result.decision.status).not.toBe("released");
    expect(
      kernel.events().filter((event) => event.type === "FinalReleased"),
    ).toEqual([]);
  });

  it("writes a contiguous replayable event sequence", () => {
    const runId = "run_phase_09_replayable";
    const receiptEventId = "evt_receipt_replayable";
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_replayable_test_receipt",
      canonicalObjectHash(payload),
      {
        sourceEventId: receiptEventId,
      },
    );
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(testRunEffectRequest(runId));
    kernel.recordEffectReceipt(
      testRunReceipt(runId, {
        evidence: [evidenceRef],
        payload,
      }),
      {
        eventId: receiptEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );
    const result = kernel.submitFinalCandidate(
      candidateWith(runId, testResultClaim({ evidenceRefs: [evidenceRef] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    const replayed = kernel.replay();
    expect(replayed.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(replayed.map((event) => validateRunEvent(event).success)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(result.finalReleasedEvent?.causationId).toBe(
      result.releaseEvent.eventId,
    );
  });

  it("records write preflight and quarantine as replayable authority events", () => {
    const runId = "run_phase_44_preflight_quarantine_events";
    const kernel = startedKernel(runId);
    const candidate = writePreflightCandidate(runId);
    const requested = kernel.recordWritePreflightRequested(candidate, {
      eventId: "evt_write_preflight_requested",
      occurredAt: FRESH_OBSERVED_AT,
      correlationId: "corr_write_preflight",
    });
    const quarantine = writeQuarantineState(runId);
    const decision = quarantinedWritePreflightDecision(runId, quarantine);
    const decided = kernel.recordWritePreflightDecided(decision, {
      eventId: "evt_write_preflight_decided",
      causationId: requested.eventId,
      occurredAt: FRESH_OBSERVED_AT,
      correlationId: "corr_write_preflight",
    });
    const quarantined = kernel.recordWriteQuarantined(quarantine, {
      eventId: "evt_write_quarantined",
      causationId: decided.eventId,
      occurredAt: FRESH_OBSERVED_AT,
      correlationId: "corr_write_preflight",
    });

    expect(eventTypes(kernel)).toEqual([
      "RunStarted",
      "WritePreflightRequested",
      "WritePreflightDecided",
      "WriteQuarantined",
    ]);
    expect(kernel.writePreflightCandidates()).toEqual([candidate]);
    expect(kernel.writePreflightDecisions()).toEqual([decision]);
    expect(kernel.writeQuarantineStates()).toEqual([quarantine]);
    expect(requested.payloadHash).toBe(
      canonicalObjectHash(requested.payload as unknown as JsonObject),
    );
    expect(decided.causationId).toBe(requested.eventId);
    expect(quarantined.causationId).toBe(decided.eventId);
    expect(kernel.replay().map((event) => event.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      kernel.replay().map((event) => validateRunEvent(event).success),
    ).toEqual([true, true, true, true]);
  });

  it("fails closed for malformed preflight payloads and event metadata", () => {
    const runId = "run_phase_44_preflight_fail_closed";
    const kernel = startedKernel(runId);
    const candidate = writePreflightCandidate(runId);
    const eventCount = kernel.events().length;

    expect(() =>
      kernel.recordWritePreflightRequested({
        ...candidate,
        unexpected: "field",
      } as unknown as WritePreflightCandidate),
    ).toThrow();
    expect(kernel.events()).toHaveLength(eventCount);

    expectRunKernelError(
      () =>
        kernel.recordWritePreflightRequested(candidate, {
          payloadHash: BAD_HASH,
        }),
      "payload_hash_mismatch",
    );
    expect(kernel.events()).toHaveLength(eventCount);

    expectRunKernelError(
      () =>
        kernel.recordWritePreflightRequested(candidate, {
          correlationId: "",
        }),
      "invalid_correlation_id",
    );
    expect(kernel.events()).toHaveLength(eventCount);

    expectRunKernelError(
      () =>
        kernel.recordWritePreflightRequested(candidate, {
          causationId: "evt_missing_preflight_cause",
        }),
      "invalid_causation_id",
    );
    expect(kernel.events()).toHaveLength(eventCount);
  });

  it("rejects preflight decisions and quarantines that do not match recorded requests", () => {
    const runId = "run_phase_44_preflight_identity";
    const kernel = startedKernel(runId);
    const candidate = writePreflightCandidate(runId);
    const quarantine = writeQuarantineState(runId);
    const decision = quarantinedWritePreflightDecision(runId, quarantine);

    expectRunKernelError(
      () => kernel.recordWritePreflightDecided(decision),
      "write_preflight_request_not_found",
    );

    const requested = kernel.recordWritePreflightRequested(candidate, {
      eventId: "evt_preflight_identity_request",
    });
    expectRunKernelError(
      () =>
        kernel.recordWritePreflightDecided({
          ...decision,
          toolId: "ops.other_write",
          quarantine: {
            ...quarantine,
            toolId: "ops.other_write",
          },
        }),
      "write_preflight_mismatch",
    );

    const decided = kernel.recordWritePreflightDecided(decision, {
      eventId: "evt_preflight_identity_decision",
      causationId: requested.eventId,
    });
    expectRunKernelError(
      () =>
        kernel.recordWriteQuarantined(
          {
            ...quarantine,
            commandId: "command_other_write",
          },
          {
            causationId: decided.eventId,
          },
        ),
      "write_quarantine_mismatch",
    );
  });

  it("does not treat preflight quarantine events as successful receipts or release support", () => {
    const runId = "run_phase_44_quarantine_is_not_receipt";
    const kernel = startedKernel(runId);
    const candidate = writePreflightCandidate(runId);
    const requested = kernel.recordWritePreflightRequested(candidate, {
      eventId: "evt_quarantine_not_receipt_request",
    });
    const quarantine = writeQuarantineState(runId);
    const decision = quarantinedWritePreflightDecision(runId, quarantine);
    const decided = kernel.recordWritePreflightDecided(decision, {
      eventId: "evt_quarantine_not_receipt_decision",
      causationId: requested.eventId,
    });
    const quarantined = kernel.recordWriteQuarantined(quarantine, {
      eventId: "evt_quarantine_not_receipt",
      causationId: decided.eventId,
    });
    const forgedEvidence = effectEvidenceRef(
      "ev_quarantine_not_receipt",
      quarantined.payloadHash,
      {
        sourceEventId: quarantined.eventId,
      },
    );

    const result = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        historicalActionClaim({ evidenceRefs: [forgedEvidence] }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(eventTypes(kernel)).toContain("WriteQuarantined");
    expect(eventTypes(kernel)).not.toContain("EffectReceiptRecorded");
    expect(result.proof.verdict).toBe("fail");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: "claim_pr_opened",
      }),
    );
    expect(result.decision.status).toBe("blocked");
    expect(result.finalReleasedEvent).toBeUndefined();
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("rejects receipt evidence whose sourceEventId does not match the admitting event", () => {
    const runId = "run_phase_09_receipt_source_mismatch";
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));
    const payload = { result: "passed" };
    const receipt = testRunReceipt(runId, {
      evidence: [
        effectEvidenceRef("ev_wrong_source", canonicalObjectHash(payload), {
          sourceEventId: "evt_not_the_receipt_event",
        }),
      ],
      payload,
    });

    expect(() =>
      kernel.recordEffectReceipt(receipt, {
        eventId: "evt_receipt_expected",
        occurredAt: FRESH_OBSERVED_AT,
      }),
    ).toThrow(RunKernelError);

    try {
      kernel.recordEffectReceipt(receipt, {
        eventId: "evt_receipt_expected",
        occurredAt: FRESH_OBSERVED_AT,
      });
    } catch (error) {
      expect((error as RunKernelError).code).toBe(
        "evidence_source_event_mismatch",
      );
      return;
    }

    throw new Error("Expected evidence source event mismatch.");
  });

  it("rejects an effect receipt without a prior EffectRequested event", () => {
    const runId = "run_phase_09_receipt_without_request";
    const receiptEventId = "evt_receipt_without_request";
    const payload = { result: "passed" };
    const kernel = startedKernel(runId);
    const receipt = testRunReceipt(runId, {
      evidence: [
        effectEvidenceRef(
          "ev_receipt_without_request",
          canonicalObjectHash(payload),
          {
            sourceEventId: receiptEventId,
          },
        ),
      ],
      payload,
    });

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(receipt, {
          eventId: receiptEventId,
          occurredAt: FRESH_OBSERVED_AT,
        }),
      "effect_request_not_found",
    );
  });

  it("rejects an effect receipt admitted from another run", () => {
    const runId = "run_phase_09_cross_run_receipt";
    const receiptEventId = "evt_cross_run_receipt";
    const payload = { result: "passed" };
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));
    const receipt = testRunReceipt("run_other", {
      evidence: [
        effectEvidenceRef(
          "ev_cross_run_receipt",
          canonicalObjectHash(payload),
          {
            sourceEventId: receiptEventId,
          },
        ),
      ],
      payload,
    });

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(receipt, {
          eventId: receiptEventId,
          occurredAt: FRESH_OBSERVED_AT,
        }),
      "run_id_mismatch",
    );
  });

  it("rejects a receipt whose requested effect metadata does not match", () => {
    const runId = "run_phase_09_receipt_request_mismatch";
    const receiptEventId = "evt_receipt_request_mismatch";
    const payload = { result: "passed" };
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));
    const receipt = testRunReceipt(runId, {
      capabilityId: "shell.run_other_tests",
      evidence: [
        effectEvidenceRef(
          "ev_receipt_request_mismatch",
          canonicalObjectHash(payload),
          {
            sourceEventId: receiptEventId,
          },
        ),
      ],
      payload,
    });

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(receipt, {
          eventId: receiptEventId,
          occurredAt: FRESH_OBSERVED_AT,
        }),
      "effect_request_mismatch",
    );
  });

  it("rejects an effect receipt whose payloadHash does not match the payload", () => {
    const runId = "run_phase_09_receipt_payload_hash_mismatch";
    const receiptEventId = "evt_receipt_payload_hash_mismatch";
    const payload = { result: "passed" };
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));
    const receipt = testRunReceipt(runId, {
      evidence: [
        effectEvidenceRef("ev_payload_hash_mismatch", BAD_HASH, {
          sourceEventId: receiptEventId,
        }),
      ],
      payload,
      payloadHash: BAD_HASH,
    });

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(receipt, {
          eventId: receiptEventId,
          occurredAt: FRESH_OBSERVED_AT,
        }),
      "payload_hash_mismatch",
    );
  });

  it("rejects receipt evidence whose kind does not match the admitting event type", () => {
    const runId = "run_phase_09_receipt_evidence_kind_mismatch";
    const receiptEventId = "evt_receipt_kind_mismatch";
    const payload = { result: "passed" };
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));
    const receipt = testRunReceipt(runId, {
      evidence: [
        {
          ...effectEvidenceRef(
            "ev_kind_mismatch",
            canonicalObjectHash(payload),
            {
              sourceEventId: receiptEventId,
            },
          ),
          kind: "external_observation",
        },
      ],
      payload,
    });

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(receipt, {
          eventId: receiptEventId,
          occurredAt: FRESH_OBSERVED_AT,
        }),
      "evidence_kind_mismatch",
    );
  });

  it("rejects receipt evidence whose hash does not match the admitted payload", () => {
    const runId = "run_phase_09_receipt_evidence_hash_mismatch";
    const receiptEventId = "evt_receipt_hash_mismatch";
    const payload = { result: "passed" };
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));
    const receipt = testRunReceipt(runId, {
      evidence: [
        effectEvidenceRef("ev_hash_mismatch", BAD_HASH, {
          sourceEventId: receiptEventId,
        }),
      ],
      payload,
    });

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(receipt, {
          eventId: receiptEventId,
          occurredAt: FRESH_OBSERVED_AT,
        }),
      "evidence_hash_mismatch",
    );
  });

  it("rejects external observations whose evidence source event is missing", () => {
    const runId = "run_phase_09_observation_source_missing";
    const observationEventId = "evt_observation_source_missing";
    const observedState = { state: "open" };
    const kernel = startedKernel(runId);
    const observation = pullRequestStateObservation(runId, {
      evidence: [
        observationEvidenceRef(
          "ev_observation_source_missing",
          canonicalObjectHash(observedState),
          {
            sourceEventId: "evt_non_admitting_observation",
          },
        ),
      ],
      observedAt: FRESH_OBSERVED_AT,
      observedState,
    });

    expectRunKernelError(
      () =>
        kernel.recordExternalStateObservation(observation, {
          eventId: observationEventId,
          occurredAt: FRESH_OBSERVED_AT,
        }),
      "evidence_source_event_mismatch",
    );
  });
});

function startedKernel(runId: string): InMemoryRunKernel {
  const kernel = new InMemoryRunKernel({
    runId,
    clock: () => GENERATED_AT,
  });
  kernel.startRun({
    occurredAt: STARTED_AT,
    profile: "standard",
  });
  return kernel;
}

function eventTypes(kernel: InMemoryRunKernel): RunEventType[] {
  return kernel.events().map((event) => event.type);
}

function expectRunKernelError(
  operation: () => unknown,
  code: RunKernelError["code"],
): void {
  expect(operation).toThrow(RunKernelError);

  try {
    operation();
  } catch (error) {
    expect((error as RunKernelError).code).toBe(code);
    return;
  }

  throw new Error(`Expected RunKernelError with code ${code}.`);
}

function candidateWith(runId: string, claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${claim.claimId}`,
    runId,
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

interface EvidenceRefOptions {
  readonly sourceEventId: string;
  readonly observedAt?: string;
}

function effectEvidenceRef(
  evidenceId: string,
  hash: Sha256Hash,
  options: EvidenceRefOptions,
): EvidenceRef {
  return {
    evidenceId,
    kind: "effect_receipt",
    sourceEventId: options.sourceEventId,
    hash,
    observedAt: options.observedAt ?? FRESH_OBSERVED_AT,
    sensitivity: "internal",
  };
}

function observationEvidenceRef(
  evidenceId: string,
  hash: Sha256Hash,
  options: EvidenceRefOptions,
): EvidenceRef {
  return {
    evidenceId,
    kind: "external_observation",
    sourceEventId: options.sourceEventId,
    hash,
    observedAt: options.observedAt ?? FRESH_OBSERVED_AT,
    sensitivity: "internal",
  };
}

interface TestRunReceiptOptions {
  readonly evidence: readonly EvidenceRef[];
  readonly payload: JsonObject;
  readonly capabilityId?: string;
  readonly payloadHash?: Sha256Hash;
}

function testRunReceipt(
  runId: string,
  options: TestRunReceiptOptions,
): EffectReceipt {
  return {
    receiptId: "receipt_test_001",
    effectId: "effect_test_001",
    runId,
    capabilityId: options.capabilityId ?? "shell.run_tests",
    receiptType: "test_run",
    status: "succeeded",
    payload: options.payload,
    payloadHash: options.payloadHash ?? canonicalObjectHash(options.payload),
    evidence: [...options.evidence],
    observedAt: FRESH_OBSERVED_AT,
  };
}

interface PullRequestReceiptOptions {
  readonly evidence: readonly EvidenceRef[];
  readonly status: EffectStatus;
}

function pullRequestReceipt(
  runId: string,
  options: PullRequestReceiptOptions,
): EffectReceipt {
  const payload = pullRequestPayload();

  return {
    receiptId: "receipt_pr_001",
    effectId: "effect_pr_001",
    runId,
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

function testRunEffectRequest(runId: string): EffectRequest {
  return {
    effectId: "effect_test_001",
    commandId: "command_test_001",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    requestedAt: FRESH_OBSERVED_AT,
  };
}

function pullRequestEffectRequest(runId: string): EffectRequest {
  return {
    effectId: "effect_pr_001",
    commandId: "command_pr_001",
    runId,
    capabilityId: "github.create_pull_request",
    toolId: "github.create_pull_request",
    args: {
      targetType: "pull_request",
      targetId: "123",
    },
    sideEffectClass: "idempotent_write",
    requestedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:pull_request:123`,
  };
}

function writePreflightCandidate(runId: string): WritePreflightCandidate {
  return {
    kind: "write_preflight_candidate",
    preflightId: "preflight_write_001",
    runId,
    commandId: "command_write_001",
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    argsHash: canonicalObjectHash({
      targetType: "protected_resource",
      targetId: "critical_001",
    }),
    requestedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}

function writeQuarantineState(runId: string): WriteQuarantineState {
  return {
    kind: "write_quarantine_state",
    quarantineId: "quarantine_write_001",
    runId,
    preflightId: "preflight_write_001",
    commandId: "command_write_001",
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    status: "quarantined",
    reason: "critical_approval_required",
    message: "Critical writes require a later approval phase.",
    quarantinedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}

function quarantinedWritePreflightDecision(
  runId: string,
  quarantine: WriteQuarantineState,
): Extract<WritePreflightDecision, { status: "quarantined" }> {
  return {
    kind: "write_preflight_decision",
    status: "quarantined",
    runId,
    preflightId: "preflight_write_001",
    commandId: "command_write_001",
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    quarantine,
    decidedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:critical_write:001`,
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
}

function pullRequestStateObservation(
  runId: string,
  options: PullRequestStateObservationOptions,
): ExternalStateObservation {
  return {
    observationId: "observation_pr_state_001",
    runId,
    observationType: "github.pull_request_state",
    subjectType: "pull_request",
    subjectId: "123",
    observedState: options.observedState,
    observedAt: options.observedAt,
    expiresAt: EXPIRES_AT,
    payloadHash: canonicalObjectHash(options.observedState),
    evidence: [...options.evidence],
  };
}
