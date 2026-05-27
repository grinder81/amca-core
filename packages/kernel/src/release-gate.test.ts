import { describe, expect, it } from "vitest";

import { validateReleaseDecision } from "@amca/contracts";
import type {
  Claim,
  FinalCandidate,
  Mismatch,
  ProofObject,
} from "@amca/protocol";

import { decideRelease, renderApprovedClaims } from "./index.js";

const runId = "run_phase_08_release_gate";
const candidateId = "candidate_phase_08_release_gate";
const generatedAt = "2026-05-24T18:00:00.000Z";

const testsPassedClaim: Claim = {
  claimId: "claim_tests_passed",
  type: "test_result",
  statement: "Tests passed.",
  predicate: {
    kind: "test_result",
    capabilityId: "shell.run_tests",
    expectedStatus: "passed",
    requiredReceiptType: "test_run",
  },
  evidenceRefs: [],
  criticality: "medium",
};

const prOpenedClaim: Claim = {
  claimId: "claim_pr_opened",
  type: "historical_action",
  statement: "I opened PR #123.",
  predicate: {
    kind: "historical_action",
    actionVerb: "created",
    subjectType: "agent",
    subjectId: "agent_001",
    targetType: "pull_request",
    targetId: "123",
    capabilityId: "github.create_pull_request",
    requiredReceiptType: "github.pull_request_created",
  },
  evidenceRefs: [],
  criticality: "medium",
};

const candidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId,
  runId,
  claims: [testsPassedClaim, prOpenedClaim],
};

describe("release gate", () => {
  it("releases a passing proof with no blocking mismatches", () => {
    const proof = proofObject({
      verdict: "pass",
      approvedClaimIds: [testsPassedClaim.claimId, prOpenedClaim.claimId],
      rejectedClaimIds: [],
      blockingMismatches: [],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision).toEqual({
      status: "released",
      runId,
      proofId: proof.proofId,
      approvedClaimIds: [testsPassedClaim.claimId, prOpenedClaim.claimId],
      blockingMismatchIds: [],
      finalMessage: "Tests passed.\nPull request 123 was created.",
    });
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("renders final messages only from approved claim predicates", () => {
    const proof = proofObject({
      verdict: "pass",
      approvedClaimIds: [testsPassedClaim.claimId],
      rejectedClaimIds: [],
      blockingMismatches: [],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision.status).toBe("released");
    if (decision.status !== "released") {
      throw new Error(
        `Expected released decision, received ${decision.status}`,
      );
    }
    expect(decision.finalMessage).toBe("Tests passed.");
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("does not release a malicious statement that conflicts with a proven predicate", () => {
    const maliciousStatementClaim: Claim = {
      ...testsPassedClaim,
      statement: "I deployed the fix to production.",
    };
    const maliciousCandidate: FinalCandidate = {
      ...candidate,
      claims: [maliciousStatementClaim],
    };
    const proof = proofObject({
      verdict: "pass",
      approvedClaimIds: [maliciousStatementClaim.claimId],
      rejectedClaimIds: [],
      blockingMismatches: [],
    });

    const decision = decideRelease({
      candidate: maliciousCandidate,
      proof,
    });

    expect(decision.status).toBe("released");
    if (decision.status !== "released") {
      throw new Error(
        `Expected released decision, received ${decision.status}`,
      );
    }
    expect(decision.finalMessage).toBe("Tests passed.");
    expect(decision.finalMessage).not.toContain("deployed");
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("blocks a failing proof with blocking mismatch IDs and repair hints", () => {
    const mismatch = missingEvidenceMismatch();
    const proof = proofObject({
      verdict: "fail",
      approvedClaimIds: [],
      rejectedClaimIds: [testsPassedClaim.claimId],
      blockingMismatches: [mismatch],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision).toEqual({
      status: "blocked",
      runId,
      proofId: proof.proofId,
      approvedClaimIds: [],
      blockingMismatchIds: [mismatch.mismatchId],
      repairHints: [
        "Resolve missing_evidence mismatch mismatch_missing_test_receipt for claim claim_tests_passed: Claim requires a matching test receipt.",
      ],
    });
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("returns needs_repair with blocking mismatch IDs and repair instructions", () => {
    const mismatch = schemaMismatch();
    const proof = proofObject({
      verdict: "needs_repair",
      approvedClaimIds: [],
      rejectedClaimIds: [testsPassedClaim.claimId],
      blockingMismatches: [mismatch],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision).toEqual({
      status: "needs_repair",
      runId,
      proofId: proof.proofId,
      approvedClaimIds: [],
      blockingMismatchIds: [mismatch.mismatchId],
      repairInstructions: [
        "Resolve schema_mismatch mismatch mismatch_schema for claim claim_tests_passed: Claim predicate failed schema validation.",
      ],
    });
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("returns quarantine and maps uncertain external effects conservatively", () => {
    const mismatch = uncertainExternalEffectMismatch();
    const proof = proofObject({
      verdict: "quarantine",
      approvedClaimIds: [],
      rejectedClaimIds: [prOpenedClaim.claimId],
      blockingMismatches: [mismatch],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision).toEqual({
      status: "quarantined",
      runId,
      proofId: proof.proofId,
      approvedClaimIds: [],
      blockingMismatchIds: [mismatch.mismatchId],
      reason: "uncertain_external_effect",
    });
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("uses inconsistent_evidence as the default quarantine reason", () => {
    const mismatch = missingEvidenceMismatch();
    const proof = proofObject({
      verdict: "quarantine",
      approvedClaimIds: [],
      rejectedClaimIds: [testsPassedClaim.claimId],
      blockingMismatches: [mismatch],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision.status).toBe("quarantined");
    if (decision.status !== "quarantined") {
      throw new Error(
        `Expected quarantined decision, received ${decision.status}`,
      );
    }
    expect(decision.reason).toBe("inconsistent_evidence");
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("fails closed when a pass verdict still contains a blocking mismatch", () => {
    const mismatch = missingEvidenceMismatch();
    const proof = proofObject({
      verdict: "pass",
      approvedClaimIds: [testsPassedClaim.claimId],
      rejectedClaimIds: [],
      blockingMismatches: [mismatch],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision).toMatchObject({
      status: "blocked",
      runId,
      proofId: proof.proofId,
      approvedClaimIds: [testsPassedClaim.claimId],
      blockingMismatchIds: [mismatch.mismatchId],
    });
    expect("finalMessage" in decision).toBe(false);
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("preserves approved and blocking IDs exactly from the proof", () => {
    const firstMismatch = missingEvidenceMismatch();
    const secondMismatch = schemaMismatch();
    const proof = proofObject({
      verdict: "fail",
      approvedClaimIds: [prOpenedClaim.claimId],
      rejectedClaimIds: [testsPassedClaim.claimId],
      blockingMismatches: [firstMismatch, secondMismatch],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision.approvedClaimIds).toEqual([prOpenedClaim.claimId]);
    expect(decision.blockingMismatchIds).toEqual([
      firstMismatch.mismatchId,
      secondMismatch.mismatchId,
    ]);
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("returns a schema-valid blocked decision for an inconsistent fail proof without mismatches", () => {
    const proof = proofObject({
      verdict: "fail",
      approvedClaimIds: [],
      rejectedClaimIds: [testsPassedClaim.claimId],
      blockingMismatches: [],
    });

    const decision = decideRelease({ candidate, proof });

    expect(decision).toEqual({
      status: "blocked",
      runId,
      proofId: proof.proofId,
      approvedClaimIds: [],
      blockingMismatchIds: ["release_gate_inconsistent_proof"],
      repairHints: [
        "Resolve proof proof_phase_08_release_gate: proof verdict fail did not provide a blocking mismatch.",
      ],
    });
    expect(validateReleaseDecision(decision).success).toBe(true);
  });

  it("renders only already approved claim predicates in candidate order", () => {
    expect(renderApprovedClaims(candidate, [prOpenedClaim.claimId])).toBe(
      "Pull request 123 was created.",
    );
  });
});

function proofObject(overrides: {
  readonly verdict: ProofObject["verdict"];
  readonly approvedClaimIds: string[];
  readonly rejectedClaimIds: string[];
  readonly blockingMismatches: Mismatch[];
}): ProofObject {
  const evaluatedClaims = [testsPassedClaim, prOpenedClaim];

  return {
    proofId: "proof_phase_08_release_gate",
    runId,
    candidateId,
    generatedAt,
    verdict: overrides.verdict,
    claims: evaluatedClaims.map((claim) => ({
      claimId: claim.claimId,
      supported: overrides.approvedClaimIds.includes(claim.claimId),
      evidenceRefs: [],
      mismatchIds: overrides.blockingMismatches
        .filter((mismatch) => mismatch.claimId === claim.claimId)
        .map((mismatch) => mismatch.mismatchId),
    })),
    approvedClaimIds: overrides.approvedClaimIds,
    rejectedClaimIds: overrides.rejectedClaimIds,
    blockingMismatches: overrides.blockingMismatches,
    evaluatedClaims,
  };
}

function missingEvidenceMismatch(): Mismatch {
  return {
    mismatchId: "mismatch_missing_test_receipt",
    runId,
    type: "missing_evidence",
    blocking: true,
    claimId: testsPassedClaim.claimId,
    message: "Claim requires a matching test receipt.",
    expected: { receiptType: "test_run" },
    actual: null,
  };
}

function schemaMismatch(): Mismatch {
  return {
    mismatchId: "mismatch_schema",
    runId,
    type: "schema_mismatch",
    blocking: true,
    claimId: testsPassedClaim.claimId,
    message: "Claim predicate failed schema validation.",
    expected: { kind: "test_result" },
    actual: { kind: "unknown" },
  };
}

function uncertainExternalEffectMismatch(): Mismatch {
  return {
    mismatchId: "mismatch_uncertain_external_effect",
    runId,
    type: "uncertain_external_effect",
    blocking: true,
    claimId: prOpenedClaim.claimId,
    message: "External write result is unknown.",
    expected: { receiptStatus: "succeeded" },
    actual: { receiptStatus: "unknown" },
  };
}
