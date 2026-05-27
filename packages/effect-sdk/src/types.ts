import type { CapabilityContract } from "@amca/capabilities";
import type {
  EffectRequest,
  ExternalStateObservationCandidate,
  ISODateTimeString,
  ReceiptCandidate,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";

export type {
  ExternalStateObservationCandidate,
  PendingEvidenceRef,
  ReceiptCandidate,
} from "@amca/protocol";

export type AdapterKind =
  | "deterministic_fake"
  | "deterministic_in_memory"
  | "local_readonly"
  | "controlled_compute"
  | "external_read"
  | "external_write";

export type AdapterIdempotencyPosture =
  | "not_required"
  | "required_for_writes"
  | "adapter_enforced";

export type WritePreflightCertification = "required_before_dispatch";

export type WriteIdempotencyKeyCertification =
  | "tool_command_required"
  | "adapter_enforced";

export type WriteDispatchCertification = "broker_governed";

export type WriteOutcomeCertification =
  "receipt_candidate_or_quarantine_required";

export type WriteForbiddenAuthority =
  | "receipt_admission"
  | "proof_authority"
  | "release_authority";

export interface WriteLifecycleCertification {
  readonly preflight: WritePreflightCertification;
  readonly idempotencyKey: WriteIdempotencyKeyCertification;
  readonly dispatch: WriteDispatchCertification;
  readonly outcome: WriteOutcomeCertification;
  readonly forbiddenAuthority: readonly WriteForbiddenAuthority[];
}

export type AdapterRiskProfile =
  | "light"
  | "standard"
  | "critical"
  | "regulated";

export interface AdapterCertification {
  readonly certificationVersion: 1;
  readonly adapterId: string;
  readonly adapterKind: AdapterKind;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly declaredReceiptTypes: readonly string[];
  readonly declaredObservationTypes?: readonly string[] | undefined;
  readonly idempotency: AdapterIdempotencyPosture;
  readonly writeLifecycle?: WriteLifecycleCertification | undefined;
  readonly riskProfile: AdapterRiskProfile;
}

export interface CertifiedEffectRequest {
  readonly toolCommand: ToolCommandRequest;
  readonly effectRequest: EffectRequest;
  readonly capability: CapabilityContract;
}

export interface EffectAdapterContext {
  readonly now: () => ISODateTimeString;
}

export interface EffectAdapterResult {
  readonly receiptCandidate?: ReceiptCandidate;
  readonly externalStateObservationCandidate?:
    | ExternalStateObservationCandidate
    | undefined;
}

export interface EffectAdapter {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly certification: AdapterCertification;
  execute(
    request: CertifiedEffectRequest,
    context: EffectAdapterContext,
  ): EffectAdapterResult | Promise<EffectAdapterResult>;
}
