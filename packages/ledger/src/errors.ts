export type LedgerErrorCode =
  | "duplicate_event_id"
  | "duplicate_sequence"
  | "empty_event_id"
  | "empty_run_id"
  | "event_not_found"
  | "integrity_violation"
  | "invalid_causation_id"
  | "invalid_payload"
  | "invalid_sequence"
  | "non_contiguous_sequence"
  | "payload_hash_mismatch"
  | "run_id_mismatch"
  | "run_not_found"
  | "tamper_detected";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}
