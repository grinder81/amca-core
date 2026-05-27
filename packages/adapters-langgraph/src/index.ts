import {
  assertAdapterConformance,
  type CertificationManifest,
  evaluateAdapterConformance,
  type AdapterBoundaryContract,
  type AdapterConformanceReport,
  type RawFinalTextEmission,
  type SubstrateEmission,
  type SubstrateStateEmission,
  type ToolCallEmission,
} from "@amca/adapters-conformance";
import { parseFinalCandidate, parseToolCommandRequest } from "@amca/contracts";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type {
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  JsonValue,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";

export const LANGGRAPH_SUBSTRATE = "langgraph" as const;

export const LANGGRAPH_ADAPTER_CERTIFICATION: CertificationManifest = {
  packageName: "@amca/adapters-langgraph",
  adapterKind: "agent_runtime",
  currentLevel: "level_2_tool_intercepting",
  targetLevel: "level_3_replay_certified",
  allowedAuthority: [
    "invoke deterministic LangGraph runtime graphs for proposal-boundary conversion",
    "translate LangGraph tool-call-shaped inputs into ToolCommandRequest proposals",
    "translate structured LangGraph final outputs into FinalCandidate proposals",
    "emit LangGraph checkpoint correlation as metadata only",
  ],
  forbiddenAuthority: [
    "external model execution",
    "external tool execution",
    "receipt admission",
    "release decision",
    "proof authority",
  ],
  evidence: {
    phaseReports: ["docs/adapters.md#langgraph-boundary-adapter"],
    missionTests: [
      "packages/testing/src/mission/substrate-containment.mission.test.ts#langgraph-runtime-bridge-tool-call-interception",
    ],
    focusedCommands: [
      "pnpm exec vitest run packages/adapters-langgraph/src/index.test.ts",
    ],
  },
};

export type LangGraphBoundaryErrorCode = "raw_final_text_forbidden";

export class LangGraphBoundaryError extends Error {
  readonly code: LangGraphBoundaryErrorCode;

  constructor(code: LangGraphBoundaryErrorCode, message: string) {
    super(message);
    this.name = "LangGraphBoundaryError";
    this.code = code;
  }
}

export interface LangGraphBoundaryAdapterOptions {
  readonly adapterId?: string | undefined;
  readonly runId: string;
}

export interface LangGraphRunCorrelation {
  readonly runId: string;
  readonly threadId?: string | undefined;
  readonly graphId?: string | undefined;
  readonly nodeId?: string | undefined;
}

export interface LangGraphCheckpointCorrelation {
  readonly checkpointId: string;
  readonly threadId?: string | undefined;
  readonly graphId?: string | undefined;
  readonly nodeId?: string | undefined;
}

export interface LangGraphToolCallBoundaryInput {
  readonly toolCallId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly args: JsonObject;
  readonly sideEffectClass: SideEffectClass;
  readonly commandId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly requiredEvidence?: readonly EvidenceRef[] | undefined;
  readonly checkpoint?: LangGraphCheckpointCorrelation | undefined;
}

export type LangGraphToolCallAdapterInput = Omit<
  LangGraphToolCallBoundaryInput,
  "runId"
> & {
  readonly emissionId?: string | undefined;
};

export interface LangGraphStructuredFinalOutput {
  readonly kind: "structured_final_candidate";
  readonly finalCandidate: FinalCandidate;
  readonly checkpoint?: LangGraphCheckpointCorrelation | undefined;
}

export interface LangGraphRawFinalOutput {
  readonly kind: "raw_text";
  readonly text: string;
  readonly checkpoint?: LangGraphCheckpointCorrelation | undefined;
}

export type LangGraphFinalOutputBoundaryInput =
  | LangGraphStructuredFinalOutput
  | LangGraphRawFinalOutput;

export type LangGraphFinalOutputAdapterInput =
  LangGraphFinalOutputBoundaryInput & {
    readonly emissionId?: string | undefined;
  };

export interface LangGraphStateMetadataInput {
  readonly emissionId?: string | undefined;
  readonly state: JsonObject;
  readonly checkpoint?: LangGraphCheckpointCorrelation | undefined;
  readonly usedAsEvidence?: boolean | undefined;
}

export interface LangGraphProposalBridgeState {
  readonly toolCalls?: readonly LangGraphToolCallAdapterInput[] | undefined;
  readonly finalOutput?: LangGraphFinalOutputAdapterInput | undefined;
  readonly substrateStates?: readonly LangGraphStateMetadataInput[] | undefined;
}

export interface LangGraphProposalGraph {
  invoke(
    input: JsonObject,
    config?: LangGraphRunnableConfig,
  ): Promise<LangGraphProposalBridgeState>;
}

export interface InvokeLangGraphProposalBridgeInput {
  readonly graph: LangGraphProposalGraph;
  readonly adapter: LangGraphBoundaryAdapter;
  readonly input: JsonObject;
  readonly config?: LangGraphRunnableConfig | undefined;
}

export interface LangGraphProposalBridgeResult {
  readonly state: LangGraphProposalBridgeState;
  readonly emissions: readonly SubstrateEmission[];
  readonly toolCommands: readonly ToolCommandRequest[];
  readonly finalCandidates: readonly FinalCandidate[];
  readonly conformanceReport: AdapterConformanceReport;
}

export interface InvokeLangGraphRuntimeBridgeInput extends InvokeLangGraphProposalBridgeInput {}

export interface LangGraphRuntimeBridgeResult extends LangGraphProposalBridgeResult {
  readonly bridgeKind: "langgraph_runtime_bridge";
  readonly runtimeExecution: "deterministic_graph_invoke_only";
  readonly externalToolExecution: false;
  readonly proofAuthority: false;
  readonly releaseAuthority: false;
}

export interface EvaluateLangGraphConformanceInput {
  readonly adapterId: string;
  readonly runId: string;
  readonly emissions: readonly SubstrateEmission[];
}

export class LangGraphBoundaryAdapter {
  readonly adapterId: string;
  readonly runId: string;

  constructor(options: LangGraphBoundaryAdapterOptions) {
    this.adapterId = options.adapterId ?? "amca.langgraph.boundary";
    this.runId = options.runId;
  }

  boundaryContract(): AdapterBoundaryContract {
    return createLangGraphBoundaryContract({
      adapterId: this.adapterId,
      runId: this.runId,
    });
  }

  translateToolCall(input: LangGraphToolCallAdapterInput): ToolCommandRequest {
    return translateLangGraphToolCallToToolCommandRequest({
      ...input,
      runId: this.runId,
    });
  }

  toolCallEmission(input: LangGraphToolCallAdapterInput): ToolCallEmission {
    const toolCommand = this.translateToolCall(input);

    return {
      kind: "tool_call",
      emissionId: input.emissionId ?? `langgraph_tool:${input.toolCallId}`,
      adapterId: this.adapterId,
      substrate: LANGGRAPH_SUBSTRATE,
      runId: this.runId,
      toolCommand,
      metadata: metadataForCheckpoint(this.runId, input.checkpoint),
    };
  }

  translateFinalOutput(
    input: LangGraphFinalOutputBoundaryInput,
  ): FinalCandidate {
    return translateLangGraphFinalOutputToFinalCandidate(input);
  }

  finalOutputEmission(
    input: LangGraphFinalOutputAdapterInput,
  ): SubstrateEmission {
    if (input.kind === "raw_text") {
      return this.rawFinalTextEmission(input);
    }

    const finalCandidate = this.translateFinalOutput(input);

    return {
      kind: "final_output",
      emissionId:
        input.emissionId ?? `langgraph_final:${finalCandidate.candidateId}`,
      adapterId: this.adapterId,
      substrate: LANGGRAPH_SUBSTRATE,
      runId: this.runId,
      finalCandidate,
      metadata: metadataForCheckpoint(this.runId, input.checkpoint),
    };
  }

  rawFinalTextEmission(
    input: LangGraphRawFinalOutput & {
      readonly emissionId?: string | undefined;
    },
  ): RawFinalTextEmission {
    return {
      kind: "raw_final_text",
      emissionId: input.emissionId ?? "langgraph_final:raw_text",
      adapterId: this.adapterId,
      substrate: LANGGRAPH_SUBSTRATE,
      runId: this.runId,
      text: input.text,
      metadata: metadataForCheckpoint(this.runId, input.checkpoint),
    };
  }

  stateMetadataEmission(
    input: LangGraphStateMetadataInput,
  ): SubstrateStateEmission {
    return {
      kind: "substrate_state",
      emissionId: input.emissionId ?? "langgraph_state:metadata",
      adapterId: this.adapterId,
      substrate: LANGGRAPH_SUBSTRATE,
      runId: this.runId,
      state: input.state,
      usedAsEvidence: input.usedAsEvidence ?? false,
      metadata: metadataForCheckpoint(this.runId, input.checkpoint),
    };
  }

  evaluateConformance(
    emissions: readonly SubstrateEmission[],
  ): AdapterConformanceReport {
    return evaluateLangGraphBoundaryConformance({
      adapterId: this.adapterId,
      runId: this.runId,
      emissions,
    });
  }

  assertConformance(
    emissions: readonly SubstrateEmission[],
  ): AdapterConformanceReport {
    return assertLangGraphBoundaryConformance({
      adapterId: this.adapterId,
      runId: this.runId,
      emissions,
    });
  }
}

export function translateLangGraphToolCallToToolCommandRequest(
  input: LangGraphToolCallBoundaryInput,
): ToolCommandRequest {
  const candidate: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId: input.commandId ?? `langgraph_command:${input.toolCallId}`,
    runId: input.runId,
    capabilityId: input.capabilityId,
    toolId: input.toolId,
    args: input.args,
    sideEffectClass: input.sideEffectClass,
  };

  const withIdempotency = addOptionalString(
    candidate,
    "idempotencyKey",
    input.idempotencyKey,
  );

  return parseToolCommandRequest(
    input.requiredEvidence === undefined
      ? withIdempotency
      : {
          ...withIdempotency,
          requiredEvidence: [...input.requiredEvidence],
        },
  );
}

export function translateLangGraphFinalOutputToFinalCandidate(
  input: LangGraphFinalOutputBoundaryInput,
): FinalCandidate {
  if (input.kind === "raw_text") {
    throw new LangGraphBoundaryError(
      "raw_final_text_forbidden",
      "LangGraph raw final text cannot bypass structured FinalCandidate conversion.",
    );
  }

  return parseFinalCandidate(input.finalCandidate);
}

export async function invokeLangGraphProposalBridge(
  input: InvokeLangGraphProposalBridgeInput,
): Promise<LangGraphProposalBridgeResult> {
  const state = await input.graph.invoke(input.input, input.config);
  const emissions: SubstrateEmission[] = [];

  for (const toolCall of state.toolCalls ?? []) {
    emissions.push(input.adapter.toolCallEmission(toolCall));
  }

  if (state.finalOutput !== undefined) {
    emissions.push(input.adapter.finalOutputEmission(state.finalOutput));
  }

  for (const substrateState of state.substrateStates ?? []) {
    emissions.push(input.adapter.stateMetadataEmission(substrateState));
  }

  const conformanceReport = input.adapter.evaluateConformance(emissions);

  return {
    state,
    emissions,
    toolCommands: emissions.flatMap((emission) =>
      emission.kind === "tool_call" ? [emission.toolCommand] : [],
    ),
    finalCandidates: emissions.flatMap((emission) =>
      emission.kind === "final_output" ? [emission.finalCandidate] : [],
    ),
    conformanceReport,
  };
}

export async function invokeLangGraphRuntimeBridge(
  input: InvokeLangGraphRuntimeBridgeInput,
): Promise<LangGraphRuntimeBridgeResult> {
  const result = await invokeLangGraphProposalBridge(input);
  return {
    ...result,
    bridgeKind: "langgraph_runtime_bridge",
    runtimeExecution: "deterministic_graph_invoke_only",
    externalToolExecution: false,
    proofAuthority: false,
    releaseAuthority: false,
  };
}

export function createLangGraphBoundaryContract(input: {
  readonly adapterId: string;
  readonly runId: string;
}): AdapterBoundaryContract {
  return {
    adapterId: input.adapterId,
    substrate: LANGGRAPH_SUBSTRATE,
    runId: input.runId,
    canEmitToolCommandRequests: true,
    canEmitFinalCandidates: true,
    mustNotEmitEffectReceipts: true,
    mustNotEmitReleaseDecisions: true,
    mustNotTreatSubstrateStateAsEvidence: true,
  };
}

export function evaluateLangGraphBoundaryConformance(
  input: EvaluateLangGraphConformanceInput,
): AdapterConformanceReport {
  return evaluateAdapterConformance({
    contract: createLangGraphBoundaryContract({
      adapterId: input.adapterId,
      runId: input.runId,
    }),
    emissions: input.emissions,
  });
}

export function assertLangGraphBoundaryConformance(
  input: EvaluateLangGraphConformanceInput,
): AdapterConformanceReport {
  return assertAdapterConformance({
    contract: createLangGraphBoundaryContract({
      adapterId: input.adapterId,
      runId: input.runId,
    }),
    emissions: input.emissions,
  });
}

export function createLangGraphRunCorrelationMetadata(
  input: LangGraphRunCorrelation,
): JsonObject {
  const metadata: Record<string, JsonValue> = {
    substrate: LANGGRAPH_SUBSTRATE,
    amcaRunId: input.runId,
    boundaryRole: "execution_metadata",
    metadataOnly: true,
    truthAuthority: "amca_semantic_events",
  };

  addOptionalJsonString(metadata, "threadId", input.threadId);
  addOptionalJsonString(metadata, "graphId", input.graphId);
  addOptionalJsonString(metadata, "nodeId", input.nodeId);

  return metadata;
}

export function createLangGraphCheckpointMetadata(input: {
  readonly runId: string;
  readonly checkpoint: LangGraphCheckpointCorrelation;
}): JsonObject {
  const metadata: Record<string, JsonValue> = {
    ...createLangGraphRunCorrelationMetadata({
      runId: input.runId,
      threadId: input.checkpoint.threadId,
      graphId: input.checkpoint.graphId,
      nodeId: input.checkpoint.nodeId,
    }),
    checkpointId: input.checkpoint.checkpointId,
    checkpointRole: "correlation_only",
    proofRole: "none",
  };

  return metadata;
}

function metadataForCheckpoint(
  runId: string,
  checkpoint: LangGraphCheckpointCorrelation | undefined,
): JsonObject {
  if (checkpoint === undefined) {
    return createLangGraphRunCorrelationMetadata({ runId });
  }

  return createLangGraphCheckpointMetadata({ runId, checkpoint });
}

function addOptionalJsonString(
  target: Record<string, JsonValue>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function addOptionalString<T extends object, K extends string>(
  target: T,
  key: K,
  value: string | undefined,
): T & Partial<Record<K, string>> {
  if (value === undefined) {
    return target;
  }

  return {
    ...target,
    [key]: value,
  };
}
