import { describe, expect, it } from "vitest";

import { buildHttpReadonlyObservationCandidate } from "@amca/adapters-tools";
import { hashRunEventPayload } from "@amca/kernel";
import type { EvidenceRef, RunEvent } from "@amca/protocol";

import {
  BAD_HASH,
  candidateWith,
  effectEvidenceRef,
  eventTypes,
  expectRunKernelError,
  FRESH_OBSERVED_AT,
  observationEvidenceRef,
  pullRequestStateObservation,
  startedKernel,
  testResultClaim,
  testRunEffectRequest,
  testRunPayload,
  testRunReceipt,
} from "./mission-helpers.js";

const emptyHash =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("Mission P3 evidence admissibility", () => {
  it("admits receipt evidence only after a matching EffectRequested event", () => {
    const runId = "mission_evidence_receipt_admitted";
    const receiptEventId = "evt_mission_receipt_admitted";
    const payload = testRunPayload();
    const evidenceRef = effectEvidenceRef(
      "ev_mission_receipt_admitted",
      hashRunEventPayload(payload),
      {
        sourceEventId: receiptEventId,
      },
    );
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(testRunEffectRequest(runId));
    const event = kernel.recordEffectReceipt(
      testRunReceipt(runId, {
        evidence: [evidenceRef],
        payload,
      }),
      {
        eventId: receiptEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );

    expect(event.eventId).toBe(evidenceRef.sourceEventId);
  });

  it("evidence-source-event-id-missing-blocked", () => {
    const runId = "mission_evidence_missing_source_event_id";
    const receiptEventId = "evt_mission_missing_source_receipt";
    const payload = testRunPayload();
    const malformedEvidenceRef = omitSourceEventId(
      effectEvidenceRef(
        "ev_missing_source_event_id",
        hashRunEventPayload(payload),
        {
          sourceEventId: receiptEventId,
        },
      ),
    ) as unknown as EvidenceRef;
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(testRunEffectRequest(runId));

    expect(() =>
      kernel.recordEffectReceipt(
        testRunReceipt(runId, {
          evidence: [malformedEvidenceRef],
          payload,
        }),
        {
          eventId: receiptEventId,
          occurredAt: FRESH_OBSERVED_AT,
        },
      ),
    ).toThrow(/EffectReceipt validation failed/u);

    expect(() =>
      kernel.submitFinalCandidate(
        candidateWith(
          runId,
          testResultClaim({
            evidenceRefs: [malformedEvidenceRef],
          }),
        ),
      ),
    ).toThrow(/FinalCandidate validation failed/u);

    expectNoProofPassOrReleasedDecision(kernel);
  });

  it("blocks orphan receipts that were never requested", () => {
    const runId = "mission_evidence_orphan_receipt";
    const receiptEventId = "evt_mission_orphan_receipt";
    const payload = testRunPayload();
    const kernel = startedKernel(runId);

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(
          testRunReceipt(runId, {
            evidence: [
              effectEvidenceRef(
                "ev_orphan_receipt",
                hashRunEventPayload(payload),
                {
                  sourceEventId: receiptEventId,
                },
              ),
            ],
            payload,
          }),
          {
            eventId: receiptEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "effect_request_not_found",
    );
  });

  it("blocks forged evidence source, kind, and hash mismatches", () => {
    const runId = "mission_evidence_forgery";
    const receiptEventId = "evt_mission_forgery_receipt";
    const payload = testRunPayload();
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(
          testRunReceipt(runId, {
            evidence: [
              effectEvidenceRef(
                "ev_wrong_source",
                hashRunEventPayload(payload),
                {
                  sourceEventId: "evt_not_the_receipt",
                },
              ),
            ],
            payload,
          }),
          {
            eventId: receiptEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "evidence_source_event_mismatch",
    );

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(
          testRunReceipt(runId, {
            evidence: [
              {
                ...effectEvidenceRef(
                  "ev_wrong_kind",
                  hashRunEventPayload(payload),
                  {
                    sourceEventId: receiptEventId,
                  },
                ),
                kind: "external_observation",
              },
            ],
            payload,
          }),
          {
            eventId: receiptEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "evidence_kind_mismatch",
    );

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(
          testRunReceipt(runId, {
            evidence: [
              effectEvidenceRef("ev_wrong_hash", BAD_HASH, {
                sourceEventId: receiptEventId,
              }),
            ],
            payload,
          }),
          {
            eventId: receiptEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "evidence_hash_mismatch",
    );
  });

  it("blocks claims when matching evidence exists but is not referenced by the claim", () => {
    const runId = "mission_evidence_claim_bound";
    const receiptEventId = "evt_mission_claim_bound_receipt";
    const payload = testRunPayload();
    const evidenceRef = effectEvidenceRef(
      "ev_unreferenced_receipt",
      hashRunEventPayload(payload),
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
      candidateWith(runId, testResultClaim({ evidenceRefs: [] })),
    );

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        blocking: true,
      }),
    );
  });

  it("http-readonly-pending-observation-candidate-proof-blocked", () => {
    const runId = "mission_http_readonly_pending_observation";
    const candidate = buildHttpReadonlyObservationCandidate({
      runId,
      commandId: "cmd_http_readonly_pending",
      url: "https://example.com/status?page=1",
      method: "GET",
      observedAt: FRESH_OBSERVED_AT,
      responseMetadata: {
        statusCode: 200,
        contentHash: emptyHash,
        byteLength: 0,
        contentType: "application/json",
      },
    });
    const pendingEvidence = candidate.evidence[0];

    expect(pendingEvidence).toMatchObject({
      admissionStatus: "pending",
      kind: "external_observation",
    });
    expect(pendingEvidence).not.toHaveProperty("sourceEventId");

    const kernel = startedKernel(runId);
    expect(() =>
      kernel.submitFinalCandidate({
        kind: "final_candidate",
        candidateId: "candidate_http_pending_observation",
        runId,
        claims: [
          {
            claimId: "claim_http_pending_observation",
            type: "current_state",
            statement: "The HTTP resource returned 200.",
            predicate: {
              kind: "current_state",
              subjectType: candidate.subjectType,
              subjectId: candidate.subjectId,
              property: "response.statusCode",
              operator: "equals",
              expectedValue: 200,
              observationType: candidate.observationType,
              freshnessRequirementMs: 60_000,
            },
            evidenceRefs: candidate.evidence as unknown as EvidenceRef[],
            criticality: "medium",
          },
        ],
      }),
    ).toThrow(/FinalCandidate validation failed/u);
    expectNoProofPassOrReleasedDecision(kernel);
  });

  it("blocks cross-run evidence at admission boundaries", () => {
    const runId = "mission_evidence_cross_run";
    const receiptEventId = "evt_mission_cross_run_receipt";
    const payload = testRunPayload();
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(testRunEffectRequest(runId));

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(
          testRunReceipt("run_other", {
            evidence: [
              effectEvidenceRef("ev_cross_run", hashRunEventPayload(payload), {
                sourceEventId: receiptEventId,
              }),
            ],
            payload,
          }),
          {
            eventId: receiptEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "run_id_mismatch",
    );
  });

  it("requires observation evidence to be admitted by its observation event", () => {
    const runId = "mission_evidence_observation_source";
    const observationEventId = "evt_mission_observation";
    const observedState = { state: "open" };
    const kernel = startedKernel(runId);

    expectRunKernelError(
      () =>
        kernel.recordExternalStateObservation(
          pullRequestStateObservation(runId, {
            evidence: [
              observationEvidenceRef(
                "ev_observation_wrong_source",
                hashRunEventPayload(observedState),
                {
                  sourceEventId: "evt_not_the_observation",
                },
              ),
            ],
            observedState,
          }),
          {
            eventId: observationEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "evidence_source_event_mismatch",
    );
  });
});

function omitSourceEventId(
  evidenceRef: EvidenceRef,
): Omit<EvidenceRef, "sourceEventId"> {
  const copy: Partial<EvidenceRef> = { ...evidenceRef };
  delete copy.sourceEventId;
  return copy as Omit<EvidenceRef, "sourceEventId">;
}

function expectNoProofPassOrReleasedDecision(
  kernel: ReturnType<typeof startedKernel>,
): void {
  for (const event of proofGeneratedEvents(kernel.events())) {
    expect(event.payload.proof.verdict).not.toBe("pass");
  }

  for (const event of releaseDecidedEvents(kernel.events())) {
    expect(event.payload.decision.status).not.toBe("released");
  }

  expect(eventTypes(kernel)).not.toContain("FinalReleased");
}

function proofGeneratedEvents(
  events: readonly RunEvent[],
): Array<RunEvent<"ProofGenerated">> {
  return events.filter(
    (event): event is RunEvent<"ProofGenerated"> =>
      event.type === "ProofGenerated",
  );
}

function releaseDecidedEvents(
  events: readonly RunEvent[],
): Array<RunEvent<"ReleaseDecided">> {
  return events.filter(
    (event): event is RunEvent<"ReleaseDecided"> =>
      event.type === "ReleaseDecided",
  );
}
