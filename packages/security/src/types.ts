import type { EvidenceSensitivity, JsonValue, RunEvent } from "@amca/protocol";

export type PrincipalRole = "viewer" | "operator" | "auditor" | "service_admin";

export type SecurityCapability =
  | "run:start"
  | "run:execute"
  | "run:inspect"
  | "run:replay"
  | "final:submit"
  | "audit:export"
  | "evidence:read_public"
  | "evidence:read_internal"
  | "evidence:read_confidential"
  | "evidence:read_restricted";

export interface Principal {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly PrincipalRole[];
  readonly capabilities?: readonly SecurityCapability[];
}

export interface SecurityContext {
  readonly tenantId: string;
  readonly principal: Principal;
}

export type SecurityErrorCode =
  | "capability_denied"
  | "evidence_access_denied"
  | "tenant_access_denied";

export class SecurityError extends Error {
  readonly code: SecurityErrorCode;

  constructor(code: SecurityErrorCode, message: string) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
  }
}

export interface RedactedEvidenceRef {
  readonly evidenceId: string;
  readonly kind: string;
  readonly sensitivity: EvidenceSensitivity;
  readonly redacted: true;
  readonly reason: "evidence_access_denied";
}

export interface ReleaseAuditDecisionSummary {
  readonly status: string;
  readonly proofId?: string;
  readonly approvedClaimIds: readonly string[];
  readonly blockingMismatchIds: readonly string[];
}

export interface ReleaseAuditMismatchSummary {
  readonly mismatchId: string;
  readonly type: string;
  readonly claimId?: string;
}

export interface ReleaseAuditReport {
  readonly runId: string;
  readonly generatedFor: {
    readonly tenantId: string;
    readonly principalId: string;
  };
  readonly proofUsable: false;
  readonly containsRawEvidence: false;
  readonly decisions: readonly ReleaseAuditDecisionSummary[];
  readonly mismatches: readonly ReleaseAuditMismatchSummary[];
  readonly eventCount: number;
  readonly redactedEvents: readonly JsonValue[];
}

export interface AuditExportInput {
  readonly context: SecurityContext;
  readonly runId: string;
  readonly events: readonly RunEvent[];
}
