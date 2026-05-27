import type { EvidenceRef, PendingEvidenceRef } from "./evidence.js";
import type { ISODateTimeString, JsonObject, Sha256Hash } from "./shared.js";

export type SideEffectClass =
  | "read"
  | "compute"
  | "idempotent_write"
  | "reversible_write"
  | "irreversible_write"
  | "critical_write";

export type WriteSideEffectClass = Extract<
  SideEffectClass,
  | "idempotent_write"
  | "reversible_write"
  | "irreversible_write"
  | "critical_write"
>;

export type EffectStatus = "succeeded" | "failed" | "unknown";

export type WritePreflightStatus = "allowed" | "denied" | "quarantined";

export type WritePreflightBlockReason =
  | "adapter_not_certified"
  | "capability_not_registered"
  | "critical_approval_required"
  | "missing_idempotency_key"
  | "policy_denied"
  | "tool_not_registered"
  | "unsupported_side_effect_class";

export type WriteQuarantineReason =
  | "adapter_not_certified"
  | "critical_approval_required"
  | "uncertain_external_effect"
  | "unsupported_side_effect_class";

export type WriteQuarantineStatus = "quarantined";

export interface EffectRequest {
  effectId: string;
  commandId: string;
  runId: string;
  capabilityId: string;
  toolId: string;
  args: JsonObject;
  sideEffectClass: SideEffectClass;
  requestedAt: ISODateTimeString;
  idempotencyKey?: string;
}

export interface EffectReceipt {
  receiptId: string;
  effectId: string;
  runId: string;
  capabilityId: string;
  receiptType: string;
  status: EffectStatus;
  payload: JsonObject;
  payloadHash: Sha256Hash;
  evidence: EvidenceRef[];
  observedAt: ISODateTimeString;
  externalRef?: string;
}

export interface ReceiptCandidate {
  receiptId: string;
  effectId: string;
  runId: string;
  capabilityId: string;
  receiptType: string;
  status: EffectStatus;
  payload: JsonObject;
  payloadHash: Sha256Hash;
  evidence: PendingEvidenceRef[];
  observedAt: ISODateTimeString;
  externalRef?: string;
}

export interface WritePreflightCandidate {
  kind: "write_preflight_candidate";
  preflightId: string;
  runId: string;
  commandId: string;
  capabilityId: string;
  toolId: string;
  sideEffectClass: WriteSideEffectClass;
  argsHash: Sha256Hash;
  requestedAt: ISODateTimeString;
  idempotencyKey?: string;
  metadata?: JsonObject;
}

export interface WriteQuarantineState {
  kind: "write_quarantine_state";
  quarantineId: string;
  runId: string;
  preflightId: string;
  commandId: string;
  capabilityId: string;
  toolId: string;
  sideEffectClass: WriteSideEffectClass;
  status: WriteQuarantineStatus;
  reason: WriteQuarantineReason;
  message: string;
  quarantinedAt: ISODateTimeString;
  idempotencyKey?: string;
  metadata?: JsonObject;
}

export type WritePreflightDecision =
  | WritePreflightAllowedDecision
  | WritePreflightDeniedDecision
  | WritePreflightQuarantinedDecision;

export interface WritePreflightAllowedDecision {
  kind: "write_preflight_decision";
  status: "allowed";
  runId: string;
  preflightId: string;
  commandId: string;
  capabilityId: string;
  toolId: string;
  sideEffectClass: WriteSideEffectClass;
  idempotencyKey: string;
  decidedAt: ISODateTimeString;
  approvalId?: string;
}

export interface WritePreflightDeniedDecision {
  kind: "write_preflight_decision";
  status: "denied";
  runId: string;
  preflightId: string;
  commandId: string;
  capabilityId: string;
  toolId: string;
  sideEffectClass: WriteSideEffectClass;
  reason: WritePreflightBlockReason;
  message: string;
  decidedAt: ISODateTimeString;
  idempotencyKey?: string;
}

export interface WritePreflightQuarantinedDecision {
  kind: "write_preflight_decision";
  status: "quarantined";
  runId: string;
  preflightId: string;
  commandId: string;
  capabilityId: string;
  toolId: string;
  sideEffectClass: WriteSideEffectClass;
  quarantine: WriteQuarantineState;
  decidedAt: ISODateTimeString;
  idempotencyKey?: string;
}
