import {
  evaluateAdapterConformance,
  type AdapterBoundaryContract,
  type SubstrateEmission,
} from "@amca/adapters-conformance";
import { parseFinalCandidate, parseProposal } from "@amca/contracts";
import type { JsonObject, Proposal, ToolCommandRequest } from "@amca/protocol";

import type {
  ProviderChatCompletion,
  ProviderHarnessIssue,
  ProviderProposalResult,
  ProviderToolBinding,
  ProviderToolCallCandidate,
} from "./types.js";

const providerSubstrate = "custom";
const forbiddenAuthorityKeys = new Set([
  "admittedReceipt",
  "effectReceipt",
  "effectReceiptRecorded",
  "externalObservation",
  "externalStateObservation",
  "externalStateObserved",
  "finalReleased",
  "finalReleasedEvent",
  "humanApproval",
  "humanApprovalGranted",
  "mutationCommit",
  "mutationCommitted",
  "proof",
  "proofGenerated",
  "proofObject",
  "releaseDecided",
  "releaseDecision",
  "toolResult",
  "toolTrace",
]);

export interface NormalizeProviderCompletionInput {
  readonly adapterId?: string | undefined;
  readonly runId: string;
  readonly completion: ProviderChatCompletion;
  readonly tools?: readonly ProviderToolBinding[] | undefined;
}

export function normalizeProviderCompletion(
  input: NormalizeProviderCompletionInput,
): ProviderProposalResult {
  const adapterId = input.adapterId ?? "amca.provider.local.openai_compatible";
  const emissions: SubstrateEmission[] = [
    {
      kind: "substrate_state",
      emissionId: `provider_metadata:${input.runId}`,
      adapterId,
      substrate: providerSubstrate,
      runId: input.runId,
      state: metadataState(input.completion),
      usedAsEvidence: false,
    },
  ];
  const issues: ProviderHarnessIssue[] = [];
  const proposalCandidates: Proposal[] = [];
  const toolCommandCandidates: ToolCommandRequest[] = [];

  for (const toolCall of input.completion.toolCalls) {
    const normalized = toolCommandFromToolCall({
      adapterId,
      runId: input.runId,
      toolCall,
      tools: input.tools ?? [],
    });
    if (normalized.status === "blocked") {
      issues.push(...normalized.issues);
      continue;
    }
    toolCommandCandidates.push(normalized.toolCommand);
    proposalCandidates.push(normalized.toolCommand);
    emissions.push({
      kind: "tool_call",
      emissionId: `provider_tool_call:${toolCall.id}`,
      adapterId,
      substrate: providerSubstrate,
      runId: input.runId,
      toolCommand: normalized.toolCommand,
      metadata: {
        providerToolCallId: toolCall.id,
        proofUsable: false,
      },
    });
  }

  if (input.completion.content.trim().length > 0) {
    const contentResult = proposalFromContent({
      adapterId,
      runId: input.runId,
      content: input.completion.content,
      forbiddenProviderEvidenceIds: providerEvidenceIds(input.completion),
    });
    if (contentResult.status === "blocked") {
      issues.push(...contentResult.issues);
      emissions.push(...contentResult.emissions);
    } else {
      proposalCandidates.push(contentResult.proposal);
      emissions.push(contentResult.emission);
    }
  }

  if (proposalCandidates.length === 0 && issues.length === 0) {
    issues.push({
      code: "provider_no_structured_candidate",
      message:
        "Provider output did not include a structured AMCA proposal candidate.",
    });
  }

  const conformanceReport = evaluateAdapterConformance({
    contract: boundaryContract(adapterId, input.runId),
    emissions,
  });
  issues.push(...conformanceReport.issues);

  if (issues.length > 0 || conformanceReport.status === "fail") {
    return {
      status: "blocked",
      issues,
      proposalCandidates,
      toolCommandCandidates,
      emissions,
      conformanceReport,
      metadata: input.completion.metadata,
    };
  }

  return {
    status: "accepted",
    proposalCandidates,
    toolCommandCandidates,
    emissions,
    conformanceReport,
    metadata: input.completion.metadata,
  };
}

function proposalFromContent(input: {
  readonly adapterId: string;
  readonly runId: string;
  readonly content: string;
  readonly forbiddenProviderEvidenceIds: ReadonlySet<string>;
}):
  | {
      readonly status: "accepted";
      readonly proposal: Proposal;
      readonly emission: SubstrateEmission;
    }
  | {
      readonly status: "blocked";
      readonly issues: readonly ProviderHarnessIssue[];
      readonly emissions: readonly SubstrateEmission[];
    } {
  const parsedJson = parseStructuredJsonFromText(input.content);
  if (parsedJson.status === "blocked") {
    return {
      status: "blocked",
      issues: [
        {
          code: "provider_invalid_json",
          message:
            "Provider final output must be structured JSON for Standard/Critical paths.",
        },
      ],
      emissions: [
        {
          kind: "raw_final_text",
          emissionId: `provider_raw_final_text:${input.runId}`,
          adapterId: input.adapterId,
          substrate: providerSubstrate,
          runId: input.runId,
          text: input.content,
          metadata: { proofUsable: false },
        },
      ],
    };
  }

  const forbiddenPath = findForbiddenAuthorityPath(parsedJson.value);
  if (forbiddenPath !== undefined) {
    return {
      status: "blocked",
      issues: [
        {
          code: "provider_extra_authority_field",
          message:
            "Provider output attempted to include proof, receipt, release, or tool-result authority.",
          path: forbiddenPath,
        },
      ],
      emissions: [],
    };
  }

  const candidate = unwrapProposalCandidate(parsedJson.value);
  if (isDirectToolResult(candidate)) {
    return {
      status: "blocked",
      issues: [
        {
          code: "provider_direct_tool_result_forbidden",
          message:
            "Provider tool-result-shaped output is not an AMCA EffectReceipt.",
        },
      ],
      emissions: [],
    };
  }

  try {
    const proposal = parseProposal(candidate);
    if (proposal.kind === "mutation_command_request") {
      return {
        status: "blocked",
        issues: [
          {
            code: "provider_unsupported_proposal_kind",
            message:
              "Phase 62 provider harness accepts ToolCommandRequest and FinalCandidate proposals only.",
          },
        ],
        emissions: [],
      };
    }

    if (proposal.kind === "final_candidate") {
      const forbiddenEvidencePath = findProviderMetadataEvidenceRefPath(
        proposal,
        input.forbiddenProviderEvidenceIds,
      );

      if (forbiddenEvidencePath !== undefined) {
        return {
          status: "blocked",
          issues: [
            {
              code: "provider_metadata_evidence_ref_forbidden",
              message:
                "Provider response IDs and tool-call IDs are substrate metadata and cannot be used as AMCA evidence references.",
              path: forbiddenEvidencePath,
            },
          ],
          emissions: [],
        };
      }
    }

    return {
      status: "accepted",
      proposal,
      emission:
        proposal.kind === "final_candidate"
          ? {
              kind: "final_output",
              emissionId: `provider_final_candidate:${proposal.candidateId}`,
              adapterId: input.adapterId,
              substrate: providerSubstrate,
              runId: input.runId,
              finalCandidate: parseFinalCandidate(proposal),
              metadata: { proofUsable: false },
            }
          : {
              kind: "proposal",
              emissionId: `provider_proposal:${proposal.commandId}`,
              adapterId: input.adapterId,
              substrate: providerSubstrate,
              runId: input.runId,
              proposal,
              metadata: { proofUsable: false },
            },
    };
  } catch (error) {
    return {
      status: "blocked",
      issues: [
        {
          code: "provider_contract_invalid",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      emissions: [],
    };
  }
}

function toolCommandFromToolCall(input: {
  readonly adapterId: string;
  readonly runId: string;
  readonly toolCall: ProviderToolCallCandidate;
  readonly tools: readonly ProviderToolBinding[];
}):
  | { readonly status: "accepted"; readonly toolCommand: ToolCommandRequest }
  | {
      readonly status: "blocked";
      readonly issues: readonly ProviderHarnessIssue[];
    } {
  const binding = input.tools.find((tool) => tool.name === input.toolCall.name);
  if (binding === undefined) {
    return {
      status: "blocked",
      issues: [
        {
          code: "provider_tool_call_unknown",
          message: `Provider requested unknown tool ${input.toolCall.name}.`,
        },
      ],
    };
  }

  return {
    status: "accepted",
    toolCommand: {
      kind: "tool_command_request",
      commandId: `command_${sanitizeId(input.toolCall.id)}`,
      runId: input.runId,
      capabilityId: binding.capabilityId,
      toolId: binding.toolId,
      args: input.toolCall.arguments,
      sideEffectClass: binding.sideEffectClass,
      ...(binding.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: binding.idempotencyKey }),
    },
  };
}

function parseStructuredJsonFromText(
  text: string,
):
  | { readonly status: "accepted"; readonly value: unknown }
  | { readonly status: "blocked" } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { status: "blocked" };
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const jsonText = fenced?.[1] ?? trimmed;
  try {
    return { status: "accepted", value: JSON.parse(jsonText) as unknown };
  } catch {
    return { status: "blocked" };
  }
}

function unwrapProposalCandidate(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "proposal" in value &&
    Object.keys(value).every((key) => key === "proposal" || key === "metadata")
  ) {
    return (value as { readonly proposal: unknown }).proposal;
  }
  return value;
}

function findForbiddenAuthorityPath(
  value: unknown,
  path: readonly PropertyKey[] = [],
): readonly PropertyKey[] | undefined {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findForbiddenAuthorityPath(entry, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (typeof value !== "object" || value === null) return undefined;

  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenAuthorityKeys.has(key)) {
      return [...path, key];
    }
    const found = findForbiddenAuthorityPath(entry, [...path, key]);
    if (found !== undefined) return found;
  }

  return undefined;
}

function providerEvidenceIds(
  completion: ProviderChatCompletion,
): ReadonlySet<string> {
  const ids = new Set<string>();

  if (completion.metadata.responseId !== undefined) {
    addNonEmptyId(ids, completion.metadata.responseId);
  }

  for (const toolCallId of completion.metadata.toolCallIds) {
    addNonEmptyId(ids, toolCallId);
  }

  for (const toolCall of completion.toolCalls) {
    addNonEmptyId(ids, toolCall.id);
  }

  return ids;
}

function addNonEmptyId(ids: Set<string>, value: string): void {
  if (value.trim().length > 0) {
    ids.add(value);
  }
}

function findProviderMetadataEvidenceRefPath(
  proposal: Proposal,
  forbiddenEvidenceIds: ReadonlySet<string>,
): readonly PropertyKey[] | undefined {
  if (proposal.kind !== "final_candidate" || forbiddenEvidenceIds.size === 0) {
    return undefined;
  }

  for (const [claimIndex, claim] of proposal.claims.entries()) {
    for (const [evidenceIndex, evidenceRef] of claim.evidenceRefs.entries()) {
      if (forbiddenEvidenceIds.has(evidenceRef.evidenceId)) {
        return [
          "claims",
          claimIndex,
          "evidenceRefs",
          evidenceIndex,
          "evidenceId",
        ];
      }

      if (forbiddenEvidenceIds.has(evidenceRef.sourceEventId)) {
        return [
          "claims",
          claimIndex,
          "evidenceRefs",
          evidenceIndex,
          "sourceEventId",
        ];
      }
    }
  }

  return undefined;
}

function isDirectToolResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ["effect_receipt", "tool_result", "provider_tool_trace"].includes(
      String((value as { readonly kind: unknown }).kind),
    )
  );
}

function boundaryContract(
  adapterId: string,
  runId: string,
): AdapterBoundaryContract {
  return {
    adapterId,
    substrate: providerSubstrate,
    runId,
    canEmitToolCommandRequests: true,
    canEmitFinalCandidates: true,
    mustNotEmitEffectReceipts: true,
    mustNotEmitReleaseDecisions: true,
    mustNotTreatSubstrateStateAsEvidence: true,
  };
}

function metadataState(completion: ProviderChatCompletion): JsonObject {
  const metadata = completion.metadata;
  return {
    provider: metadata.provider,
    model: metadata.model,
    proofUsable: false,
    toolCallIds: [...metadata.toolCallIds],
    ...(metadata.responseId === undefined
      ? {}
      : { responseId: metadata.responseId }),
    ...(metadata.finishReason === undefined
      ? {}
      : { finishReason: metadata.finishReason }),
    ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
  };
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
