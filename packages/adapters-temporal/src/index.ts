import {
  type CertificationManifest,
  evaluateAdapterConformance,
  type AdapterBoundaryContract,
  type AdapterConformanceReport,
  type RawFinalTextEmission,
  type SubstrateEmission,
} from "@amca/adapters-conformance";
import {
  canonicalObjectHash,
  parseEffectRequest,
  parseFinalCandidate,
  parseRunEvent,
} from "@amca/contracts";
import type {
  ActivityOptions as TemporalSdkActivityOptions,
  RetryPolicy as TemporalSdkRetryPolicy,
} from "@temporalio/common";
import type {
  EffectRequest,
  FinalCandidate,
  ISODateTimeString,
  JsonObject,
  JsonValue,
  RunEvent,
  Sha256Hash,
} from "@amca/protocol";

export type TemporalIdempotencyKeySource = "effect_request" | "effect_identity";
export type TemporalActivityAuthority =
  | "amca_effect_request_candidate"
  | "amca_effect_receipt_recorded";
export type TemporalSdkActivityEnvelopeOptions = Pick<
  TemporalSdkActivityOptions,
  "activityId" | "retry" | "summary" | "taskQueue"
>;

export interface TemporalSdkTypeIntegration {
  readonly packageName: "@temporalio/common";
  readonly integrationKind: "type_only";
  readonly activityOptions: TemporalSdkActivityEnvelopeOptions;
}

export type TemporalBoundaryErrorCode =
  | "activity_options_mismatch"
  | "envelope_effect_request_mismatch"
  | "raw_workflow_output_forbidden"
  | "workflow_identity_mismatch"
  | "workflow_run_id_mismatch";

export class TemporalBoundaryError extends Error {
  readonly code: TemporalBoundaryErrorCode;

  constructor(code: TemporalBoundaryErrorCode, message: string) {
    super(message);
    this.name = "TemporalBoundaryError";
    this.code = code;
  }
}

export const TEMPORAL_ADAPTER_CERTIFICATION: CertificationManifest = {
  packageName: "@amca/adapters-temporal",
  adapterKind: "workflow_runtime",
  currentLevel: "level_1_proposal_adapter",
  targetLevel: "level_2_tool_intercepting",
  allowedAuthority: [
    "build deterministic Temporal activity envelopes from AMCA EffectRequest objects",
    "convert structured Temporal workflow outputs into AMCA FinalCandidate proposals",
    "correlate Temporal activity results to AMCA receipt events without granting proof authority",
    "assess Temporal history as operational metadata only",
  ],
  forbiddenAuthority: [
    "worker runtime execution",
    "receipt admission",
    "release decision",
    "proof authority",
  ],
  evidence: {
    phaseReports: ["docs/adapters.md#temporal-boundary-adapter"],
    missionTests: [
      "packages/testing/src/mission/substrate-containment.mission.test.ts",
    ],
    focusedCommands: [
      "pnpm exec vitest run packages/adapters-temporal/src/index.test.ts",
    ],
  },
};

export type TemporalAuthorityStatus =
  | "activity_result_only"
  | "temporal_history_only"
  | "temporal_retry_metadata_only"
  | "amca_effect_receipt_recorded"
  | "invalid_amca_receipt_correlation";

export interface TemporalWorkflowBoundaryOptions {
  readonly adapterId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowRunId?: string | undefined;
}

export interface TemporalWorkflowBoundaryDescriptor extends TemporalWorkflowBoundaryOptions {
  readonly substrate: "temporal";
}

export interface BuildTemporalActivityEnvelopeInput {
  readonly boundary: TemporalWorkflowBoundaryDescriptor;
  readonly effectRequest: EffectRequest;
  readonly activityId: string;
  readonly attempt?: number | undefined;
  readonly scheduledAt?: ISODateTimeString | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly temporalActivityOptions?:
    | TemporalSdkActivityEnvelopeOptions
    | undefined;
}

export interface TemporalActivityEffectEnvelope {
  readonly boundaryKind: "temporal_activity_effect_envelope";
  readonly envelopeVersion: 1;
  readonly adapterId: string;
  readonly substrate: "temporal";
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowRunId?: string | undefined;
  readonly activityId: string;
  readonly attempt: number;
  readonly effectId: string;
  readonly commandId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly sideEffectClass: EffectRequest["sideEffectClass"];
  readonly idempotencyKey: string;
  readonly idempotencyKeySource: TemporalIdempotencyKeySource;
  readonly requestedAt: ISODateTimeString;
  readonly scheduledAt?: ISODateTimeString | undefined;
  readonly effectRequestHash: Sha256Hash;
  readonly effectRequest: EffectRequest;
  readonly metadata?: JsonObject | undefined;
  readonly temporalSdk?: TemporalSdkTypeIntegration | undefined;
}

export interface TemporalActivityEffectCandidate {
  readonly candidateKind: "temporal_activity_effect_candidate";
  readonly authority: Extract<
    TemporalActivityAuthority,
    "amca_effect_request_candidate"
  >;
  readonly admissionRequired: "kernel_effect_request_admission";
  readonly canExecuteDirectly: false;
  readonly canEmitReceiptDirectly: false;
  readonly canSupportClaimDirectly: false;
  readonly envelope: TemporalActivityEffectEnvelope;
  readonly effectRequest: EffectRequest;
  readonly effectRequestHash: Sha256Hash;
}

export interface BuildTemporalActivityRetryEnvelopeInput {
  readonly previousEnvelope: TemporalActivityEffectEnvelope;
  readonly attempt: number;
  readonly activityId?: string | undefined;
  readonly scheduledAt?: ISODateTimeString | undefined;
  readonly retryPolicy?: TemporalSdkRetryPolicy | undefined;
}

export interface TemporalActivityResult {
  readonly status: "completed" | "failed" | "timed_out" | "cancelled";
  readonly completedAt: ISODateTimeString;
  readonly attempt: number;
  readonly result?: JsonObject | undefined;
  readonly errorType?: string | undefined;
}

export interface CorrelateTemporalActivityReceiptInput {
  readonly envelope: TemporalActivityEffectEnvelope;
  readonly activityResult: TemporalActivityResult;
  readonly effectReceiptRecordedEvent?: RunEvent | undefined;
}

export interface TemporalActivityReceiptCorrelation {
  readonly correlationKind: "temporal_activity_receipt_correlation";
  readonly runId: string;
  readonly effectId: string;
  readonly activityId: string;
  readonly idempotencyKey: string;
  readonly activityResultHash: Sha256Hash;
  readonly authority: TemporalAuthorityStatus;
  readonly effectReceiptRecordedEventId?: string | undefined;
  readonly receiptId?: string | undefined;
  readonly receiptPayloadHash?: Sha256Hash | undefined;
  readonly assessment: TemporalSubstrateAuthorityAssessment;
}

export interface TemporalWorkflowStructuredOutput {
  readonly kind: "structured_final_candidate";
  readonly finalCandidate: FinalCandidate;
  readonly workflowId?: string | undefined;
  readonly workflowRunId?: string | undefined;
}

export interface TemporalWorkflowRawTextOutput {
  readonly kind: "raw_text";
  readonly text: string;
  readonly workflowId?: string | undefined;
  readonly workflowRunId?: string | undefined;
}

export type TemporalWorkflowOutputBoundaryInput =
  | TemporalWorkflowStructuredOutput
  | TemporalWorkflowRawTextOutput;

export type TemporalWorkflowOutputAdapterInput =
  TemporalWorkflowOutputBoundaryInput & {
    readonly emissionId?: string | undefined;
  };

export interface TranslateTemporalWorkflowOutputInput {
  readonly boundary: TemporalWorkflowBoundaryDescriptor;
  readonly workflowOutput: TemporalWorkflowOutputBoundaryInput;
}

export interface TemporalHistoryEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly attributes?: JsonObject | undefined;
}

export interface TemporalHistoryObject {
  readonly workflowId: string;
  readonly workflowRunId?: string | undefined;
  readonly events: readonly TemporalHistoryEvent[];
}

export interface TemporalSubstrateAuthorityAssessment {
  readonly sourceKind:
    | "temporal_activity_result"
    | "temporal_history"
    | "temporal_retry_metadata";
  readonly status: TemporalAuthorityStatus;
  readonly requiredAmcaEventType: "EffectReceiptRecorded";
  readonly canSupportClaimDirectly: false;
  readonly canBeEvidenceRefDirectly: false;
  readonly canBeProofDirectly: false;
  readonly eligibleForKernelProof: boolean;
  readonly reason: string;
}

export interface TemporalLiveWorkerCertificationGap {
  readonly packageName: "@amca/adapters-temporal";
  readonly status: "blocked_without_approved_temporal_service";
  readonly workerRuntimeReady: false;
  readonly liveTemporalServiceUsed: false;
  readonly reason: string;
  readonly requiredApproval: "phase_scope_and_temporal_service_access";
}

export interface TemporalWorkerWrapperDescriptor extends TemporalWorkflowBoundaryDescriptor {
  readonly wrapperKind: "temporal_worker_wrapper_boundary";
  readonly canStartWorker: false;
  readonly canExecuteWorkflow: false;
  readonly canEmitReceiptDirectly: false;
  readonly canSupportClaimDirectly: false;
}

export interface TemporalActivityExecutionCandidate {
  readonly candidateKind: "temporal_activity_execution_candidate";
  readonly envelope: TemporalActivityEffectEnvelope;
  readonly effectCandidate: TemporalActivityEffectCandidate;
  readonly workerWrapper: TemporalWorkerWrapperDescriptor;
  readonly executionStatus: "not_started";
  readonly requiresApprovedTemporalService: true;
  readonly canStartWorker: false;
  readonly canEmitReceiptDirectly: false;
  readonly canSupportClaimDirectly: false;
}

export interface TemporalConformanceReportInput {
  readonly adapterId: string;
  readonly runId: string;
  readonly emissions: readonly SubstrateEmission[];
}

export class TemporalWorkflowBoundary {
  readonly adapterId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowRunId?: string | undefined;

  constructor(options: TemporalWorkflowBoundaryOptions) {
    this.adapterId = options.adapterId;
    this.runId = options.runId;
    this.workflowId = options.workflowId;
    this.workflowRunId = options.workflowRunId;
  }

  descriptor(): TemporalWorkflowBoundaryDescriptor {
    return {
      adapterId: this.adapterId,
      substrate: "temporal",
      runId: this.runId,
      workflowId: this.workflowId,
      ...(this.workflowRunId === undefined
        ? {}
        : { workflowRunId: this.workflowRunId }),
    };
  }

  buildActivityEnvelope(
    input: Omit<BuildTemporalActivityEnvelopeInput, "boundary">,
  ): TemporalActivityEffectEnvelope {
    return buildTemporalActivityEnvelope({
      boundary: this.descriptor(),
      ...input,
    });
  }

  buildRetryEnvelope(
    input: BuildTemporalActivityRetryEnvelopeInput,
  ): TemporalActivityEffectEnvelope {
    return buildTemporalActivityRetryEnvelope(input);
  }

  activityEffectCandidate(
    envelope: TemporalActivityEffectEnvelope,
  ): TemporalActivityEffectCandidate {
    return temporalActivityEnvelopeToEffectCandidate(envelope);
  }

  translateWorkflowOutput(
    input: TemporalWorkflowOutputBoundaryInput,
  ): FinalCandidate {
    return translateTemporalWorkflowOutputToFinalCandidate({
      boundary: this.descriptor(),
      workflowOutput: input,
    });
  }

  workflowOutputEmission(
    input: TemporalWorkflowOutputAdapterInput,
  ): SubstrateEmission {
    if (input.kind === "raw_text") {
      return this.rawWorkflowOutputEmission(input);
    }

    const finalCandidate = this.translateWorkflowOutput(input);

    return {
      kind: "final_output",
      emissionId:
        input.emissionId ?? `temporal_final:${finalCandidate.candidateId}`,
      adapterId: this.adapterId,
      substrate: "temporal",
      runId: this.runId,
      finalCandidate,
      metadata: temporalWorkflowCorrelationMetadata(this.descriptor(), input),
    };
  }

  rawWorkflowOutputEmission(
    input: TemporalWorkflowRawTextOutput & {
      readonly emissionId?: string | undefined;
    },
  ): RawFinalTextEmission {
    return {
      kind: "raw_final_text",
      emissionId: input.emissionId ?? "temporal_final:raw_text",
      adapterId: this.adapterId,
      substrate: "temporal",
      runId: this.runId,
      text: input.text,
      metadata: temporalWorkflowCorrelationMetadata(this.descriptor(), input),
    };
  }

  conformanceReport(
    emissions: readonly SubstrateEmission[],
  ): AdapterConformanceReport {
    return createTemporalConformanceReport({
      adapterId: this.adapterId,
      runId: this.runId,
      emissions,
    });
  }
}

export const TEMPORAL_LIVE_WORKER_CERTIFICATION_GAP: TemporalLiveWorkerCertificationGap =
  {
    packageName: "@amca/adapters-temporal",
    status: "blocked_without_approved_temporal_service",
    workerRuntimeReady: false,
    liveTemporalServiceUsed: false,
    reason:
      "Phase 53 provides worker-wrapper boundary shapes only; no Temporal service or worker is started without explicit phase approval.",
    requiredApproval: "phase_scope_and_temporal_service_access",
  };

export class TemporalWorkerBoundary {
  readonly #workflowBoundary: TemporalWorkflowBoundary;

  constructor(options: TemporalWorkflowBoundaryOptions) {
    this.#workflowBoundary = new TemporalWorkflowBoundary(options);
  }

  descriptor(): TemporalWorkerWrapperDescriptor {
    return {
      ...this.#workflowBoundary.descriptor(),
      wrapperKind: "temporal_worker_wrapper_boundary",
      canStartWorker: false,
      canExecuteWorkflow: false,
      canEmitReceiptDirectly: false,
      canSupportClaimDirectly: false,
    };
  }

  activityExecutionCandidate(
    input: Omit<BuildTemporalActivityEnvelopeInput, "boundary">,
  ): TemporalActivityExecutionCandidate {
    const envelope = this.#workflowBoundary.buildActivityEnvelope(input);
    return {
      candidateKind: "temporal_activity_execution_candidate",
      envelope,
      effectCandidate: temporalActivityEnvelopeToEffectCandidate(envelope),
      workerWrapper: this.descriptor(),
      executionStatus: "not_started",
      requiresApprovedTemporalService: true,
      canStartWorker: false,
      canEmitReceiptDirectly: false,
      canSupportClaimDirectly: false,
    };
  }

  liveCertificationGap(): TemporalLiveWorkerCertificationGap {
    return TEMPORAL_LIVE_WORKER_CERTIFICATION_GAP;
  }
}

export function buildTemporalActivityEnvelope(
  input: BuildTemporalActivityEnvelopeInput,
): TemporalActivityEffectEnvelope {
  const effectRequest = parseEffectRequest(input.effectRequest);
  assertBoundaryRunMatchesEffect(input.boundary, effectRequest);
  assertTemporalSdkActivityOptions(
    input.activityId,
    input.temporalActivityOptions,
  );
  const idempotency = temporalIdempotencyKeyFor(effectRequest);

  return {
    boundaryKind: "temporal_activity_effect_envelope",
    envelopeVersion: 1,
    adapterId: input.boundary.adapterId,
    substrate: "temporal",
    runId: input.boundary.runId,
    workflowId: input.boundary.workflowId,
    ...(input.boundary.workflowRunId === undefined
      ? {}
      : { workflowRunId: input.boundary.workflowRunId }),
    activityId: input.activityId,
    attempt: input.attempt ?? 1,
    effectId: effectRequest.effectId,
    commandId: effectRequest.commandId,
    capabilityId: effectRequest.capabilityId,
    toolId: effectRequest.toolId,
    sideEffectClass: effectRequest.sideEffectClass,
    idempotencyKey: idempotency.key,
    idempotencyKeySource: idempotency.source,
    requestedAt: effectRequest.requestedAt,
    ...(input.scheduledAt === undefined
      ? {}
      : { scheduledAt: input.scheduledAt }),
    effectRequestHash: canonicalObjectHash(effectRequestPayload(effectRequest)),
    effectRequest,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.temporalActivityOptions === undefined
      ? {}
      : {
          temporalSdk: {
            packageName: "@temporalio/common",
            integrationKind: "type_only",
            activityOptions: input.temporalActivityOptions,
          },
        }),
  };
}

export function buildTemporalActivityRetryEnvelope(
  input: BuildTemporalActivityRetryEnvelopeInput,
): TemporalActivityEffectEnvelope {
  const temporalSdk = temporalSdkForRetry(
    input.previousEnvelope.temporalSdk,
    input.retryPolicy,
  );

  return {
    ...input.previousEnvelope,
    activityId: input.activityId ?? input.previousEnvelope.activityId,
    attempt: input.attempt,
    ...(input.scheduledAt === undefined
      ? {}
      : { scheduledAt: input.scheduledAt }),
    ...(temporalSdk === undefined ? {} : { temporalSdk }),
  };
}

export function temporalActivityEnvelopeToEffectCandidate(
  envelope: TemporalActivityEffectEnvelope,
): TemporalActivityEffectCandidate {
  const effectRequest = parseEffectRequest(envelope.effectRequest);
  assertEnvelopeMatchesEffectRequest(envelope, effectRequest);

  return {
    candidateKind: "temporal_activity_effect_candidate",
    authority: "amca_effect_request_candidate",
    admissionRequired: "kernel_effect_request_admission",
    canExecuteDirectly: false,
    canEmitReceiptDirectly: false,
    canSupportClaimDirectly: false,
    envelope,
    effectRequest,
    effectRequestHash: envelope.effectRequestHash,
  };
}

export function temporalRetryPreservesIdempotency(
  original: TemporalActivityEffectEnvelope,
  retry: TemporalActivityEffectEnvelope,
): boolean {
  return (
    original.runId === retry.runId &&
    original.effectId === retry.effectId &&
    original.effectRequestHash === retry.effectRequestHash &&
    original.idempotencyKey === retry.idempotencyKey
  );
}

export function temporalIdempotencyKeyFor(effectRequest: EffectRequest): {
  readonly key: string;
  readonly source: TemporalIdempotencyKeySource;
} {
  const parsed = parseEffectRequest(effectRequest);

  if (parsed.idempotencyKey !== undefined) {
    return {
      key: parsed.idempotencyKey,
      source: "effect_request",
    };
  }

  return {
    key: `amca-temporal:${parsed.runId}:${parsed.effectId}`,
    source: "effect_identity",
  };
}

export function correlateTemporalActivityReceipt(
  input: CorrelateTemporalActivityReceiptInput,
): TemporalActivityReceiptCorrelation {
  const activityResultHash = canonicalObjectHash(
    temporalActivityResultPayload(input.activityResult),
  );
  const base = {
    correlationKind: "temporal_activity_receipt_correlation" as const,
    runId: input.envelope.runId,
    effectId: input.envelope.effectId,
    activityId: input.envelope.activityId,
    idempotencyKey: input.envelope.idempotencyKey,
    activityResultHash,
  };

  if (input.effectReceiptRecordedEvent === undefined) {
    return {
      ...base,
      authority: "activity_result_only",
      assessment: activityResultAssessment("activity_result_only", false),
    };
  }

  const parsedEvent = parseRunEvent(input.effectReceiptRecordedEvent);
  if (!isEffectReceiptRecordedEvent(parsedEvent)) {
    return {
      ...base,
      authority: "invalid_amca_receipt_correlation",
      assessment: activityResultAssessment(
        "invalid_amca_receipt_correlation",
        false,
      ),
    };
  }

  const { receipt } = parsedEvent.payload;
  if (
    receipt.runId !== input.envelope.runId ||
    receipt.effectId !== input.envelope.effectId
  ) {
    return {
      ...base,
      authority: "invalid_amca_receipt_correlation",
      effectReceiptRecordedEventId: parsedEvent.eventId,
      receiptId: receipt.receiptId,
      receiptPayloadHash: receipt.payloadHash,
      assessment: activityResultAssessment(
        "invalid_amca_receipt_correlation",
        false,
      ),
    };
  }

  return {
    ...base,
    authority: "amca_effect_receipt_recorded",
    effectReceiptRecordedEventId: parsedEvent.eventId,
    receiptId: receipt.receiptId,
    receiptPayloadHash: receipt.payloadHash,
    assessment: activityResultAssessment("amca_effect_receipt_recorded", true),
  };
}

export function translateTemporalWorkflowOutputToFinalCandidate(
  input: TranslateTemporalWorkflowOutputInput,
): FinalCandidate {
  if (input.workflowOutput.kind === "raw_text") {
    throw new TemporalBoundaryError(
      "raw_workflow_output_forbidden",
      "Temporal workflow output must be a structured AMCA FinalCandidate before release evaluation.",
    );
  }

  assertWorkflowIdentity(input.boundary, input.workflowOutput);
  const finalCandidate = parseFinalCandidate(
    input.workflowOutput.finalCandidate,
  );
  if (finalCandidate.runId !== input.boundary.runId) {
    throw new TemporalBoundaryError(
      "workflow_run_id_mismatch",
      `Temporal workflow output runId ${finalCandidate.runId} does not match boundary runId ${input.boundary.runId}.`,
    );
  }

  return finalCandidate;
}

export function assessTemporalHistoryAuthority(
  history: TemporalHistoryObject,
): TemporalSubstrateAuthorityAssessment {
  return {
    sourceKind: "temporal_history",
    status: "temporal_history_only",
    requiredAmcaEventType: "EffectReceiptRecorded",
    canSupportClaimDirectly: false,
    canBeEvidenceRefDirectly: false,
    canBeProofDirectly: false,
    eligibleForKernelProof: false,
    reason: `Temporal history for ${history.workflowId} has ${String(history.events.length)} operational events, but it is not AMCA evidence or proof.`,
  };
}

export function assessTemporalRetryMetadataAuthority(
  envelope: TemporalActivityEffectEnvelope,
): TemporalSubstrateAuthorityAssessment {
  return {
    sourceKind: "temporal_retry_metadata",
    status: "temporal_retry_metadata_only",
    requiredAmcaEventType: "EffectReceiptRecorded",
    canSupportClaimDirectly: false,
    canBeEvidenceRefDirectly: false,
    canBeProofDirectly: false,
    eligibleForKernelProof: false,
    reason: `Temporal retry metadata for ${envelope.activityId} attempt ${String(envelope.attempt)} is correlation data, not a fresh external observation.`,
  };
}

export function createTemporalAdapterBoundaryContract(input: {
  readonly adapterId: string;
  readonly runId: string;
}): AdapterBoundaryContract {
  return {
    adapterId: input.adapterId,
    substrate: "temporal",
    runId: input.runId,
    canEmitToolCommandRequests: true,
    canEmitFinalCandidates: true,
    mustNotEmitEffectReceipts: true,
    mustNotEmitReleaseDecisions: true,
    mustNotTreatSubstrateStateAsEvidence: true,
  };
}

export function createTemporalConformanceReport(
  input: TemporalConformanceReportInput,
): AdapterConformanceReport {
  return evaluateAdapterConformance({
    contract: createTemporalAdapterBoundaryContract(input),
    emissions: input.emissions,
  });
}

export function temporalHistoryPayload(
  history: TemporalHistoryObject,
): JsonValue {
  return {
    workflowId: history.workflowId,
    ...(history.workflowRunId === undefined
      ? {}
      : { workflowRunId: history.workflowRunId }),
    events: history.events.map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      ...(event.attributes === undefined
        ? {}
        : { attributes: event.attributes }),
    })),
  };
}

export function temporalRetryMetadataPayload(
  envelope: TemporalActivityEffectEnvelope,
): JsonValue {
  return {
    runId: envelope.runId,
    workflowId: envelope.workflowId,
    ...(envelope.workflowRunId === undefined
      ? {}
      : { workflowRunId: envelope.workflowRunId }),
    activityId: envelope.activityId,
    attempt: envelope.attempt,
    effectId: envelope.effectId,
    idempotencyKey: envelope.idempotencyKey,
    ...(envelope.scheduledAt === undefined
      ? {}
      : { scheduledAt: envelope.scheduledAt }),
  };
}

function activityResultAssessment(
  status: Exclude<
    TemporalAuthorityStatus,
    "temporal_history_only" | "temporal_retry_metadata_only"
  >,
  eligibleForKernelProof: boolean,
): TemporalSubstrateAuthorityAssessment {
  return {
    sourceKind: "temporal_activity_result",
    status,
    requiredAmcaEventType: "EffectReceiptRecorded",
    canSupportClaimDirectly: false,
    canBeEvidenceRefDirectly: false,
    canBeProofDirectly: false,
    eligibleForKernelProof,
    reason:
      status === "amca_effect_receipt_recorded"
        ? "An AMCA EffectReceiptRecorded event is available for kernel proof evaluation; the Temporal activity result still cannot prove a claim directly."
        : "Temporal activity results are operational recovery data until an AMCA EffectReceiptRecorded event admits a governed receipt.",
  };
}

function assertBoundaryRunMatchesEffect(
  boundary: TemporalWorkflowBoundaryDescriptor,
  effectRequest: EffectRequest,
): void {
  if (boundary.runId !== effectRequest.runId) {
    throw new Error(
      `Temporal boundary runId ${boundary.runId} does not match EffectRequest runId ${effectRequest.runId}.`,
    );
  }
}

function assertTemporalSdkActivityOptions(
  activityId: string,
  temporalActivityOptions: TemporalSdkActivityEnvelopeOptions | undefined,
): void {
  if (
    temporalActivityOptions?.activityId !== undefined &&
    temporalActivityOptions.activityId !== activityId
  ) {
    throw new TemporalBoundaryError(
      "activity_options_mismatch",
      `Temporal activityOptions.activityId ${temporalActivityOptions.activityId} does not match envelope activityId ${activityId}.`,
    );
  }
}

function assertEnvelopeMatchesEffectRequest(
  envelope: TemporalActivityEffectEnvelope,
  effectRequest: EffectRequest,
): void {
  if (
    envelope.runId !== effectRequest.runId ||
    envelope.effectId !== effectRequest.effectId ||
    envelope.commandId !== effectRequest.commandId ||
    envelope.capabilityId !== effectRequest.capabilityId ||
    envelope.toolId !== effectRequest.toolId ||
    envelope.sideEffectClass !== effectRequest.sideEffectClass
  ) {
    throw new TemporalBoundaryError(
      "envelope_effect_request_mismatch",
      "Temporal activity envelope identity does not match its embedded AMCA EffectRequest.",
    );
  }
}

function assertWorkflowIdentity(
  boundary: TemporalWorkflowBoundaryDescriptor,
  output: TemporalWorkflowStructuredOutput,
): void {
  if (
    output.workflowId !== undefined &&
    output.workflowId !== boundary.workflowId
  ) {
    throw new TemporalBoundaryError(
      "workflow_identity_mismatch",
      `Temporal workflow output workflowId ${output.workflowId} does not match boundary workflowId ${boundary.workflowId}.`,
    );
  }

  if (
    output.workflowRunId !== undefined &&
    boundary.workflowRunId !== undefined &&
    output.workflowRunId !== boundary.workflowRunId
  ) {
    throw new TemporalBoundaryError(
      "workflow_identity_mismatch",
      `Temporal workflow output workflowRunId ${output.workflowRunId} does not match boundary workflowRunId ${boundary.workflowRunId}.`,
    );
  }
}

function temporalWorkflowCorrelationMetadata(
  boundary: TemporalWorkflowBoundaryDescriptor,
  output: TemporalWorkflowOutputBoundaryInput,
): JsonObject {
  const workflowRunId = output.workflowRunId ?? boundary.workflowRunId;

  return {
    workflowId: output.workflowId ?? boundary.workflowId,
    ...(workflowRunId === undefined ? {} : { workflowRunId }),
    metadataOnly: true,
    proofRole: "none",
    truthAuthority: "amca_semantic_events",
  };
}

function temporalSdkForRetry(
  previousSdk: TemporalSdkTypeIntegration | undefined,
  retryPolicy: TemporalSdkRetryPolicy | undefined,
): TemporalSdkTypeIntegration | undefined {
  if (retryPolicy === undefined) {
    return previousSdk;
  }

  return {
    packageName: "@temporalio/common",
    integrationKind: "type_only",
    activityOptions: {
      ...(previousSdk?.activityOptions ?? {}),
      retry: retryPolicy,
    },
  };
}

function effectRequestPayload(effectRequest: EffectRequest): JsonObject {
  return {
    effectId: effectRequest.effectId,
    commandId: effectRequest.commandId,
    runId: effectRequest.runId,
    capabilityId: effectRequest.capabilityId,
    toolId: effectRequest.toolId,
    args: effectRequest.args,
    sideEffectClass: effectRequest.sideEffectClass,
    requestedAt: effectRequest.requestedAt,
    ...(effectRequest.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: effectRequest.idempotencyKey }),
  };
}

function temporalActivityResultPayload(
  activityResult: TemporalActivityResult,
): JsonObject {
  return {
    status: activityResult.status,
    completedAt: activityResult.completedAt,
    attempt: activityResult.attempt,
    ...(activityResult.result === undefined
      ? {}
      : { result: activityResult.result }),
    ...(activityResult.errorType === undefined
      ? {}
      : { errorType: activityResult.errorType }),
  };
}

function isEffectReceiptRecordedEvent(
  event: RunEvent,
): event is RunEvent<"EffectReceiptRecorded"> {
  return event.type === "EffectReceiptRecorded";
}
