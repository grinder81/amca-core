import { describe, expect, it } from "vitest";

import {
  candidateWith,
  eventTypes,
  startedKernel,
  submitReleasedTestClaim,
  testResultClaim,
} from "./mission-helpers.js";

describe("Mission P2 proof-gated release", () => {
  it("releases a durable claim only after ProofGenerated and ReleaseDecided", () => {
    const { decision, kernel } = submitReleasedTestClaim(
      "mission_proof_release_supported",
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

  it("blocks unsupported final candidates and never emits FinalReleased", () => {
    const runId = "mission_proof_release_unsupported";
    const kernel = startedKernel(runId);
    const claim = testResultClaim({ evidenceRefs: [] });

    const result = kernel.submitFinalCandidate(candidateWith(runId, claim));

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.verdict).toBe("fail");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        claimId: claim.claimId,
        blocking: true,
      }),
    );
    expect(result.finalReleasedEvent).toBeUndefined();
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });
});
