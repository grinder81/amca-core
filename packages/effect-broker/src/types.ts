import type { CapabilityContract } from "@amca/capabilities";
import type {
  AdapterKind,
  EffectAdapter,
  ExternalStateObservationCandidate,
  ReceiptCandidate,
} from "@amca/effect-sdk";
import type {
  EffectRequest,
  ISODateTimeString,
  JsonObject,
  ToolCommandRequest,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";

export type EffectBrokerErrorCode =
  | "adapter_certification_invalid"
  | "adapter_certification_kind_forbidden"
  | "adapter_certification_missing"
  | "adapter_certification_mismatch"
  | "adapter_certification_undeclared_observation"
  | "adapter_certification_undeclared_receipt"
  | "adapter_write_lifecycle_invalid"
  | "adapter_write_lifecycle_missing"
  | "adapter_observation_invalid"
  | "adapter_observation_receipt_failed"
  | "adapter_observation_undeclared"
  | "adapter_receipt_invalid"
  | "adapter_receipt_missing"
  | "adapter_receipt_unknown"
  | "adapter_write_quarantined"
  | "capability_not_registered"
  | "critical_write_requires_approval"
  | "duplicate_idempotency_key_conflict"
  | "idempotency_key_required"
  | "receipt_effect_mismatch"
  | "side_effect_class_mismatch"
  | "tool_not_registered"
  | "write_preflight_denied"
  | "write_preflight_mismatch"
  | "write_preflight_required"
  | "write_preflight_not_applicable"
  | "write_preflight_quarantined";

export class EffectBrokerError extends Error {
  readonly code: EffectBrokerErrorCode;
  readonly quarantine?: WriteQuarantineState | undefined;

  constructor(
    code: EffectBrokerErrorCode,
    message: string,
    options: { readonly quarantine?: WriteQuarantineState } = {},
  ) {
    super(message);
    this.name = "EffectBrokerError";
    this.code = code;
    this.quarantine = options.quarantine;
  }
}

export type EffectDispatchStatus = "cached" | "dispatched";

export interface EffectDispatchResult {
  readonly status: EffectDispatchStatus;
  readonly effectRequest: EffectRequest;
  readonly receiptCandidate: ReceiptCandidate;
  readonly externalStateObservationCandidate?:
    | ExternalStateObservationCandidate
    | undefined;
}

export interface InMemoryEffectBrokerOptions {
  readonly capabilities?: readonly CapabilityContract[];
  readonly adapters?: readonly EffectAdapter[];
  readonly allowedAdapterKinds?: readonly AdapterKind[];
  readonly clock?: () => ISODateTimeString;
}

export interface DispatchEffectOptions {
  readonly effectId?: string;
  readonly requestedAt?: ISODateTimeString;
}

export interface WritePreflightOptions {
  readonly decidedAt?: ISODateTimeString;
  readonly metadata?: JsonObject;
  readonly preflightId?: string;
  readonly quarantineId?: string;
  readonly requestedAt?: ISODateTimeString;
}

export interface DispatchWithPreflightOptions extends DispatchEffectOptions {
  readonly preflightDecision: WritePreflightDecision;
}

export interface RegisteredEffectAdapter {
  readonly adapter: EffectAdapter;
}

export interface RegisteredCapability {
  readonly capability: CapabilityContract;
}

export type GovernedEffectCommand = ToolCommandRequest;
