import { canonicalObjectHash } from "@amca/contracts";
import type {
  EffectReceipt,
  EffectRequest,
  EffectStatus,
  ExternalStateObservation,
  ISODateTimeString,
  JsonObject,
  JsonValue,
  RunEvent,
  Sha256Hash,
} from "@amca/protocol";

export type ReceiptStatusSummaryStatus = EffectStatus | "missing";
export type ReceiptStatusSummaryCertainty = "confirmed" | "uncertain";

export interface ReceiptStatusSummary {
  readonly kind: "receipt_status_summary";
  readonly runId: string;
  readonly effectId: string;
  readonly status: ReceiptStatusSummaryStatus;
  readonly certainty: ReceiptStatusSummaryCertainty;
  readonly observedAt: ISODateTimeString;
  readonly receiptId?: string;
  readonly sourceEventId?: string;
}

export interface ReconciliationInput {
  readonly runId: string;
  readonly checkedAt: ISODateTimeString;
  readonly acceptedEvents?: readonly RunEvent[];
  readonly acceptedEffectRequests?: readonly EffectRequest[];
  readonly acceptedReceipts?: readonly EffectReceipt[];
  readonly acceptedObservations?: readonly ExternalStateObservation[];
  readonly freshObservations?: readonly ExternalStateObservation[];
  readonly receiptStatusSummaries?: readonly ReceiptStatusSummary[];
  readonly observationFreshnessMs?: number;
}

export type ReconciliationOutcome =
  | "consistent"
  | "drift_detected"
  | "reconciliation_needed"
  | "quarantine_recommended";

export type ReconciliationMismatchType =
  | "external_state_drift"
  | "stale_observation"
  | "missing_observation"
  | "input_payload_hash_mismatch"
  | "receipt_missing"
  | "receipt_status_drift"
  | "uncertain_external_effect";

export type ReconciliationMismatchSeverity = "info" | "warning" | "critical";

export type ReconciliationTarget =
  | ExternalObservationTarget
  | EffectReceiptTarget;

export interface ExternalObservationTarget {
  readonly kind: "external_observation";
  readonly observationId?: string;
  readonly observationType: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

export interface EffectReceiptTarget {
  readonly kind: "effect_receipt";
  readonly effectId: string;
  readonly receiptId?: string;
}

export interface ReconciliationMismatch {
  readonly reconciliationMismatchId: string;
  readonly runId: string;
  readonly type: ReconciliationMismatchType;
  readonly severity: ReconciliationMismatchSeverity;
  readonly target: ReconciliationTarget;
  readonly message: string;
  readonly expected?: JsonValue;
  readonly actual?: JsonValue;
}

export type QuarantineRecommendationReason =
  | "missing_receipt"
  | "receipt_status_mismatch"
  | "uncertain_external_effect";

export interface QuarantineRecommendation {
  readonly recommendationId: string;
  readonly runId: string;
  readonly reason: QuarantineRecommendationReason;
  readonly target: EffectReceiptTarget;
  readonly message: string;
  readonly recommendedAt: ISODateTimeString;
}

export interface ReconciliationAuthorityLimits {
  readonly advisoryOnly: true;
  readonly mutatesTruth: false;
  readonly executesEffects: false;
  readonly callsExternalSystems: false;
  readonly admitsEvidence: false;
  readonly supportsProof: false;
  readonly releasesClaims: false;
}

export interface ReconciliationReport {
  readonly kind: "reconciliation_report";
  readonly reportId: string;
  readonly runId: string;
  readonly generatedAt: ISODateTimeString;
  readonly advisoryOnly: true;
  readonly proofUsable: false;
  readonly authority: ReconciliationAuthorityLimits;
  readonly outcome: ReconciliationOutcome;
  readonly observationsCompared: number;
  readonly receiptsCompared: number;
  readonly mismatches: readonly ReconciliationMismatch[];
  readonly quarantineRecommendations: readonly QuarantineRecommendation[];
}

interface MutableReconciliationState {
  readonly input: ReconciliationInput;
  readonly acceptedEffectRequests: readonly EffectRequest[];
  readonly acceptedReceipts: readonly EffectReceipt[];
  readonly acceptedObservations: readonly ExternalStateObservation[];
  readonly freshObservations: readonly ExternalStateObservation[];
  readonly receiptStatusSummaries: readonly ReceiptStatusSummary[];
  readonly mismatches: ReconciliationMismatch[];
  readonly quarantineRecommendations: QuarantineRecommendation[];
  observationsCompared: number;
  receiptsCompared: number;
}

export function reconcileAcceptedEvidence(
  input: ReconciliationInput,
): ReconciliationReport {
  const state: MutableReconciliationState = {
    input,
    acceptedEffectRequests: sortEffectRequests(
      uniqueEffectRequests([
        ...effectRequestsFromEvents(input.acceptedEvents ?? []),
        ...(input.acceptedEffectRequests ?? []),
      ]),
    ),
    acceptedReceipts: sortReceipts(
      uniqueReceipts([
        ...receiptsFromEvents(input.acceptedEvents ?? []),
        ...(input.acceptedReceipts ?? []),
      ]),
    ),
    acceptedObservations: sortObservations(
      uniqueObservations([
        ...observationsFromEvents(input.acceptedEvents ?? []),
        ...(input.acceptedObservations ?? []),
      ]),
    ),
    freshObservations: sortObservations(input.freshObservations ?? []),
    receiptStatusSummaries: sortReceiptStatusSummaries(
      input.receiptStatusSummaries ?? [],
    ),
    mismatches: [],
    quarantineRecommendations: [],
    observationsCompared: 0,
    receiptsCompared: 0,
  };

  reconcileObservations(state);
  reconcileReceiptRequests(state);
  reconcileReceipts(state);

  return {
    kind: "reconciliation_report",
    reportId: reportId(input.runId, input.checkedAt),
    runId: input.runId,
    generatedAt: input.checkedAt,
    advisoryOnly: true,
    proofUsable: false,
    authority: {
      advisoryOnly: true,
      mutatesTruth: false,
      executesEffects: false,
      callsExternalSystems: false,
      admitsEvidence: false,
      supportsProof: false,
      releasesClaims: false,
    },
    outcome: outcomeFor(state),
    observationsCompared: state.observationsCompared,
    receiptsCompared: state.receiptsCompared,
    mismatches: [...state.mismatches],
    quarantineRecommendations: [...state.quarantineRecommendations],
  };
}

function reconcileObservations(state: MutableReconciliationState): void {
  for (const acceptedObservation of state.acceptedObservations) {
    state.observationsCompared += 1;
    const target = observationTarget(acceptedObservation);
    const acceptedHash = canonicalObjectHash(acceptedObservation.observedState);

    if (acceptedObservation.payloadHash !== acceptedHash) {
      addMismatch(state, {
        type: "input_payload_hash_mismatch",
        severity: "warning",
        target,
        message:
          "Accepted observation payloadHash does not match its observed state.",
        expected: hashExpectation(acceptedHash),
        actual: hashExpectation(acceptedObservation.payloadHash),
      });
      continue;
    }

    const freshObservation = latestMatchingObservation(
      acceptedObservation,
      state.freshObservations,
    );

    if (freshObservation === undefined) {
      addMismatch(state, {
        type: "missing_observation",
        severity: "warning",
        target,
        message:
          "No fresh admitted observation was provided for the accepted observation subject.",
        expected: observationIdentity(acceptedObservation),
        actual: { freshObservation: "missing" },
      });
      continue;
    }

    const freshHash = canonicalObjectHash(freshObservation.observedState);
    if (freshObservation.payloadHash !== freshHash) {
      addMismatch(state, {
        type: "input_payload_hash_mismatch",
        severity: "warning",
        target: observationTarget(freshObservation),
        message:
          "Fresh observation payloadHash does not match its observed state.",
        expected: hashExpectation(freshHash),
        actual: hashExpectation(freshObservation.payloadHash),
      });
      continue;
    }

    if (!observationIsFresh(freshObservation, state.input)) {
      addMismatch(state, {
        type: "stale_observation",
        severity: "warning",
        target: observationTarget(freshObservation),
        message:
          "Fresh admitted observation is stale for reconciliation at checkedAt.",
        expected: {
          checkedAt: state.input.checkedAt,
          ...(state.input.observationFreshnessMs === undefined
            ? {}
            : { freshnessRequirementMs: state.input.observationFreshnessMs }),
        },
        actual: {
          observedAt: freshObservation.observedAt,
          expiresAt: freshObservation.expiresAt,
        },
      });
      continue;
    }

    if (acceptedObservation.payloadHash !== freshObservation.payloadHash) {
      addMismatch(state, {
        type: "external_state_drift",
        severity: "warning",
        target,
        message:
          "Fresh admitted observation differs from the accepted observation state.",
        expected: observationHashSummary(acceptedObservation),
        actual: observationHashSummary(freshObservation),
      });
    }
  }
}

function reconcileReceiptRequests(state: MutableReconciliationState): void {
  for (const request of state.acceptedEffectRequests) {
    const matchingReceipt = state.acceptedReceipts.find(
      (receipt) => receipt.effectId === request.effectId,
    );

    if (matchingReceipt !== undefined) {
      continue;
    }

    const target: EffectReceiptTarget = {
      kind: "effect_receipt",
      effectId: request.effectId,
    };
    addMismatch(state, {
      type: "receipt_missing",
      severity: "critical",
      target,
      message:
        "Accepted effect request has no accepted effect receipt for reconciliation.",
      expected: { receipt: "present" },
      actual: { receipt: "missing" },
    });
    addQuarantineRecommendation(state, {
      reason: "missing_receipt",
      target,
      message:
        "Quarantine is recommended until a normal AMCA path admits an effect receipt or resolves the missing external effect.",
    });
  }
}

function reconcileReceipts(state: MutableReconciliationState): void {
  for (const acceptedReceipt of state.acceptedReceipts) {
    state.receiptsCompared += 1;
    const target = receiptTarget(acceptedReceipt);
    const acceptedPayloadHash = canonicalObjectHash(acceptedReceipt.payload);

    if (acceptedReceipt.payloadHash !== acceptedPayloadHash) {
      addMismatch(state, {
        type: "input_payload_hash_mismatch",
        severity: "warning",
        target,
        message: "Accepted receipt payloadHash does not match its payload.",
        expected: hashExpectation(acceptedPayloadHash),
        actual: hashExpectation(acceptedReceipt.payloadHash),
      });
      continue;
    }

    if (acceptedReceipt.status === "unknown") {
      addUncertainReceiptMismatch(state, target, {
        acceptedStatus: acceptedReceipt.status,
      });
      continue;
    }

    const statusSummary = matchingReceiptStatusSummary(
      acceptedReceipt,
      state.receiptStatusSummaries,
    );

    if (statusSummary === undefined) {
      continue;
    }

    if (statusSummary.status === "missing") {
      addMismatch(state, {
        type: "receipt_missing",
        severity: "critical",
        target,
        message:
          "Receipt status summary reports the accepted receipt as missing externally.",
        expected: {
          receiptId: acceptedReceipt.receiptId,
          status: acceptedReceipt.status,
        },
        actual: statusSummarySummary(statusSummary),
      });
      addQuarantineRecommendation(state, {
        reason: "missing_receipt",
        target,
        message:
          "Quarantine is recommended because the external status summary reports the accepted receipt as missing.",
      });
      continue;
    }

    if (
      statusSummary.status === "unknown" ||
      statusSummary.certainty === "uncertain"
    ) {
      addUncertainReceiptMismatch(state, target, {
        acceptedStatus: acceptedReceipt.status,
        summary: statusSummarySummary(statusSummary),
      });
      continue;
    }

    if (acceptedReceipt.status !== statusSummary.status) {
      addMismatch(state, {
        type: "receipt_status_drift",
        severity: "critical",
        target,
        message:
          "Receipt status summary differs from the accepted receipt status.",
        expected: {
          receiptId: acceptedReceipt.receiptId,
          status: acceptedReceipt.status,
        },
        actual: statusSummarySummary(statusSummary),
      });
      addQuarantineRecommendation(state, {
        reason: "receipt_status_mismatch",
        target,
        message:
          "Quarantine is recommended until the status drift is resolved through a normal AMCA admission path.",
      });
    }
  }
}

function addUncertainReceiptMismatch(
  state: MutableReconciliationState,
  target: EffectReceiptTarget,
  actual: JsonObject,
): void {
  addMismatch(state, {
    type: "uncertain_external_effect",
    severity: "critical",
    target,
    message:
      "Receipt status is uncertain; reconciliation cannot treat the external effect as confirmed.",
    expected: { status: "confirmed" },
    actual,
  });
  addQuarantineRecommendation(state, {
    reason: "uncertain_external_effect",
    target,
    message:
      "Quarantine is recommended until a normal AMCA path admits a confirmed external effect status.",
  });
}

function addMismatch(
  state: MutableReconciliationState,
  input: Omit<ReconciliationMismatch, "reconciliationMismatchId" | "runId">,
): void {
  const index = state.mismatches.length + 1;
  state.mismatches.push({
    reconciliationMismatchId: scopedId(
      "recon_mismatch",
      state.input.runId,
      input.type,
      String(index),
    ),
    runId: state.input.runId,
    ...input,
  });
}

function addQuarantineRecommendation(
  state: MutableReconciliationState,
  input: Omit<
    QuarantineRecommendation,
    "recommendationId" | "runId" | "recommendedAt"
  >,
): void {
  const index = state.quarantineRecommendations.length + 1;
  state.quarantineRecommendations.push({
    recommendationId: scopedId(
      "quarantine_recommendation",
      state.input.runId,
      input.reason,
      String(index),
    ),
    runId: state.input.runId,
    recommendedAt: state.input.checkedAt,
    ...input,
  });
}

function outcomeFor(state: MutableReconciliationState): ReconciliationOutcome {
  if (state.quarantineRecommendations.length > 0) {
    return "quarantine_recommended";
  }

  if (
    state.mismatches.some(
      (mismatch) => mismatch.type === "external_state_drift",
    )
  ) {
    return "drift_detected";
  }

  if (state.mismatches.length > 0) {
    return "reconciliation_needed";
  }

  return "consistent";
}

function latestMatchingObservation(
  acceptedObservation: ExternalStateObservation,
  observations: readonly ExternalStateObservation[],
): ExternalStateObservation | undefined {
  return [
    ...observations.filter((observation) =>
      observationIdentityMatches(observation, acceptedObservation),
    ),
  ].sort(compareObservationFreshness)[0];
}

function observationIdentityMatches(
  left: ExternalStateObservation,
  right: ExternalStateObservation,
): boolean {
  return (
    left.observationType === right.observationType &&
    left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId
  );
}

function compareObservationFreshness(
  left: ExternalStateObservation,
  right: ExternalStateObservation,
): number {
  const observedAtDifference =
    Date.parse(right.observedAt) - Date.parse(left.observedAt);

  if (observedAtDifference !== 0) {
    return observedAtDifference;
  }

  return left.observationId.localeCompare(right.observationId);
}

function observationIsFresh(
  observation: ExternalStateObservation,
  input: ReconciliationInput,
): boolean {
  const checkedAtMs = Date.parse(input.checkedAt);
  const observedAtMs = Date.parse(observation.observedAt);
  const expiresAtMs = Date.parse(observation.expiresAt);

  if (
    !Number.isFinite(checkedAtMs) ||
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(expiresAtMs)
  ) {
    return false;
  }

  if (observedAtMs > checkedAtMs || expiresAtMs < checkedAtMs) {
    return false;
  }

  if (input.observationFreshnessMs === undefined) {
    return true;
  }

  return checkedAtMs - observedAtMs <= input.observationFreshnessMs;
}

function matchingReceiptStatusSummary(
  receipt: EffectReceipt,
  summaries: readonly ReceiptStatusSummary[],
): ReceiptStatusSummary | undefined {
  return summaries.find((summary) => {
    if (summary.effectId !== receipt.effectId) {
      return false;
    }

    return (
      summary.receiptId === undefined || summary.receiptId === receipt.receiptId
    );
  });
}

function effectRequestsFromEvents(
  events: readonly RunEvent[],
): EffectRequest[] {
  return events
    .filter(
      (event): event is RunEvent<"EffectRequested"> =>
        event.type === "EffectRequested",
    )
    .map((event) => event.payload.effectRequest);
}

function receiptsFromEvents(events: readonly RunEvent[]): EffectReceipt[] {
  return events
    .filter(
      (event): event is RunEvent<"EffectReceiptRecorded"> =>
        event.type === "EffectReceiptRecorded",
    )
    .map((event) => event.payload.receipt);
}

function observationsFromEvents(
  events: readonly RunEvent[],
): ExternalStateObservation[] {
  return events
    .filter(
      (event): event is RunEvent<"ExternalStateObserved"> =>
        event.type === "ExternalStateObserved",
    )
    .map((event) => event.payload.observation);
}

function uniqueEffectRequests(
  requests: readonly EffectRequest[],
): EffectRequest[] {
  return uniqueBy(requests, (request) => request.effectId);
}

function uniqueReceipts(receipts: readonly EffectReceipt[]): EffectReceipt[] {
  return uniqueBy(receipts, (receipt) => receipt.receiptId);
}

function uniqueObservations(
  observations: readonly ExternalStateObservation[],
): ExternalStateObservation[] {
  return uniqueBy(observations, (observation) => observation.observationId);
}

function uniqueBy<TValue>(
  values: readonly TValue[],
  keyFor: (value: TValue) => string,
): TValue[] {
  const seen = new Set<string>();
  const unique: TValue[] = [];

  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
  }

  return unique;
}

function sortEffectRequests(
  requests: readonly EffectRequest[],
): EffectRequest[] {
  return [...requests].sort((left, right) =>
    left.effectId.localeCompare(right.effectId),
  );
}

function sortReceipts(receipts: readonly EffectReceipt[]): EffectReceipt[] {
  return [...receipts].sort((left, right) =>
    left.receiptId.localeCompare(right.receiptId),
  );
}

function sortObservations(
  observations: readonly ExternalStateObservation[],
): ExternalStateObservation[] {
  return [...observations].sort((left, right) =>
    left.observationId.localeCompare(right.observationId),
  );
}

function sortReceiptStatusSummaries(
  summaries: readonly ReceiptStatusSummary[],
): ReceiptStatusSummary[] {
  return [...summaries].sort((left, right) =>
    receiptSummarySortKey(left).localeCompare(receiptSummarySortKey(right)),
  );
}

function receiptSummarySortKey(summary: ReceiptStatusSummary): string {
  return `${summary.effectId}:${summary.receiptId ?? ""}:${summary.observedAt}`;
}

function observationTarget(
  observation: ExternalStateObservation,
): ExternalObservationTarget {
  return {
    kind: "external_observation",
    observationId: observation.observationId,
    observationType: observation.observationType,
    subjectType: observation.subjectType,
    subjectId: observation.subjectId,
  };
}

function receiptTarget(receipt: EffectReceipt): EffectReceiptTarget {
  return {
    kind: "effect_receipt",
    effectId: receipt.effectId,
    receiptId: receipt.receiptId,
  };
}

function observationIdentity(
  observation: ExternalStateObservation,
): JsonObject {
  return {
    observationType: observation.observationType,
    subjectType: observation.subjectType,
    subjectId: observation.subjectId,
  };
}

function observationHashSummary(
  observation: ExternalStateObservation,
): JsonObject {
  return {
    observationId: observation.observationId,
    payloadHash: observation.payloadHash,
    observedAt: observation.observedAt,
  };
}

function statusSummarySummary(summary: ReceiptStatusSummary): JsonObject {
  return {
    effectId: summary.effectId,
    status: summary.status,
    certainty: summary.certainty,
    observedAt: summary.observedAt,
    ...(summary.receiptId === undefined
      ? {}
      : { receiptId: summary.receiptId }),
    ...(summary.sourceEventId === undefined
      ? {}
      : { sourceEventId: summary.sourceEventId }),
  };
}

function hashExpectation(hash: Sha256Hash): JsonObject {
  return { payloadHash: hash };
}

function reportId(runId: string, checkedAt: ISODateTimeString): string {
  return scopedId("reconciliation_report", runId, checkedAt);
}

function scopedId(prefix: string, ...parts: readonly string[]): string {
  return [prefix, ...parts.map(sanitizeIdPart)].join("_");
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
