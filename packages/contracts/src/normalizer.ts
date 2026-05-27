type EnumFieldName =
  | "actionVerb"
  | "criticality"
  | "expectedStatus"
  | "kind"
  | "operator"
  | "reason"
  | "sensitivity"
  | "sideEffectClass"
  | "status"
  | "type"
  | "verdict";

const ENUM_VALUES_BY_FIELD = {
  actionVerb: ["created", "updated", "deleted", "sent", "opened", "executed"],
  criticality: ["low", "medium", "high", "critical"],
  expectedStatus: ["passed", "failed"],
  kind: [
    "tool_command_request",
    "mutation_command_request",
    "final_candidate",
    "mutation_committed",
    "approval_request",
    "approval_grant",
    "approval_denial",
    "approval_expiry",
    "write_preflight",
    "mutation",
    "set",
    "merge",
    "delete",
    "historical_action",
    "test_result",
    "current_state",
    "effect_receipt",
    "external_observation",
    "artifact",
    "test_output",
    "ledger_event",
  ],
  operator: ["equals", "not_equals", "contains"],
  reason: [
    "uncertain_external_effect",
    "inconsistent_evidence",
    "policy_required",
    "unrecoverable_schema_error",
  ],
  sensitivity: ["public", "internal", "confidential", "restricted"],
  sideEffectClass: [
    "read",
    "compute",
    "idempotent_write",
    "reversible_write",
    "irreversible_write",
    "critical_write",
  ],
  status: [
    "succeeded",
    "failed",
    "unknown",
    "released",
    "blocked",
    "needs_repair",
    "quarantined",
  ],
  type: [
    "historical_action",
    "test_result",
    "current_state",
    "missing_evidence",
    "unsupported_claim",
    "stale_external_state",
    "unverified_receipt",
    "policy_violation",
    "unauthorized_tool",
    "schema_mismatch",
    "uncertain_external_effect",
    "RunStarted",
    "ProposalReceived",
    "EffectRequested",
    "WritePreflightRequested",
    "WritePreflightDecided",
    "WriteQuarantined",
    "MutationCommitted",
    "ApprovalRequested",
    "ApprovalGranted",
    "ApprovalDenied",
    "ApprovalExpired",
    "EffectReceiptRecorded",
    "ExternalStateObserved",
    "ProofGenerated",
    "MismatchDetected",
    "ReleaseDecided",
    "FinalReleased",
  ],
  verdict: ["pass", "fail", "needs_repair", "quarantine"],
} as const satisfies Record<EnumFieldName, readonly string[]>;

const SEMANTIC_CONTAINER_KEYS = new Set([
  "actual",
  "args",
  "expected",
  "expectedValue",
  "metadata",
  "observedState",
  "payload",
]);

const TRAVERSABLE_CONTAINER_KEYS = new Set([
  "blockingMismatches",
  "candidate",
  "claims",
  "decision",
  "denial",
  "effectRequest",
  "expiry",
  "evaluatedClaims",
  "evidence",
  "evidenceRefs",
  "grant",
  "mismatch",
  "mutation",
  "observation",
  "operation",
  "predicate",
  "precondition",
  "proof",
  "proposal",
  "provenance",
  "receipt",
  "request",
  "requiredEvidence",
  "scope",
  "target",
]);

export function normalizeProtocolInput(input: unknown): unknown {
  return normalizeValue(input, undefined);
}

export function normalizeEnumFieldValue(
  fieldName: EnumFieldName,
  value: unknown,
): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  const canonicalValues = ENUM_VALUES_BY_FIELD[fieldName];
  const matchedValue = canonicalValues.find(
    (candidate) => candidate.toLowerCase() === trimmed.toLowerCase(),
  );

  return matchedValue ?? value;
}

function normalizeValue(
  value: unknown,
  parentKey: string | undefined,
): unknown {
  if (SEMANTIC_CONTAINER_KEYS.has(parentKey ?? "")) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, parentKey));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, entryValue]) => {
    if (isEnumFieldName(key)) {
      return [key, normalizeEnumFieldValue(key, entryValue)] as const;
    }

    if (!TRAVERSABLE_CONTAINER_KEYS.has(key)) {
      return [key, entryValue] as const;
    }

    return [key, normalizeValue(entryValue, key)] as const;
  });

  return Object.fromEntries(normalizedEntries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnumFieldName(value: string): value is EnumFieldName {
  return Object.hasOwn(ENUM_VALUES_BY_FIELD, value);
}
