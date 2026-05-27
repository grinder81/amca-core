export type ReleaseDecision =
  | ReleasedDecision
  | BlockedDecision
  | NeedsRepairDecision
  | QuarantinedDecision;

export interface ReleasedDecision {
  status: "released";
  runId: string;
  proofId: string;
  approvedClaimIds: string[];
  blockingMismatchIds: [];
  finalMessage?: string;
}

export interface BlockedDecision {
  status: "blocked";
  runId: string;
  proofId: string;
  approvedClaimIds: string[];
  blockingMismatchIds: string[];
  repairHints?: string[];
}

export interface NeedsRepairDecision {
  status: "needs_repair";
  runId: string;
  proofId: string;
  approvedClaimIds: string[];
  blockingMismatchIds: string[];
  repairInstructions: string[];
}

export type QuarantineReason =
  | "uncertain_external_effect"
  | "inconsistent_evidence"
  | "policy_required"
  | "unrecoverable_schema_error";

export interface QuarantinedDecision {
  status: "quarantined";
  runId: string;
  approvedClaimIds: string[];
  blockingMismatchIds: string[];
  reason: QuarantineReason;
  proofId?: string;
}
