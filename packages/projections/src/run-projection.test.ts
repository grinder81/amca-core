import { canonicalHash } from "@amca/contracts";
import type {
  Claim,
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  ExternalStateObservation,
  FinalCandidate,
  JsonObject,
  JsonValue,
  Mismatch,
  ProofObject,
  ReleaseDecision,
  RunEvent,
  RunEventPayloadByType,
  RunEventType,
  Sha256Hash,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import {
  ProjectionError,
  rebuildRunProjection,
  validateAcceptedEventSequence,
} from "./run-projection.js";

const runId = "run_projection_001";
const occurredAt = "2026-05-24T00:00:00.000Z";
const laterAt = "2026-05-24T00:01:00.000Z";

describe("rebuildRunProjection", () => {
  it("deterministically rebuilds run read models from accepted events", () => {
    const events = fullReleasedRunEvents();

    const firstProjection = rebuildRunProjection(events);
    const secondProjection = rebuildRunProjection(events);

    expect(firstProjection).toEqual(secondProjection);
    expect(firstProjection.summary).toMatchObject({
      runId,
      status: "released",
      eventCount: events.length,
      lastSequence: events.length,
      finalReleased: true,
      profile: "standard",
    });
    expect(firstProjection.eventIds).toEqual(
      events.map((event) => event.eventId),
    );
    expect(firstProjection.effectRequests).toHaveLength(1);
    expect(firstProjection.receipts).toHaveLength(1);
    expect(firstProjection.observations).toHaveLength(1);
    expect(firstProjection.finalCandidates).toHaveLength(1);
    expect(firstProjection.proofs).toHaveLength(1);
    expect(firstProjection.mismatches).toHaveLength(0);
    expect(firstProjection.releaseDecision?.status).toBe("released");
    expect(firstProjection.finalReleasedCandidate?.candidateId).toBe(
      "candidate_projection_001",
    );
  });

  it("only reflects recorded events and does not fabricate receipts, proofs, or releases", () => {
    const events = fullReleasedRunEvents();
    const started = eventAt(events, 0);
    const effectRequested = eventAt(events, 1);
    const projection = rebuildRunProjection([started, effectRequested]);

    expect(projection.summary.status).toBe("running");
    expect(projection.effectRequests).toHaveLength(1);
    expect(projection.receipts).toEqual([]);
    expect(projection.proofs).toEqual([]);
    expect(projection.releaseDecision).toBeUndefined();
    expect(projection.finalReleased).toBe(false);
  });

  it("fails closed when the event stream is not already in accepted order", () => {
    const events = fullReleasedRunEvents();
    const reordered = [
      eventAt(events, 1),
      eventAt(events, 0),
      ...events.slice(2),
    ];

    expect(() => rebuildRunProjection(reordered)).toThrow(ProjectionError);
    expect(() => rebuildRunProjection(reordered)).toThrow(
      /sequence must be 1/u,
    );
  });

  it("fails closed when an event payload hash is tampered", () => {
    const events = fullReleasedRunEvents();
    const tampered = events.map(cloneJson);
    const receiptEvent = eventAt(
      tampered,
      2,
    ) as RunEvent<"EffectReceiptRecorded">;
    receiptEvent.payload.receipt.status = "failed";

    expect(() => rebuildRunProjection(tampered)).toThrow(ProjectionError);
    expect(() => rebuildRunProjection(tampered)).toThrow(
      /payloadHash does not match/u,
    );
  });

  it("does not allow later caller mutations to override projected payloads", () => {
    const events = fullReleasedRunEvents();
    const projection = rebuildRunProjection(events);
    const receiptEvent = eventAt(
      events,
      2,
    ) as RunEvent<"EffectReceiptRecorded">;
    receiptEvent.payload.receipt.status = "failed";

    expect(projection.receipts[0]?.status).toBe("succeeded");
  });

  it("derives status from ReleaseDecided events, not FinalReleased payloads alone", () => {
    const events = finalReleasedWithoutReleaseDecisionEvents();
    const started = eventAt(events, 0);
    const finalReleased = eventAt(events, 1);
    const projection = rebuildRunProjection([started, finalReleased]);

    expect(projection.finalReleased).toBe(true);
    expect(projection.releaseDecision).toBeUndefined();
    expect(projection.summary.status).toBe("running");
  });

  it("projects blocked release decisions without creating FinalReleased state", () => {
    const projection = rebuildRunProjection(blockedRunEvents());

    expect(projection.summary.status).toBe("blocked");
    expect(projection.releaseDecision?.status).toBe("blocked");
    expect(projection.mismatches).toHaveLength(1);
    expect(projection.finalReleased).toBe(false);
  });
});

describe("validateAcceptedEventSequence", () => {
  it("rejects duplicate event IDs", () => {
    const events = fullReleasedRunEvents();
    const duplicated = [
      eventAt(events, 0),
      {
        ...eventAt(events, 1),
        eventId: eventAt(events, 0).eventId,
      },
    ];

    expect(() => validateAcceptedEventSequence(duplicated)).toThrow(
      /appears more than once/u,
    );
  });

  it("rejects cross-run events", () => {
    const events = fullReleasedRunEvents();
    const started = eventAt(events, 0);
    const effectRequested = eventAt(events, 1);
    const crossRunEvent = {
      ...effectRequested,
      runId: "run_other",
    };

    expect(() =>
      validateAcceptedEventSequence([started, crossRunEvent]),
    ).toThrow(/belongs to run run_other/u);
  });

  it("rejects causation IDs that do not reference an earlier event", () => {
    const events = fullReleasedRunEvents();
    const started = eventAt(events, 0);
    const effectRequested = eventAt(events, 1);
    const orphaned = {
      ...effectRequested,
      causationId: "evt_missing",
    };

    expect(() => validateAcceptedEventSequence([started, orphaned])).toThrow(
      /does not reference an earlier event/u,
    );
  });
});

function fullReleasedRunEvents(): RunEvent[] {
  const request = effectRequest();
  const receipt = effectReceipt();
  const observation = externalObservation();
  const candidate = finalCandidate();
  const proof = proofObject(candidate);
  const decision: ReleaseDecision = {
    status: "released",
    runId,
    proofId: proof.proofId,
    approvedClaimIds: ["claim_tests_passed"],
    blockingMismatchIds: [],
    finalMessage: "Tests passed.",
  };

  return [
    event(1, "RunStarted", {
      runId,
      profile: "standard",
      metadata: { phase: "22" },
    }),
    event(2, "EffectRequested", { effectRequest: request }, "evt_001"),
    event(3, "EffectReceiptRecorded", { receipt }, "evt_002"),
    event(4, "ExternalStateObserved", { observation }, "evt_003"),
    event(5, "ProposalReceived", { proposal: candidate }, "evt_004"),
    event(6, "ProofGenerated", { proof }, "evt_005"),
    event(7, "ReleaseDecided", { decision }, "evt_006"),
    event(8, "FinalReleased", { decision, candidate }, "evt_007"),
  ];
}

function blockedRunEvents(): RunEvent[] {
  const candidate = finalCandidate({ evidenceRefs: [] });
  const mismatch: Mismatch = {
    mismatchId: "mismatch_missing_evidence",
    runId,
    type: "missing_evidence",
    blocking: true,
    message: "Claim requires a matching test_run receipt.",
    claimId: "claim_tests_passed",
  };
  const proof: ProofObject = {
    proofId: "proof_projection_blocked",
    runId,
    candidateId: candidate.candidateId,
    generatedAt: laterAt,
    verdict: "fail",
    claims: [
      {
        claimId: "claim_tests_passed",
        supported: false,
        evidenceRefs: [],
        mismatchIds: [mismatch.mismatchId],
      },
    ],
    approvedClaimIds: [],
    rejectedClaimIds: ["claim_tests_passed"],
    blockingMismatches: [mismatch],
    evaluatedClaims: candidate.claims,
  };
  const decision: ReleaseDecision = {
    status: "blocked",
    runId,
    proofId: proof.proofId,
    approvedClaimIds: [],
    blockingMismatchIds: [mismatch.mismatchId],
    repairHints: ["Record a matching test_run receipt before release."],
  };

  return [
    event(1, "RunStarted", { runId }),
    event(2, "ProposalReceived", { proposal: candidate }, "evt_001"),
    event(3, "ProofGenerated", { proof }, "evt_002"),
    event(4, "MismatchDetected", { mismatch }, "evt_003"),
    event(5, "ReleaseDecided", { decision }, "evt_004"),
  ];
}

function finalReleasedWithoutReleaseDecisionEvents(): [
  RunEvent<"RunStarted">,
  RunEvent<"FinalReleased">,
] {
  const candidate = finalCandidate();
  const decision: Extract<ReleaseDecision, { status: "released" }> = {
    status: "released",
    runId,
    proofId: "proof_projection_001",
    approvedClaimIds: ["claim_tests_passed"],
    blockingMismatchIds: [],
  };

  return [
    event(1, "RunStarted", { runId }),
    event(2, "FinalReleased", { decision, candidate }, "evt_001"),
  ];
}

function effectRequest(): EffectRequest {
  return {
    effectId: "effect_projection_001",
    commandId: "command_projection_001",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "shell.run_tests",
    args: {},
    sideEffectClass: "compute",
    requestedAt: occurredAt,
  };
}

function effectReceipt(): EffectReceipt {
  const receiptPayload = { result: "passed", exitCode: 0 } satisfies JsonObject;

  return {
    receiptId: "receipt_projection_001",
    effectId: "effect_projection_001",
    runId,
    capabilityId: "shell.run_tests",
    receiptType: "test_run",
    status: "succeeded",
    payload: receiptPayload,
    payloadHash: hash(receiptPayload),
    evidence: [testReceiptEvidence()],
    observedAt: laterAt,
  };
}

function externalObservation(): ExternalStateObservation {
  const observedState = { state: "open" } satisfies JsonObject;

  return {
    observationId: "obs_projection_001",
    runId,
    observationType: "github.pull_request_state",
    subjectType: "pull_request",
    subjectId: "123",
    observedState,
    observedAt: laterAt,
    expiresAt: "2026-05-24T00:02:00.000Z",
    payloadHash: hash(observedState),
    evidence: [
      {
        evidenceId: "ev_observation_projection_001",
        kind: "external_observation",
        sourceEventId: "evt_004",
        hash: hash(observedState),
        observedAt: laterAt,
        sensitivity: "internal",
      },
    ],
  };
}

function finalCandidate(
  options: { evidenceRefs?: EvidenceRef[] } = {},
): FinalCandidate {
  const evidenceRefs = options.evidenceRefs ?? [testReceiptEvidence()];
  const claim: Claim = {
    claimId: "claim_tests_passed",
    type: "test_result",
    statement: "Tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId: "shell.run_tests",
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
    },
    evidenceRefs,
    criticality: "medium",
  };

  return {
    kind: "final_candidate",
    candidateId: "candidate_projection_001",
    runId,
    claims: [claim],
  };
}

function proofObject(candidate: FinalCandidate): ProofObject {
  return {
    proofId: "proof_projection_001",
    runId,
    candidateId: candidate.candidateId,
    generatedAt: laterAt,
    verdict: "pass",
    claims: [
      {
        claimId: "claim_tests_passed",
        supported: true,
        evidenceRefs: [testReceiptEvidence()],
        mismatchIds: [],
      },
    ],
    approvedClaimIds: ["claim_tests_passed"],
    rejectedClaimIds: [],
    blockingMismatches: [],
    evaluatedClaims: candidate.claims,
  };
}

function testReceiptEvidence(): EvidenceRef {
  const receiptPayload = { result: "passed", exitCode: 0 } satisfies JsonObject;

  return {
    evidenceId: "ev_receipt_projection_001",
    kind: "effect_receipt",
    sourceEventId: "evt_003",
    hash: hash(receiptPayload),
    observedAt: laterAt,
    sensitivity: "internal",
  };
}

function event<TType extends RunEventType>(
  sequence: number,
  type: TType,
  payload: RunEventPayloadByType[TType],
  causationId: string | null = null,
): RunEvent<TType> {
  return {
    eventId: `evt_${String(sequence).padStart(3, "0")}`,
    runId,
    sequence,
    type,
    payload,
    payloadHash: hash(payload as unknown as JsonValue),
    causationId,
    correlationId: null,
    occurredAt: sequence === 1 ? occurredAt : laterAt,
  };
}

function hash(value: JsonValue): Sha256Hash {
  return canonicalHash(value);
}

function cloneJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function eventAt<TValue>(values: readonly TValue[], index: number): TValue {
  const value = values[index];

  if (value === undefined) {
    throw new Error(`Expected test fixture event at index ${String(index)}.`);
  }

  return value;
}
