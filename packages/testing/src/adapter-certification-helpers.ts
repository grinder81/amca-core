import type { CapabilityContract } from "@amca/capabilities";
import type {
  AdapterCertification,
  AdapterIdempotencyPosture,
  AdapterRiskProfile,
  CertifiedEffectRequest,
  EffectAdapter,
  EffectAdapterContext,
  EffectAdapterResult,
} from "@amca/effect-sdk";
import { hashRunEventPayload } from "@amca/kernel";
import type {
  Claim,
  EffectReceipt,
  EvidenceRef,
  ExternalStateObservation,
  ExternalStateObservationCandidate,
  FinalCandidate,
  JsonObject,
  PendingEvidenceRef,
  ReceiptCandidate,
  RunEventType,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";

export const CERTIFIED_ADAPTER_STARTED_AT = "2026-05-24T11:58:00.000Z";
export const CERTIFIED_ADAPTER_NOW = "2026-05-24T12:00:00.000Z";
export const CERTIFIED_ADAPTER_REEVALUATED_AT = "2026-05-24T12:01:00.000Z";
export const CERTIFIED_ADAPTER_OBSERVED_AT = "2026-05-24T11:59:30.000Z";
export const CERTIFIED_ADAPTER_EXPIRES_AT = "2026-05-24T12:05:00.000Z";

export type CertifiedAdapterKind =
  | "deterministic_fake"
  | "external_read"
  | "external_write";

export interface CertifiedFakeEffectAdapter {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly certification: AdapterCertification;
  execute(
    request: CertifiedEffectRequest,
    context: EffectAdapterContext,
  ): EffectAdapterResult | Promise<EffectAdapterResult>;
}

export interface CertifiedTestResultAdapterFixture {
  readonly adapter: EffectAdapter;
  readonly certifiedAdapter: CertifiedFakeEffectAdapter;
  readonly calls: ToolCommandRequest[];
  readonly capability: CapabilityContract;
  readonly claim: Claim;
  readonly command: ToolCommandRequest;
  readonly finalCandidate: FinalCandidate;
  readonly receiptType: string;
}

export interface CertifiedObservationAdapterFixture {
  readonly adapter: EffectAdapter;
  readonly certifiedAdapter: CertifiedFakeEffectAdapter;
  readonly calls: ToolCommandRequest[];
  readonly capability: CapabilityContract;
  readonly command: ToolCommandRequest;
  readonly externalStateObservation: ExternalStateObservation;
  readonly observationType: string;
  readonly receipt: EffectReceipt;
  readonly receiptType: string;
}

export function certifiedTestResultAdapterFixture(input: {
  readonly runId: string;
  readonly adapterKind?: CertifiedAdapterKind;
  readonly capabilityId?: string;
  readonly declaredReceiptTypes?: readonly string[];
  readonly idempotencyKey?: string;
  readonly receiptType?: string;
  readonly result?: "passed" | "failed";
  readonly sideEffectClass?: SideEffectClass;
  readonly toolId?: string;
}): CertifiedTestResultAdapterFixture {
  const capabilityId =
    input.capabilityId ?? "mission.adapter_certification.run_tests";
  const toolId = input.toolId ?? "mission.adapter_certification.run_tests";
  const sideEffectClass = input.sideEffectClass ?? "compute";
  const receiptType = input.receiptType ?? "test_run";
  const commandId = `cmd_${sanitizeId(input.runId)}`;
  const payload = testResultPayload(input.result ?? "passed");
  const payloadHash = hashRunEventPayload(payload);
  const expectedEvidenceRef = effectEvidenceRef({
    evidenceId: `ev_${commandId}`,
    hash: payloadHash,
    sourceEventId: receiptEventIdForCommand(commandId),
  });
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId,
    runId: input.runId,
    capabilityId,
    toolId,
    args: {
      testSuiteId: "mission",
    },
    sideEffectClass,
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
  };
  const calls: ToolCommandRequest[] = [];
  const certifiedAdapter = certifiedFakeEffectAdapter({
    adapterId: `adapter.${toolId}`,
    capabilityId,
    declaredReceiptTypes: input.declaredReceiptTypes ?? [receiptType],
    declaredObservationTypes: [],
    sideEffectClass,
    toolId,
    ...(input.adapterKind === undefined
      ? {}
      : { adapterKind: input.adapterKind }),
    execute: (request) => {
      calls.push(request.toolCommand);

      return {
        receiptCandidate: effectReceiptCandidateForRequest(
          request.effectRequest,
          {
            evidence: [
              pendingEffectEvidenceRef({
                evidenceId: `ev_${request.toolCommand.commandId}`,
                hash: payloadHash,
              }),
            ],
            payload,
            payloadHash,
            receiptType,
          },
        ),
      };
    },
  });
  const claim = testResultClaim({
    capabilityId,
    evidenceRef: expectedEvidenceRef,
    runId: input.runId,
  });

  return {
    adapter: asEffectAdapter(certifiedAdapter),
    certifiedAdapter,
    calls,
    capability: testResultCapability({
      capabilityId,
      receiptType,
      sideEffectClass,
    }),
    claim,
    command,
    finalCandidate: {
      kind: "final_candidate",
      candidateId: `candidate_${sanitizeId(input.runId)}`,
      runId: input.runId,
      claims: [claim],
      narrativeDraft: "Tests passed.",
    },
    receiptType,
  };
}

export function certifiedObservationAdapterFixture(input: {
  readonly runId: string;
  readonly adapterKind?: CertifiedAdapterKind;
  readonly capabilityId?: string;
  readonly declaredObservationTypes?: readonly string[];
  readonly declaredReceiptTypes?: readonly string[];
  readonly observedState?: JsonObject;
  readonly observationType?: string;
  readonly receiptType?: string;
  readonly toolId?: string;
}): CertifiedObservationAdapterFixture {
  const capabilityId =
    input.capabilityId ?? "mission.adapter_certification.observe_state";
  const toolId = input.toolId ?? "mission.adapter_certification.observe_state";
  const receiptType = input.receiptType ?? "external_state_observation_read";
  const observationType = input.observationType ?? "github.pull_request_state";
  const commandId = `cmd_${sanitizeId(input.runId)}`;
  const observedState = input.observedState ?? { state: "open" };
  const observationPayloadHash = hashRunEventPayload(observedState);
  const observationEvidence = observationEvidenceRef({
    evidenceId: `ev_${commandId}_external_state`,
    hash: observationPayloadHash,
    sourceEventId: observationEventIdForCommand(commandId),
  });
  const externalStateObservation: ExternalStateObservation = {
    observationId: `observation_${commandId}`,
    runId: input.runId,
    observationType,
    subjectType: "pull_request",
    subjectId: "123",
    observedState,
    observedAt: CERTIFIED_ADAPTER_OBSERVED_AT,
    expiresAt: CERTIFIED_ADAPTER_EXPIRES_AT,
    payloadHash: observationPayloadHash,
    evidence: [observationEvidence],
  };
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId,
    runId: input.runId,
    capabilityId,
    toolId,
    args: {
      property: "state",
      subjectId: "123",
      subjectType: "pull_request",
    },
    sideEffectClass: "read",
  };
  const calls: ToolCommandRequest[] = [];
  const receiptPayload = {
    observationId: externalStateObservation.observationId,
    observationType: externalStateObservation.observationType,
    subjectId: externalStateObservation.subjectId,
    subjectType: externalStateObservation.subjectType,
  };
  const receiptPayloadHash = hashRunEventPayload(receiptPayload);
  const receipt = effectReceiptForCommand(command, {
    evidence: [
      effectEvidenceRef({
        evidenceId: `ev_${commandId}_receipt`,
        hash: receiptPayloadHash,
        sourceEventId: receiptEventIdForCommand(commandId),
      }),
    ],
    payload: receiptPayload,
    payloadHash: receiptPayloadHash,
    receiptType,
  });
  const certifiedAdapter = certifiedFakeEffectAdapter({
    adapterId: `adapter.${toolId}`,
    capabilityId,
    declaredReceiptTypes: input.declaredReceiptTypes ?? [receiptType],
    declaredObservationTypes: input.declaredObservationTypes ?? [
      observationType,
    ],
    sideEffectClass: "read",
    toolId,
    ...(input.adapterKind === undefined
      ? {}
      : { adapterKind: input.adapterKind }),
    execute: (request) => {
      calls.push(request.toolCommand);

      const externalStateObservationCandidate: ExternalStateObservationCandidate =
        {
          ...externalStateObservation,
          evidence: [
            pendingObservationEvidenceRef({
              evidenceId: `ev_${request.toolCommand.commandId}_external_state`,
              hash: observationPayloadHash,
            }),
          ],
        };

      return {
        receiptCandidate: effectReceiptCandidateForRequest(
          request.effectRequest,
          {
            evidence: [
              pendingEffectEvidenceRef({
                evidenceId: `ev_${request.toolCommand.commandId}_receipt`,
                hash: receiptPayloadHash,
              }),
            ],
            payload: receiptPayload,
            payloadHash: receiptPayloadHash,
            receiptType,
          },
        ),
        externalStateObservationCandidate,
      };
    },
  });

  return {
    adapter: asEffectAdapter(certifiedAdapter),
    certifiedAdapter,
    calls,
    capability: currentStateCapability({
      capabilityId,
      observationType,
      receiptType,
    }),
    command,
    externalStateObservation,
    observationType,
    receipt,
    receiptType,
  };
}

export function certifiedFakeEffectAdapter(input: {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly declaredReceiptTypes: readonly string[];
  readonly declaredObservationTypes: readonly string[];
  readonly adapterKind?: CertifiedAdapterKind;
  readonly idempotency?: AdapterIdempotencyPosture;
  readonly riskProfile?: AdapterRiskProfile;
  readonly execute: CertifiedFakeEffectAdapter["execute"];
}): CertifiedFakeEffectAdapter {
  const certification = effectAdapterCertification({
    adapterId: input.adapterId,
    capabilityId: input.capabilityId,
    declaredObservationTypes: input.declaredObservationTypes,
    declaredReceiptTypes: input.declaredReceiptTypes,
    sideEffectClass: input.sideEffectClass,
    toolId: input.toolId,
    ...(input.adapterKind === undefined
      ? {}
      : { adapterKind: input.adapterKind }),
    ...(input.idempotency === undefined
      ? {}
      : { idempotency: input.idempotency }),
    ...(input.riskProfile === undefined
      ? {}
      : { riskProfile: input.riskProfile }),
  });

  return {
    adapterId: input.adapterId,
    capabilityId: input.capabilityId,
    toolId: input.toolId,
    certification,
    execute: input.execute,
  };
}

export function effectAdapterCertification(input: {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly declaredReceiptTypes: readonly string[];
  readonly declaredObservationTypes: readonly string[];
  readonly adapterKind?: CertifiedAdapterKind;
  readonly idempotency?: AdapterIdempotencyPosture;
  readonly riskProfile?: AdapterRiskProfile;
}): AdapterCertification {
  return {
    certificationVersion: 1,
    adapterId: input.adapterId,
    adapterKind: input.adapterKind ?? "deterministic_fake",
    capabilityId: input.capabilityId,
    toolId: input.toolId,
    sideEffectClass: input.sideEffectClass,
    declaredReceiptTypes: [...input.declaredReceiptTypes],
    declaredObservationTypes: [...input.declaredObservationTypes],
    idempotency: input.idempotency ?? idempotencyFor(input.sideEffectClass),
    riskProfile: input.riskProfile ?? riskProfileFor(input.sideEffectClass),
  };
}

export function adapterWithCertificationVariation(
  adapter: CertifiedFakeEffectAdapter,
  variation: Partial<AdapterCertification>,
): EffectAdapter {
  return asEffectAdapter({
    ...adapter,
    certification: {
      ...adapter.certification,
      ...variation,
    },
  });
}

export function uncertifiedEffectAdapter(
  adapter: CertifiedFakeEffectAdapter,
): EffectAdapter {
  return asEffectAdapter({
    adapterId: adapter.adapterId,
    capabilityId: adapter.capabilityId,
    toolId: adapter.toolId,
    execute: (request: CertifiedEffectRequest, context: EffectAdapterContext) =>
      adapter.execute(request, context),
  });
}

export function asEffectAdapter(adapter: unknown): EffectAdapter {
  return adapter as EffectAdapter;
}

export function certifiedAdapterEventTypes(input: {
  readonly events: () => readonly { readonly type: RunEventType }[];
}): RunEventType[] {
  return input.events().map((event) => event.type);
}

function testResultPayload(result: "passed" | "failed"): JsonObject {
  return {
    result,
    testSuiteId: "mission",
  };
}

function testResultClaim(input: {
  readonly capabilityId: string;
  readonly evidenceRef: EvidenceRef;
  readonly runId: string;
}): Claim {
  return {
    claimId: `claim_${sanitizeId(input.runId)}`,
    type: "test_result",
    statement: "Tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId: input.capabilityId,
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
      testSuiteId: "mission",
    },
    evidenceRefs: [input.evidenceRef],
    criticality: "medium",
  };
}

function testResultCapability(input: {
  readonly capabilityId: string;
  readonly receiptType: string;
  readonly sideEffectClass: SideEffectClass;
}): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: input.capabilityId,
    profile: "standard",
    sideEffectClass: input.sideEffectClass,
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    receiptSchema: {
      type: "object",
      additionalProperties: true,
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType: input.receiptType,
      },
    ],
    supportedClaims: [
      {
        claimType: "test_result",
        predicateKind: "test_result",
        requiredReceiptType: "test_run",
      },
    ],
    proofRules: [],
  };
}

function currentStateCapability(input: {
  readonly capabilityId: string;
  readonly observationType: string;
  readonly receiptType: string;
}): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: input.capabilityId,
    profile: "standard",
    sideEffectClass: "read",
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    receiptSchema: {
      type: "object",
      additionalProperties: true,
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType: input.receiptType,
      },
      {
        evidenceKind: "external_observation",
        observationType: input.observationType,
      },
    ],
    supportedClaims: [
      {
        claimType: "current_state",
        predicateKind: "current_state",
        observationType: input.observationType,
      },
    ],
    proofRules: [],
  };
}

function effectReceiptForCommand(
  command: ToolCommandRequest,
  options: {
    readonly evidence: readonly EvidenceRef[];
    readonly payload: JsonObject;
    readonly payloadHash: EffectReceipt["payloadHash"];
    readonly receiptType: string;
  },
): EffectReceipt {
  return {
    receiptId: `receipt_${command.commandId}`,
    effectId: `effect_${command.commandId}`,
    runId: command.runId,
    capabilityId: command.capabilityId,
    receiptType: options.receiptType,
    status: "succeeded",
    payload: options.payload,
    payloadHash: options.payloadHash,
    evidence: [...options.evidence],
    observedAt: CERTIFIED_ADAPTER_OBSERVED_AT,
  };
}

function effectReceiptCandidateForRequest(
  effectRequest: CertifiedEffectRequest["effectRequest"],
  options: {
    readonly evidence: readonly PendingEvidenceRef[];
    readonly payload: JsonObject;
    readonly payloadHash: ReceiptCandidate["payloadHash"];
    readonly receiptType: string;
  },
): ReceiptCandidate {
  return {
    receiptId: `receipt_${effectRequest.effectId}`,
    effectId: effectRequest.effectId,
    runId: effectRequest.runId,
    capabilityId: effectRequest.capabilityId,
    receiptType: options.receiptType,
    status: "succeeded",
    payload: options.payload,
    payloadHash: options.payloadHash,
    evidence: [...options.evidence],
    observedAt: CERTIFIED_ADAPTER_OBSERVED_AT,
  };
}

function pendingEffectEvidenceRef(input: {
  readonly evidenceId: string;
  readonly hash: PendingEvidenceRef["hash"];
}): PendingEvidenceRef {
  return {
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${sanitizeId(input.evidenceId)}`,
    evidenceId: input.evidenceId,
    kind: "effect_receipt",
    hash: input.hash,
    observedAt: CERTIFIED_ADAPTER_OBSERVED_AT,
    sensitivity: "internal",
  };
}

function pendingObservationEvidenceRef(input: {
  readonly evidenceId: string;
  readonly hash: PendingEvidenceRef["hash"];
}): PendingEvidenceRef {
  return {
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${sanitizeId(input.evidenceId)}`,
    evidenceId: input.evidenceId,
    kind: "external_observation",
    hash: input.hash,
    observedAt: CERTIFIED_ADAPTER_OBSERVED_AT,
    sensitivity: "internal",
  };
}

function effectEvidenceRef(input: {
  readonly evidenceId: string;
  readonly hash: EvidenceRef["hash"];
  readonly sourceEventId: string;
}): EvidenceRef {
  return {
    evidenceId: input.evidenceId,
    kind: "effect_receipt",
    sourceEventId: input.sourceEventId,
    hash: input.hash,
    observedAt: CERTIFIED_ADAPTER_OBSERVED_AT,
    sensitivity: "internal",
  };
}

function observationEvidenceRef(input: {
  readonly evidenceId: string;
  readonly hash: EvidenceRef["hash"];
  readonly sourceEventId: string;
}): EvidenceRef {
  return {
    evidenceId: input.evidenceId,
    kind: "external_observation",
    sourceEventId: input.sourceEventId,
    hash: input.hash,
    observedAt: CERTIFIED_ADAPTER_OBSERVED_AT,
    sensitivity: "internal",
  };
}

function idempotencyFor(
  sideEffectClass: SideEffectClass,
): AdapterIdempotencyPosture {
  return sideEffectClass === "idempotent_write" ||
    sideEffectClass === "reversible_write" ||
    sideEffectClass === "irreversible_write" ||
    sideEffectClass === "critical_write"
    ? "required_for_writes"
    : "not_required";
}

function riskProfileFor(sideEffectClass: SideEffectClass): AdapterRiskProfile {
  return sideEffectClass === "critical_write" ? "critical" : "standard";
}

function receiptEventIdForCommand(commandId: string): string {
  return `evt_${sanitizeId(commandId)}_receipt_recorded`;
}

function observationEventIdForCommand(commandId: string): string {
  return `evt_${sanitizeId(commandId)}_external_state_observed`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
