import { describe, expect, it } from "vitest";

import type { AdapterBoundaryContract, SubstrateEmission } from "./types.js";
import {
  AdapterConformanceError,
  assertAdapterConformance,
  evaluateAdapterConformance,
} from "./index.js";

const runId = "run_adapter_conformance";
const contract: AdapterBoundaryContract = {
  adapterId: "adapter_test",
  substrate: "generic",
  runId,
  canEmitToolCommandRequests: true,
  canEmitFinalCandidates: true,
  mustNotEmitEffectReceipts: true,
  mustNotEmitReleaseDecisions: true,
  mustNotTreatSubstrateStateAsEvidence: true,
};

describe("adapter conformance", () => {
  it("passes for governed tool requests and structured final candidates", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [toolCallEmission(), finalCandidateEmission()],
    });

    expect(report).toMatchObject({
      status: "pass",
      toolCommandCount: 1,
      finalCandidateCount: 1,
      issues: [],
    });
  });

  it("fails closed when an adapter emits raw final text", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "raw_final_text",
          emissionId: "emission_raw",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          text: "Everything is done.",
        },
      ],
    });

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "raw_final_text_forbidden",
    );
  });

  it("fails closed when an adapter emits release authority", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "release_decision",
          emissionId: "emission_release",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          decision: {
            status: "released",
            runId,
            proofId: "proof_001",
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

  it("fails closed when an adapter emits proof authority", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "proof_object",
          emissionId: "emission_proof",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          proof: {
            proofId: "proof_001",
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

  it("fails closed when an adapter directly admits receipts", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "effect_receipt",
          emissionId: "emission_receipt",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          receipt: {
            receiptId: "receipt_001",
            effectId: "effect_001",
            runId,
            capabilityId: "shell.run_tests",
            receiptType: "test_run",
            status: "succeeded",
            payload: { result: "passed" },
            payloadHash:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

  it("fails closed when substrate state is used as evidence", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "substrate_state",
          emissionId: "emission_state",
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

  it("fails closed when final candidates have no structured claims", () => {
    const report = evaluateAdapterConformance({
      contract,
      emissions: [
        {
          kind: "final_output",
          emissionId: "emission_final_empty",
          adapterId: contract.adapterId,
          substrate: contract.substrate,
          runId,
          finalCandidate: {
            kind: "final_candidate",
            candidateId: "candidate_empty",
            runId,
            claims: [],
            narrativeDraft: "Done.",
          },
        },
      ],
    });

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "final_candidate_without_claims",
    );
  });

  it("throws an AdapterConformanceError for failing reports", () => {
    expect(() =>
      assertAdapterConformance({
        contract,
        emissions: [
          {
            kind: "raw_final_text",
            emissionId: "emission_raw",
            adapterId: contract.adapterId,
            substrate: contract.substrate,
            runId,
            text: "release me",
          },
        ],
      }),
    ).toThrow(AdapterConformanceError);
  });
});

function toolCallEmission(): SubstrateEmission {
  return {
    kind: "tool_call",
    emissionId: "emission_tool",
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

function finalCandidateEmission(): SubstrateEmission {
  return {
    kind: "final_output",
    emissionId: "emission_final",
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
