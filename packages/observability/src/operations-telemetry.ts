import type {
  ISODateTimeString,
  JsonObject,
  JsonValue,
  ReleaseDecision,
  RunEvent,
  RunEventPayloadByType,
  RunEventType,
} from "@amca/protocol";

import {
  redactOperationalText,
  redactOperationalValue,
  type RedactionPolicy,
} from "./redaction.js";

export type OperationalMetricName =
  | "effect_latency_ms"
  | "mismatch_detected_total"
  | "mismatch_rate"
  | "proof_latency_ms"
  | "quarantine_total"
  | "release_decision_total"
  | "release_gate_block_count"
  | "release_gate_pass_count"
  | "replay_success_total";

export type OperationalMetricUnit = "count" | "ms" | "ratio";

export interface OperationalMetric {
  readonly name: OperationalMetricName;
  readonly value: number;
  readonly unit: OperationalMetricUnit;
  readonly attributes: JsonObject;
}

export interface OperationalTraceSpan {
  readonly spanId: string;
  readonly name: string;
  readonly runId: string;
  readonly eventId?: string;
  readonly startedAt: ISODateTimeString;
  readonly endedAt: ISODateTimeString;
  readonly durationMs: number;
  readonly attributes: JsonObject;
}

export interface OperationalAuditEntry {
  readonly auditId: string;
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly occurredAt: ISODateTimeString;
  readonly summary: string;
  readonly attributes: JsonObject;
}

export interface ReplayTelemetryInput {
  readonly replayId: string;
  readonly status: "passed" | "failed";
  readonly durationMs: number;
}

export interface OperationalTelemetryInput {
  readonly events: readonly RunEvent[];
  readonly generatedAt: ISODateTimeString;
  readonly replayResults?: readonly ReplayTelemetryInput[];
  readonly redaction?: RedactionPolicy;
}

export interface OperationalTelemetryReport {
  readonly kind: "amca_operational_telemetry";
  readonly generatedAt: ISODateTimeString;
  readonly proofUsable: false;
  readonly authority: {
    readonly admitsEvidence: false;
    readonly executesEffects: false;
    readonly mutatesTruth: false;
    readonly proofAuthority: false;
    readonly releaseAuthority: false;
  };
  readonly metrics: readonly OperationalMetric[];
  readonly traces: readonly OperationalTraceSpan[];
  readonly audit: readonly OperationalAuditEntry[];
}

export function collectOperationalTelemetry(
  input: OperationalTelemetryInput,
): OperationalTelemetryReport {
  const orderedEvents = [...input.events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const metrics: OperationalMetric[] = [
    ...releaseDecisionMetrics(orderedEvents, input.redaction),
    ...mismatchMetrics(orderedEvents, input.redaction),
    ...quarantineMetrics(orderedEvents, input.redaction),
    ...effectLatencyMetrics(orderedEvents, input.redaction),
    ...proofLatencyMetrics(orderedEvents, input.redaction),
    ...replayMetrics(input.replayResults ?? [], input.redaction),
  ];

  return {
    kind: "amca_operational_telemetry",
    generatedAt: input.generatedAt,
    proofUsable: false,
    authority: {
      admitsEvidence: false,
      executesEffects: false,
      mutatesTruth: false,
      proofAuthority: false,
      releaseAuthority: false,
    },
    metrics,
    traces: buildTraceSpans(orderedEvents, input.redaction),
    audit: buildAuditEntries(orderedEvents, input.redaction),
  };
}

function releaseDecisionMetrics(
  events: readonly RunEvent[],
  policy: RedactionPolicy = {},
): OperationalMetric[] {
  const decisions = events
    .filter((event) => event.type === "ReleaseDecided")
    .map((event) => event.payload)
    .filter(hasDecisionPayload)
    .map((payload) => payload.decision);
  const metrics: OperationalMetric[] = [];
  const statuses = ["released", "blocked", "needs_repair", "quarantined"];

  for (const status of statuses) {
    const count = decisions.filter(
      (decision) => decision.status === status,
    ).length;
    if (count > 0) {
      metrics.push(
        metric("release_decision_total", count, "count", policy, {
          status,
        }),
      );
    }
  }

  metrics.push(
    metric(
      "release_gate_pass_count",
      decisions.filter((decision) => decision.status === "released").length,
      "count",
      policy,
      {},
    ),
  );
  metrics.push(
    metric(
      "release_gate_block_count",
      decisions.filter((decision) => decision.status !== "released").length,
      "count",
      policy,
      {},
    ),
  );

  return metrics;
}

function mismatchMetrics(
  events: readonly RunEvent[],
  policy: RedactionPolicy = {},
): OperationalMetric[] {
  const mismatches = events
    .filter((event): event is RunEvent<"MismatchDetected"> =>
      isRunEvent(event, "MismatchDetected"),
    )
    .map((event) => event.payload.mismatch);
  const releaseDecisionCount = events.filter(
    (event) => event.type === "ReleaseDecided",
  ).length;
  const metrics = mismatches.map((mismatch) =>
    metric("mismatch_detected_total", 1, "count", policy, {
      mismatchType: mismatch.type,
      blocking: mismatch.blocking,
    }),
  );

  metrics.push(
    metric(
      "mismatch_rate",
      releaseDecisionCount === 0 ? 0 : mismatches.length / releaseDecisionCount,
      "ratio",
      policy,
      {},
    ),
  );

  return metrics;
}

function quarantineMetrics(
  events: readonly RunEvent[],
  policy: RedactionPolicy = {},
): OperationalMetric[] {
  const writeQuarantineCount = events.filter(
    (event) => event.type === "WriteQuarantined",
  ).length;
  const releaseQuarantineCount = events
    .filter((event) => event.type === "ReleaseDecided")
    .map((event) => event.payload)
    .filter(hasDecisionPayload)
    .filter((payload) => payload.decision.status === "quarantined").length;

  return [
    metric("quarantine_total", writeQuarantineCount, "count", policy, {
      source: "write_lifecycle",
    }),
    metric("quarantine_total", releaseQuarantineCount, "count", policy, {
      source: "release_gate",
    }),
  ];
}

function effectLatencyMetrics(
  events: readonly RunEvent[],
  policy: RedactionPolicy = {},
): OperationalMetric[] {
  const requestedAtByEffectId = new Map<string, RunEvent>();
  const metrics: OperationalMetric[] = [];

  for (const event of events) {
    if (isRunEvent(event, "EffectRequested")) {
      const effectRequest = event.payload.effectRequest;
      requestedAtByEffectId.set(effectRequest.effectId, event);
    }

    if (isRunEvent(event, "EffectReceiptRecorded")) {
      const receipt = event.payload.receipt;
      const requestEvent = requestedAtByEffectId.get(receipt.effectId);
      if (requestEvent !== undefined) {
        metrics.push(
          metric(
            "effect_latency_ms",
            nonNegativeDurationMs(requestEvent.occurredAt, event.occurredAt),
            "ms",
            policy,
            {
              capabilityId: receipt.capabilityId,
              receiptType: receipt.receiptType,
              status: receipt.status,
            },
          ),
        );
      }
    }
  }

  return metrics;
}

function proofLatencyMetrics(
  events: readonly RunEvent[],
  policy: RedactionPolicy = {},
): OperationalMetric[] {
  const proposalEventByCandidateId = new Map<string, RunEvent>();
  const metrics: OperationalMetric[] = [];

  for (const event of events) {
    if (isRunEvent(event, "ProposalReceived")) {
      const proposal = event.payload.proposal;
      if (proposal.kind === "final_candidate") {
        proposalEventByCandidateId.set(proposal.candidateId, event);
      }
    }

    if (isRunEvent(event, "ProofGenerated")) {
      const proof = event.payload.proof;
      const proposalEvent = proposalEventByCandidateId.get(proof.candidateId);
      if (proposalEvent !== undefined) {
        metrics.push(
          metric(
            "proof_latency_ms",
            nonNegativeDurationMs(proposalEvent.occurredAt, event.occurredAt),
            "ms",
            policy,
            {
              verdict: proof.verdict,
              approvedClaimCount: proof.approvedClaimIds.length,
              rejectedClaimCount: proof.rejectedClaimIds.length,
            },
          ),
        );
      }
    }
  }

  return metrics;
}

function replayMetrics(
  replayResults: readonly ReplayTelemetryInput[],
  policy: RedactionPolicy = {},
): OperationalMetric[] {
  return replayResults.map((result) =>
    metric(
      "replay_success_total",
      result.status === "passed" ? 1 : 0,
      "count",
      policy,
      {
        replayId: result.replayId,
        status: result.status,
        durationMs: result.durationMs,
      },
    ),
  );
}

function buildTraceSpans(
  events: readonly RunEvent[],
  policy: RedactionPolicy = {},
): OperationalTraceSpan[] {
  return events.map((event) => ({
    spanId: redactOperationalText(`span_${event.eventId}`, policy),
    name: `amca.event.${event.type}`,
    runId: redactOperationalText(event.runId, policy),
    eventId: redactOperationalText(event.eventId, policy),
    startedAt: event.occurredAt,
    endedAt: event.occurredAt,
    durationMs: 0,
    attributes: redactAttributes(
      eventAttributeSummary(event),
      policy,
    ) as JsonObject,
  }));
}

function buildAuditEntries(
  events: readonly RunEvent[],
  policy: RedactionPolicy = {},
): OperationalAuditEntry[] {
  return events.map((event) => ({
    auditId: redactOperationalText(`audit_${event.eventId}`, policy),
    runId: redactOperationalText(event.runId, policy),
    eventId: redactOperationalText(event.eventId, policy),
    sequence: event.sequence,
    eventType: event.type,
    occurredAt: event.occurredAt,
    summary: summarizeEvent(event),
    attributes: redactAttributes(
      {
        payloadHash: event.payloadHash,
        causationId: event.causationId,
        correlationId: event.correlationId,
        ...eventAttributeSummary(event),
      },
      policy,
    ) as JsonObject,
  }));
}

function eventAttributeSummary(event: RunEvent): JsonObject {
  switch (event.type) {
    case "RunStarted":
      return {
        profile: payloadFor(event, "RunStarted").profile ?? "unspecified",
      };
    case "ProposalReceived": {
      const payload = payloadFor(event, "ProposalReceived");
      return { proposalKind: payload.proposal.kind };
    }
    case "EffectRequested": {
      const payload = payloadFor(event, "EffectRequested");
      return {
        capabilityId: payload.effectRequest.capabilityId,
        sideEffectClass: payload.effectRequest.sideEffectClass,
      };
    }
    case "WritePreflightRequested": {
      const payload = payloadFor(event, "WritePreflightRequested");
      return {
        capabilityId: payload.candidate.capabilityId,
        sideEffectClass: payload.candidate.sideEffectClass,
      };
    }
    case "WritePreflightDecided":
      return {
        status: payloadFor(event, "WritePreflightDecided").decision.status,
      };
    case "WriteQuarantined":
      return {
        reason: payloadFor(event, "WriteQuarantined").quarantine.reason,
      };
    case "EffectReceiptRecorded": {
      const payload = payloadFor(event, "EffectReceiptRecorded");
      return {
        capabilityId: payload.receipt.capabilityId,
        receiptType: payload.receipt.receiptType,
        status: payload.receipt.status,
      };
    }
    case "ExternalStateObserved": {
      const payload = payloadFor(event, "ExternalStateObserved");
      return {
        observationType: payload.observation.observationType,
        subjectType: payload.observation.subjectType,
      };
    }
    case "ProofGenerated": {
      const payload = payloadFor(event, "ProofGenerated");
      return {
        verdict: payload.proof.verdict,
        approvedClaimCount: payload.proof.approvedClaimIds.length,
        rejectedClaimCount: payload.proof.rejectedClaimIds.length,
      };
    }
    case "MismatchDetected": {
      const payload = payloadFor(event, "MismatchDetected");
      return {
        mismatchType: payload.mismatch.type,
        blocking: payload.mismatch.blocking,
      };
    }
    case "ReleaseDecided":
      return { status: payloadFor(event, "ReleaseDecided").decision.status };
    case "FinalReleased": {
      const payload = payloadFor(event, "FinalReleased");
      return {
        status: payload.decision.status,
        approvedClaimCount: payload.decision.approvedClaimIds.length,
      };
    }
    case "MutationCommitted": {
      const payload = payloadFor(event, "MutationCommitted");
      return {
        mutationId: payload.mutation.mutationId,
        stateRef: payload.mutation.stateRef,
        newRevision: payload.mutation.newRevision,
      };
    }
    case "ApprovalRequested": {
      const payload = payloadFor(event, "ApprovalRequested");
      return {
        approvalId: payload.request.approvalId,
        criticality: payload.request.criticality,
        scopeKind: payload.request.scope.kind,
      };
    }
    case "ApprovalGranted": {
      const payload = payloadFor(event, "ApprovalGranted");
      return {
        approvalId: payload.grant.approvalId,
        scopeKind: payload.grant.scope.kind,
      };
    }
    case "ApprovalDenied": {
      const payload = payloadFor(event, "ApprovalDenied");
      return {
        approvalId: payload.denial.approvalId,
        scopeKind: payload.denial.scope.kind,
      };
    }
    case "ApprovalExpired": {
      const payload = payloadFor(event, "ApprovalExpired");
      return {
        approvalId: payload.expiry.approvalId,
        scopeKind: payload.expiry.scope.kind,
      };
    }
  }
}

function summarizeEvent(event: RunEvent): string {
  return `AMCA accepted ${event.type} at sequence ${String(event.sequence)}.`;
}

function metric(
  name: OperationalMetricName,
  value: number,
  unit: OperationalMetricUnit,
  policy: RedactionPolicy,
  attributes: JsonObject,
): OperationalMetric {
  return {
    name,
    value,
    unit,
    attributes: redactAttributes(attributes, policy) as JsonObject,
  };
}

function redactAttributes(
  attributes: Record<string, JsonValue>,
  policy: RedactionPolicy,
): JsonValue {
  return redactOperationalValue(attributes, policy);
}

function nonNegativeDurationMs(
  startedAt: ISODateTimeString,
  endedAt: ISODateTimeString,
): number {
  const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

function hasDecisionPayload(
  value: unknown,
): value is { readonly decision: ReleaseDecision } {
  return (
    typeof value === "object" &&
    value !== null &&
    "decision" in value &&
    typeof (value as { decision?: { status?: unknown } }).decision?.status ===
      "string"
  );
}

function isRunEvent<TType extends RunEventType>(
  event: RunEvent,
  type: TType,
): event is RunEvent<TType> {
  return event.type === type;
}

function payloadFor<TType extends RunEventType>(
  event: RunEvent,
  type: TType,
): RunEventPayloadByType[TType] {
  if (event.type !== type) {
    throw new Error(`Expected ${type} event payload.`);
  }
  return event.payload as RunEventPayloadByType[TType];
}
