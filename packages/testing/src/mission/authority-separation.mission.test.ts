import { describe, expect, it } from "vitest";

import {
  candidateWith,
  eventTypes,
  STARTED_AT,
  startedKernel,
  submitReleasedTestClaim,
  testResultClaim,
  toolCommandRequest,
} from "./mission-helpers.js";

describe("Mission P1 authority separation", () => {
  it("allows agent proposals to enter AMCA without granting release authority", () => {
    const runId = "mission_authority_agent_proposes";
    const kernel = startedKernel(runId);

    kernel.submitToolCommand(toolCommandRequest(runId), {
      occurredAt: STARTED_AT,
    });

    const blocked = kernel.submitFinalCandidate(
      candidateWith(runId, testResultClaim({ evidenceRefs: [] })),
    );

    expect(blocked.decision.status).toBe("blocked");
    expect(eventTypes(kernel)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "ProposalReceived",
      "ProofGenerated",
      "MismatchDetected",
      "ReleaseDecided",
    ]);
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("publishes only through proof and release gate when evidence is admitted", () => {
    const { decision, kernel } = submitReleasedTestClaim(
      "mission_authority_release_gate",
    );

    expect(decision.status).toBe("released");
    expect(eventTypes(kernel)).toEqual([
      "RunStarted",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
  });
});
