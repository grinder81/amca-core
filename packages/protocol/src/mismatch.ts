import type { JsonValue } from "./shared.js";

export type MismatchType =
  | "missing_evidence"
  | "unsupported_claim"
  | "stale_external_state"
  | "unverified_receipt"
  | "policy_violation"
  | "unauthorized_tool"
  | "schema_mismatch"
  | "uncertain_external_effect";

export interface Mismatch {
  mismatchId: string;
  runId: string;
  type: MismatchType;
  blocking: boolean;
  message: string;
  claimId?: string;
  expected?: JsonValue;
  actual?: JsonValue;
}
