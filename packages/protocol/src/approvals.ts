import type { Criticality, ISODateTimeString, JsonObject } from "./shared.js";
import type { WriteSideEffectClass } from "./effects.js";

export type ApprovalScope = WritePreflightApprovalScope | MutationApprovalScope;

export interface WritePreflightApprovalScope {
  kind: "write_preflight";
  preflightId: string;
  commandId: string;
  capabilityId: string;
  toolId: string;
  sideEffectClass: WriteSideEffectClass;
  idempotencyKey?: string;
}

export interface MutationApprovalScope {
  kind: "mutation";
  commandId: string;
  mutationId: string;
  stateRef: string;
}

export interface ApprovalRequest {
  kind: "approval_request";
  approvalId: string;
  runId: string;
  requestedBy: string;
  scope: ApprovalScope;
  criticality: Criticality;
  reason: string;
  requestedAt: ISODateTimeString;
  expiresAt: ISODateTimeString;
  metadata?: JsonObject;
}

export interface ApprovalGrant {
  kind: "approval_grant";
  approvalId: string;
  runId: string;
  approverId: string;
  scope: ApprovalScope;
  grantedAt: ISODateTimeString;
  expiresAt: ISODateTimeString;
  metadata?: JsonObject;
}

export interface ApprovalDenial {
  kind: "approval_denial";
  approvalId: string;
  runId: string;
  approverId: string;
  scope: ApprovalScope;
  reason: string;
  deniedAt: ISODateTimeString;
  metadata?: JsonObject;
}

export interface ApprovalExpiry {
  kind: "approval_expiry";
  approvalId: string;
  runId: string;
  scope: ApprovalScope;
  expiredAt: ISODateTimeString;
  reason: "expired";
  metadata?: JsonObject;
}
