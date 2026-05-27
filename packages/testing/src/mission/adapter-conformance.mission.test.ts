import { describe, expect, it } from "vitest";

import {
  evaluateAdapterConformance,
  type AdapterBoundaryContract,
  type SubstrateEmission,
} from "@amca/adapters-conformance";

const runId = "mission_adapter_conformance";
const contract: AdapterBoundaryContract = {
  adapterId: "mission_adapter",
  substrate: "generic",
  runId,
  canEmitToolCommandRequests: true,
  canEmitFinalCandidates: true,
  mustNotEmitEffectReceipts: true,
  mustNotEmitReleaseDecisions: true,
  mustNotTreatSubstrateStateAsEvidence: true,
};

describe("Mission adapter conformance boundary litmus", () => {
  it("allows adapters to propose governed tool requests and structured final candidates", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [toolCall(), finalCandidate()],
    });

    expect(report.status).toBe("pass");
    expect(report.toolCommandCount).toBe(1);
    expect(report.finalCandidateCount).toBe(1);
  });

  it("blocks adapter attempts to become release authority", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "release_decision",
          emissionId: "mission_release_bypass",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          decision: {
            status: "released",
            runId,
            proofId: "proof_bypass",
            approvedClaimIds: ["claim_001"],
            blockingMismatchIds: [],
          },
        },
      ],
    });

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "direct_release_forbidden",
    );
  });

  it("blocks adapter attempts to become proof authority", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "proof_object",
          emissionId: "mission_proof_bypass",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          proof: {
            proofId: "proof_bypass",
            runId,
            candidateId: "candidate_001",
            generatedAt: "2026-05-24T12:00:00.000Z",
            verdict: "pass",
            claims: [],
            approvedClaimIds: [],
            rejectedClaimIds: [],
            blockingMismatches: [],
            evaluatedClaims: [],
          },
        },
      ],
    });

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "direct_proof_forbidden",
    );
  });

  it("blocks adapter attempts to treat raw final text as release input", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "raw_final_text",
          emissionId: "mission_raw_text_bypass",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          text: "The workflow succeeded, trust me.",
        },
      ],
    });

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "raw_final_text_forbidden",
    );
  });

  it("blocks substrate state when it is used as AMCA evidence", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "substrate_state",
          emissionId: "mission_state_truth_bypass",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          state: { checkpointId: "checkpoint_001" },
          usedAsEvidence: true,
        },
      ],
    });

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "substrate_state_as_truth_forbidden",
    );
  });

  it("blocks direct receipt admission by a substrate adapter", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "effect_receipt",
          emissionId: "mission_receipt_bypass",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          receipt: {
            receiptId: "receipt_bypass",
            effectId: "effect_bypass",
            runId,
            capabilityId: "shell.run_tests",
            receiptType: "test_run",
            status: "succeeded",
            payload: { result: "passed" },
            payloadHash:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            evidence: [],
            observedAt: "2026-05-24T12:00:00.000Z",
          },
        },
      ],
    });

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "direct_effect_receipt_forbidden",
    );
  });
});

function toolCall(): SubstrateEmission {
  return {
    kind: "tool_call",
    emissionId: "mission_tool_call",
    adapterId: contract.adapterId,
    substrate: contract.substrate,
    runId,
    toolCommand: {
      kind: "tool_command_request",
      commandId: "command_001",
      runId,
      capabilityId: "shell.run_tests",
      toolId: "pnpm.test",
      args: { command: "pnpm test" },
      sideEffectClass: "compute",
    },
  };
}

function finalCandidate(): SubstrateEmission {
  return {
    kind: "final_output",
    emissionId: "mission_final_candidate",
    adapterId: contract.adapterId,
    substrate: contract.substrate,
    runId,
    finalCandidate: {
      kind: "final_candidate",
      candidateId: "candidate_001",
      runId,
      claims: [
        {
          claimId: "claim_001",
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
        },
      ],
    },
  };
}
