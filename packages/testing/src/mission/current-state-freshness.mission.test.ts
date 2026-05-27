import { describe, expect, it } from "vitest";

import { hashRunEventPayload } from "@amca/kernel";

import {
  candidateWith,
  currentStateClaim,
  effectEvidenceRef,
  FRESH_OBSERVED_AT,
  observationEvidenceRef,
  pullRequestPayload,
  pullRequestStateObservation,
  STALE_OBSERVED_AT,
  FUTURE_OBSERVED_AT,
  startedKernel,
} from "./mission-helpers.js";

describe("Mission P5 current-state freshness", () => {
  it("releases a current-state claim with a fresh matching observation", () => {
    const runId = "mission_current_state_fresh";
    const observationEventId = "evt_mission_current_state_fresh";
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_current_state_fresh",
      hashRunEventPayload(observedState),
      {
        sourceEventId: observationEventId,
      },
    );
    const kernel = startedKernel(runId);
    kernel.recordExternalStateObservation(
      pullRequestStateObservation(runId, {
        evidence: [evidenceRef],
        observedState,
        observedAt: FRESH_OBSERVED_AT,
      }),
      {
        eventId: observationEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );

    const result = kernel.submitFinalCandidate(
      candidateWith(runId, currentStateClaim({ evidenceRefs: [evidenceRef] })),
    );

    expect(result.decision.status).toBe("released");
  });

  it("blocks current-state claims with stale, future, wrong-subject, or wrong-value observations", () => {
    expectCurrentStateBlocked("mission_current_state_stale", {
      observedAt: STALE_OBSERVED_AT,
      observedState: { state: "open" },
      mismatchType: "stale_external_state",
    });
    expectCurrentStateBlocked("mission_current_state_future", {
      observedAt: FUTURE_OBSERVED_AT,
      observedState: { state: "open" },
      mismatchType: "stale_external_state",
    });
    expectCurrentStateBlocked("mission_current_state_wrong_subject", {
      observedAt: FRESH_OBSERVED_AT,
      observedState: { state: "open" },
      subjectId: "456",
      mismatchType: "unsupported_claim",
    });
    expectCurrentStateBlocked("mission_current_state_wrong_value", {
      observedAt: FRESH_OBSERVED_AT,
      observedState: { state: "closed" },
      mismatchType: "unsupported_claim",
    });
  });

  it("does not allow a historical receipt to prove current external state", () => {
    const runId = "mission_current_state_receipt_not_observation";
    const payload = pullRequestPayload();
    const evidenceRef = effectEvidenceRef(
      "ev_historical_receipt_not_current_state",
      hashRunEventPayload(payload),
      {
        sourceEventId: "evt_historical_receipt",
      },
    );
    const kernel = startedKernel(runId);

    const result = kernel.submitFinalCandidate(
      candidateWith(runId, currentStateClaim({ evidenceRefs: [evidenceRef] })),
    );

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        blocking: true,
      }),
    );
  });
});

function expectCurrentStateBlocked(
  runId: string,
  options: {
    readonly observedAt: string;
    readonly observedState: { readonly state: string };
    readonly mismatchType: "stale_external_state" | "unsupported_claim";
    readonly subjectId?: string;
  },
): void {
  const observationEventId = `evt_${runId}`;
  const evidenceRef = observationEvidenceRef(
    `ev_${runId}`,
    hashRunEventPayload(options.observedState),
    {
      sourceEventId: observationEventId,
      observedAt: options.observedAt,
    },
  );
  const kernel = startedKernel(runId);
  kernel.recordExternalStateObservation(
    pullRequestStateObservation(runId, {
      evidence: [evidenceRef],
      observedAt: options.observedAt,
      observedState: options.observedState,
      ...(options.subjectId === undefined
        ? {}
        : { subjectId: options.subjectId }),
    }),
    {
      eventId: observationEventId,
      occurredAt: options.observedAt,
    },
  );

  const result = kernel.submitFinalCandidate(
    candidateWith(runId, currentStateClaim({ evidenceRefs: [evidenceRef] })),
  );

  expect(result.decision.status).toBe("blocked");
  expect(result.proof.blockingMismatches).toContainEqual(
    expect.objectContaining({
      type: options.mismatchType,
      blocking: true,
    }),
  );
}
