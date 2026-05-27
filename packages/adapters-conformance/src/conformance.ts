import { parseFinalCandidate, parseToolCommandRequest } from "@amca/contracts";

import {
  AdapterConformanceError,
  type AdapterBoundaryContract,
  type AdapterConformanceIssue,
  type AdapterConformanceReport,
  type FinalCandidateConversionContract,
  type SubstrateEmission,
  type ToolCallInterceptionContract,
} from "./types.js";

export interface EvaluateAdapterConformanceInput {
  readonly contract: AdapterBoundaryContract;
  readonly emissions: readonly SubstrateEmission[];
}

export function evaluateAdapterConformance(
  input: EvaluateAdapterConformanceInput,
): AdapterConformanceReport {
  const issues: AdapterConformanceIssue[] = [];
  let toolCommandCount = 0;
  let finalCandidateCount = 0;

  for (const emission of input.emissions) {
    if (
      emission.adapterId !== input.contract.adapterId ||
      emission.substrate !== input.contract.substrate
    ) {
      issues.push({
        code: "contract_identity_mismatch",
        emissionId: emission.emissionId,
        message: "Emission identity does not match adapter boundary contract.",
      });
    }

    if (emission.runId !== input.contract.runId) {
      issues.push({
        code: "run_id_mismatch",
        emissionId: emission.emissionId,
        message: `Emission runId ${emission.runId} does not match contract runId ${input.contract.runId}.`,
      });
    }

    switch (emission.kind) {
      case "proposal":
        switch (emission.proposal.kind) {
          case "tool_command_request":
            toolCommandCount += 1;
            issues.push(
              ...validateToolCommand(
                emission.proposal,
                emission.emissionId,
                input.contract.runId,
              ),
            );
            break;

          case "final_candidate":
            finalCandidateCount += 1;
            issues.push(
              ...validateFinalCandidate(
                emission.proposal,
                emission.emissionId,
                input.contract.runId,
              ),
            );
            break;
        }
        break;

      case "tool_call":
        toolCommandCount += 1;
        issues.push(
          ...validateToolCommand(
            emission.toolCommand,
            emission.emissionId,
            input.contract.runId,
          ),
        );
        break;

      case "final_output":
        finalCandidateCount += 1;
        issues.push(
          ...validateFinalCandidate(
            emission.finalCandidate,
            emission.emissionId,
            input.contract.runId,
          ),
        );
        break;

      case "substrate_state":
        if (emission.usedAsEvidence === true) {
          issues.push({
            code: "substrate_state_as_truth_forbidden",
            emissionId: emission.emissionId,
            message:
              "Substrate state is execution-local and cannot be used as AMCA evidence.",
          });
        }
        break;

      case "effect_receipt":
        issues.push({
          code: "direct_effect_receipt_forbidden",
          emissionId: emission.emissionId,
          message:
            "Substrate adapters may not directly admit EffectReceipt objects.",
        });
        break;

      case "proof_object":
        issues.push({
          code: "direct_proof_forbidden",
          emissionId: emission.emissionId,
          message:
            "Substrate adapters may not emit ProofObject or proof authority.",
        });
        break;

      case "release_decision":
        issues.push({
          code: "direct_release_forbidden",
          emissionId: emission.emissionId,
          message:
            "Substrate adapters may not emit ReleaseDecision or FinalReleased authority.",
        });
        break;

      case "raw_final_text":
        issues.push({
          code: "raw_final_text_forbidden",
          emissionId: emission.emissionId,
          message:
            "Raw final text is not a Standard/Critical release path; emit a structured FinalCandidate.",
        });
        break;
    }
  }

  return {
    adapterId: input.contract.adapterId,
    substrate: input.contract.substrate,
    runId: input.contract.runId,
    status: issues.length === 0 ? "pass" : "fail",
    issues,
    toolCommandCount,
    finalCandidateCount,
  };
}

export function assertAdapterConformance(
  input: EvaluateAdapterConformanceInput,
): AdapterConformanceReport {
  const report = evaluateAdapterConformance(input);
  if (report.status === "fail") {
    throw new AdapterConformanceError(report);
  }

  return report;
}

export function asToolCallInterceptionContract(
  input: ToolCallInterceptionContract,
): ToolCallInterceptionContract {
  return {
    adapterId: input.adapterId,
    substrate: input.substrate,
    toolCommand: parseToolCommandRequest(input.toolCommand),
  };
}

export function asFinalCandidateConversionContract(
  input: FinalCandidateConversionContract,
): FinalCandidateConversionContract {
  return {
    adapterId: input.adapterId,
    substrate: input.substrate,
    finalCandidate: parseFinalCandidate(input.finalCandidate),
  };
}

function validateToolCommand(
  value: unknown,
  emissionId: string,
  runId: string,
): AdapterConformanceIssue[] {
  try {
    const parsed = parseToolCommandRequest(value);
    if (parsed.runId !== runId) {
      return [
        {
          code: "run_id_mismatch",
          emissionId,
          message: `ToolCommandRequest runId ${parsed.runId} does not match contract runId ${runId}.`,
        },
      ];
    }

    return [];
  } catch (error) {
    return [
      {
        code: "malformed_tool_command",
        emissionId,
        message: formatError(error),
      },
    ];
  }
}

function validateFinalCandidate(
  value: unknown,
  emissionId: string,
  runId: string,
): AdapterConformanceIssue[] {
  if (hasEmptyClaimsArray(value)) {
    return [
      {
        code: "final_candidate_without_claims",
        emissionId,
        message: "FinalCandidate must contain structured Claim objects.",
      },
    ];
  }

  try {
    const parsed = parseFinalCandidate(value);
    const issues: AdapterConformanceIssue[] = [];
    if (parsed.runId !== runId) {
      issues.push({
        code: "run_id_mismatch",
        emissionId,
        message: `FinalCandidate runId ${parsed.runId} does not match contract runId ${runId}.`,
      });
    }

    if (parsed.claims.length === 0) {
      issues.push({
        code: "final_candidate_without_claims",
        emissionId,
        message: "FinalCandidate must contain structured Claim objects.",
      });
    }

    return issues;
  } catch (error) {
    return [
      {
        code: "malformed_final_candidate",
        emissionId,
        message: formatError(error),
      },
    ];
  }
}

function hasEmptyClaimsArray(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "claims" in value &&
    Array.isArray(value.claims) &&
    value.claims.length === 0
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
