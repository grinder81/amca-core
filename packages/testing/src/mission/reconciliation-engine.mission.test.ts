import { describe, expect, it } from "vitest";

import { evaluateAcceptedRun } from "@amca/eval";
import { hashRunEventPayload } from "@amca/kernel";
import type { EffectReceipt, EvidenceRef } from "@amca/protocol";
import { reconcileAcceptedEvidence } from "@amca/reconciliation";
import { replayRunEvents } from "@amca/replay";
import {
  testsPassedReleasedScenario,
  type ScenarioFixture,
} from "@amca/testing";

import {
  candidateWith,
  currentStateClaim,
  effectEvidenceRef,
  FRESH_OBSERVED_AT,
  GENERATED_AT,
  observationEvidenceRef,
  pullRequestStateObservation,
  startedKernel,
  testResultClaim,
  testRunEffectRequest,
  testRunPayload,
  testRunReceipt,
} from "./mission-helpers.js";

describe("Mission reconciliation engine litmus", () => {
  it("detects admitted current-state drift without releasing or mutating truth", () => {
    const runId = "mission_reconciliation_state_drift";
    const acceptedState = { state: "open" };
    const freshState = { state: "closed" };
    const acceptedEvidence = observationEvidenceRef(
      "ev_reconciliation_accepted",
      hashRunEventPayload(acceptedState),
      {
        sourceEventId: "evt_reconciliation_accepted",
      },
    );
    const freshEvidence = observationEvidenceRef(
      "ev_reconciliation_fresh",
      hashRunEventPayload(freshState),
      {
        sourceEventId: "evt_reconciliation_fresh",
      },
    );
    const report = reconcileAcceptedEvidence({
      runId,
      checkedAt: GENERATED_AT,
      acceptedObservations: [
        pullRequestStateObservation(runId, {
          evidence: [acceptedEvidence],
          observedState: acceptedState,
          observedAt: FRESH_OBSERVED_AT,
        }),
      ],
      freshObservations: [
        pullRequestStateObservation("mission_reconciliation_fresh_run", {
          evidence: [freshEvidence],
          observedState: freshState,
          observedAt: FRESH_OBSERVED_AT,
        }),
      ],
      observationFreshnessMs: 60_000,
    });

    expect(report.outcome).toBe("drift_detected");
    expect(report.proofUsable).toBe(false);
    expect(report.authority).toMatchObject({
      mutatesTruth: false,
      executesEffects: false,
      admitsEvidence: false,
      supportsProof: false,
      releasesClaims: false,
    });
    expect(report.mismatches).toContainEqual(
      expect.objectContaining({
        type: "external_state_drift",
      }),
    );
  });

  it("recommends quarantine for missing receipts and uncertain external effects", () => {
    const runId = "mission_reconciliation_quarantine";
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(testRunEffectRequest(runId));

    const report = reconcileAcceptedEvidence({
      runId,
      checkedAt: GENERATED_AT,
      acceptedEvents: kernel.events(),
      receiptStatusSummaries: [
        {
          kind: "receipt_status_summary",
          runId,
          effectId: "effect_test_001",
          status: "unknown",
          certainty: "uncertain",
          observedAt: FRESH_OBSERVED_AT,
        },
      ],
    });

    expect(report.outcome).toBe("quarantine_recommended");
    expect(report.mismatches).toContainEqual(
      expect.objectContaining({
        type: "receipt_missing",
        severity: "critical",
      }),
    );
    expect(report.quarantineRecommendations).toContainEqual(
      expect.objectContaining({
        reason: "missing_receipt",
      }),
    );
    expect(report.authority.executesEffects).toBe(false);

    const payload = testRunPayload();
    const uncertainReceiptReport = reconcileAcceptedEvidence({
      runId,
      checkedAt: GENERATED_AT,
      acceptedReceipts: [
        testRunReceipt(runId, {
          payload,
          evidence: [
            effectEvidenceRef(
              "ev_reconciliation_uncertain_receipt",
              hashRunEventPayload(payload),
              {
                sourceEventId: "evt_reconciliation_uncertain_receipt",
              },
            ),
          ],
        }),
      ],
      receiptStatusSummaries: [
        {
          kind: "receipt_status_summary",
          runId,
          effectId: "effect_test_001",
          receiptId: "receipt_test_001",
          status: "unknown",
          certainty: "uncertain",
          observedAt: FRESH_OBSERVED_AT,
        },
      ],
    });

    expect(uncertainReceiptReport.outcome).toBe("quarantine_recommended");
    expect(uncertainReceiptReport.mismatches).toContainEqual(
      expect.objectContaining({
        type: "uncertain_external_effect",
      }),
    );
    expect(uncertainReceiptReport.quarantineRecommendations).toContainEqual(
      expect.objectContaining({
        reason: "uncertain_external_effect",
      }),
    );
  });

  it("replay-eval-reconciliation-output-cannot-support-proof-directly", () => {
    const replayOutput = replayRunEvents({
      events: eventsForScenario(testsPassedReleasedScenario),
    });
    const evalOutput = evaluateAcceptedRun({
      events: eventsForScenario(testsPassedReleasedScenario),
      expected: {
        releaseStatus: "released",
      },
    });
    const reconciliationOutput = reconcileAcceptedEvidence({
      runId: "mission_reconciliation_output_attack_source",
      checkedAt: GENERATED_AT,
    });

    expect(replayOutput.status).toBe("passed");
    expect(evalOutput.status).toBe("pass");
    expect(reconciliationOutput.proofUsable).toBe(false);

    for (const [artifactName, artifact] of [
      ["replay", replayOutput],
      ["eval", evalOutput],
      ["reconciliation", reconciliationOutput],
    ] as const) {
      expectArtifactCannotSupportProof(artifactName, artifact);
    }
  });
});

function expectArtifactCannotSupportProof(
  artifactName: string,
  artifact: unknown,
): void {
  const runId = `mission_${artifactName}_artifact_not_proof`;
  const invalidEvidenceRef = artifact as EvidenceRef;
  const kernel = startedKernel(runId);

  kernel.recordEffectRequest(testRunEffectRequest(runId));

  expect(() =>
    kernel.recordEffectReceipt(artifact as EffectReceipt, {
      eventId: `evt_${artifactName}_artifact_as_receipt`,
      occurredAt: GENERATED_AT,
    }),
  ).toThrow(/EffectReceipt validation failed/u);
  expect(kernel.events().map((event) => event.type)).not.toContain(
    "EffectReceiptRecorded",
  );

  expect(() =>
    kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim({
          evidenceRefs: [invalidEvidenceRef],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    ),
  ).toThrow(/FinalCandidate validation failed/u);

  const forgedReceiptEvidence = effectEvidenceRef(
    `ev_${artifactName}_artifact`,
    hashRunEventPayload(artifact),
    {
      sourceEventId: `evt_${artifactName}_artifact`,
    },
  );
  const blocked = kernel.submitFinalCandidate(
    candidateWith(
      runId,
      testResultClaim({
        evidenceRefs: [forgedReceiptEvidence],
      }),
    ),
    {
      occurredAt: GENERATED_AT,
      generatedAt: GENERATED_AT,
    },
  );

  expect(blocked.proof.verdict).toBe("fail");
  expect(blocked.decision.status).toBe("blocked");
  expect(blocked.proof.blockingMismatches).toContainEqual(
    expect.objectContaining({
      type: "unverified_receipt",
      blocking: true,
    }),
  );

  const forgedObservationEvidence = observationEvidenceRef(
    `ev_${artifactName}_current_state_artifact`,
    hashRunEventPayload(artifact),
    {
      sourceEventId: `evt_${artifactName}_current_state_artifact`,
    },
  );
  const currentStateBlocked = startedKernel(`${runId}_current_state`);
  const currentStateResult = currentStateBlocked.submitFinalCandidate(
    candidateWith(
      `${runId}_current_state`,
      currentStateClaim({
        evidenceRefs: [forgedObservationEvidence],
      }),
    ),
    {
      occurredAt: GENERATED_AT,
      generatedAt: GENERATED_AT,
    },
  );

  expect(currentStateResult.proof.verdict).toBe("fail");
  expect(currentStateResult.decision.status).toBe("blocked");
  expect(currentStateResult.proof.blockingMismatches).toContainEqual(
    expect.objectContaining({
      type: "unsupported_claim",
      blocking: true,
    }),
  );
}

function eventsForScenario(
  scenario: ScenarioFixture,
): ScenarioFixture["given"]["runEvents"] {
  return [...scenario.given.runEvents, ...scenario.expected.emittedEvents];
}
