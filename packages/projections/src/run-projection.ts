import { canonicalHash, parseRunEvent } from "@amca/contracts";
import type {
  EffectReceipt,
  EffectRequest,
  ExternalStateObservation,
  FinalCandidate,
  JsonValue,
  Mismatch,
  ProofObject,
  Proposal,
  ReleaseDecision,
  RunEvent,
  RunEventPayloadByType,
  RunEventType,
  RunStartedPayload,
} from "@amca/protocol";

export type ProjectionErrorCode =
  | "duplicate_event_id"
  | "empty_event_stream"
  | "invalid_causation_id"
  | "invalid_event_order"
  | "missing_run_started"
  | "payload_hash_mismatch"
  | "run_id_mismatch";

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, message: string) {
    super(message);
    this.name = "ProjectionError";
    this.code = code;
  }
}

export type RunProjectionStatus =
  | "started"
  | "running"
  | "blocked"
  | "needs_repair"
  | "quarantined"
  | "released";

export interface RunProjectionSummary {
  runId: string;
  status: RunProjectionStatus;
  eventCount: number;
  lastSequence: number;
  startedAt: string;
  lastEventAt: string;
  finalReleased: boolean;
  profile?: string;
  metadata?: Record<string, JsonValue>;
}

export interface RunProjection {
  runId: string;
  summary: RunProjectionSummary;
  eventIds: readonly string[];
  proposals: readonly Proposal[];
  effectRequests: readonly EffectRequest[];
  receipts: readonly EffectReceipt[];
  observations: readonly ExternalStateObservation[];
  finalCandidates: readonly FinalCandidate[];
  proofs: readonly ProofObject[];
  mismatches: readonly Mismatch[];
  releaseDecisions: readonly ReleaseDecision[];
  finalReleased: boolean;
  finalCandidate?: FinalCandidate;
  proof?: ProofObject;
  releaseDecision?: ReleaseDecision;
  finalReleasedCandidate?: FinalCandidate;
}

export function rebuildRunProjection(
  events: readonly RunEvent[],
): RunProjection {
  const orderedEvents = validateAcceptedEventSequence(events);
  const startedEvent = orderedEvents[0];

  if (startedEvent === undefined) {
    throw new ProjectionError(
      "empty_event_stream",
      "Cannot rebuild a run projection from an empty event stream.",
    );
  }

  if (startedEvent.type !== "RunStarted") {
    throw new ProjectionError(
      "missing_run_started",
      "Run projections must begin with a RunStarted event.",
    );
  }

  const startedPayload = payloadAs(startedEvent, "RunStarted");
  const projection = new MutableRunProjection(
    startedPayload,
    startedEvent as TypedRunEvent<"RunStarted">,
  );

  for (const event of orderedEvents.slice(1)) {
    projection.apply(event);
  }

  return projection.toProjection();
}

export function validateAcceptedEventSequence(
  events: readonly RunEvent[],
): RunEvent[] {
  if (events.length === 0) {
    return [];
  }

  const expectedRunId = events[0]?.runId;
  if (expectedRunId === undefined) {
    return [];
  }

  const seenEventIds = new Set<string>();
  const acceptedEvents: RunEvent[] = [];

  for (const [index, event] of events.entries()) {
    parseRunEvent(event);

    if (event.runId !== expectedRunId) {
      throw new ProjectionError(
        "run_id_mismatch",
        `Event ${event.eventId} belongs to run ${event.runId}, not ${expectedRunId}.`,
      );
    }

    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new ProjectionError(
        "invalid_event_order",
        `Event ${event.eventId} sequence must be ${String(
          expectedSequence,
        )} in the accepted event stream; received ${String(event.sequence)}.`,
      );
    }

    if (seenEventIds.has(event.eventId)) {
      throw new ProjectionError(
        "duplicate_event_id",
        `Event ${event.eventId} appears more than once in the accepted event stream.`,
      );
    }

    const payloadHash = canonicalHash(event.payload as unknown as JsonValue);
    if (event.payloadHash !== payloadHash) {
      throw new ProjectionError(
        "payload_hash_mismatch",
        `Event ${event.eventId} payloadHash does not match its payload.`,
      );
    }

    if (event.causationId !== null && !seenEventIds.has(event.causationId)) {
      throw new ProjectionError(
        "invalid_causation_id",
        `Event ${event.eventId} causationId ${event.causationId} does not reference an earlier event.`,
      );
    }

    seenEventIds.add(event.eventId);
    acceptedEvents.push(cloneRunEvent(event));
  }

  return acceptedEvents;
}

class MutableRunProjection {
  readonly runId: string;
  readonly eventIds: string[];
  readonly proposals: Proposal[] = [];
  readonly effectRequests: EffectRequest[] = [];
  readonly receipts: EffectReceipt[] = [];
  readonly observations: ExternalStateObservation[] = [];
  readonly finalCandidates: FinalCandidate[] = [];
  readonly proofs: ProofObject[] = [];
  readonly mismatches: Mismatch[] = [];
  readonly releaseDecisions: ReleaseDecision[] = [];
  readonly startedAt: string;
  readonly profile?: string;
  readonly metadata?: Record<string, JsonValue>;
  lastSequence: number;
  lastEventAt: string;
  finalReleased = false;
  finalReleasedCandidate?: FinalCandidate;

  constructor(payload: RunStartedPayload, event: RunEvent<"RunStarted">) {
    this.runId = payload.runId;
    this.eventIds = [event.eventId];
    this.startedAt = event.occurredAt;
    this.lastEventAt = event.occurredAt;
    this.lastSequence = event.sequence;

    if (payload.profile !== undefined) {
      this.profile = payload.profile;
    }

    if (payload.metadata !== undefined) {
      this.metadata = cloneJson(payload.metadata);
    }
  }

  apply(event: RunEvent): void {
    this.eventIds.push(event.eventId);
    this.lastSequence = event.sequence;
    this.lastEventAt = event.occurredAt;

    switch (event.type) {
      case "RunStarted":
        return;

      case "ProposalReceived": {
        const proposal = cloneJson(
          payloadAs(event, "ProposalReceived").proposal,
        );
        this.proposals.push(proposal);

        if (proposal.kind === "final_candidate") {
          this.finalCandidates.push(proposal);
        }

        return;
      }

      case "EffectRequested":
        this.effectRequests.push(
          cloneJson(payloadAs(event, "EffectRequested").effectRequest),
        );
        return;

      case "EffectReceiptRecorded":
        this.receipts.push(
          cloneJson(payloadAs(event, "EffectReceiptRecorded").receipt),
        );
        return;

      case "ExternalStateObserved":
        this.observations.push(
          cloneJson(payloadAs(event, "ExternalStateObserved").observation),
        );
        return;

      case "ProofGenerated":
        this.proofs.push(cloneJson(payloadAs(event, "ProofGenerated").proof));
        return;

      case "MismatchDetected":
        this.mismatches.push(
          cloneJson(payloadAs(event, "MismatchDetected").mismatch),
        );
        return;

      case "ReleaseDecided":
        this.releaseDecisions.push(
          cloneJson(payloadAs(event, "ReleaseDecided").decision),
        );
        return;

      case "FinalReleased":
        this.finalReleased = true;
        this.finalReleasedCandidate = cloneJson(
          payloadAs(event, "FinalReleased").candidate,
        );
        return;
    }
  }

  toProjection(): RunProjection {
    const latestFinalCandidate = last(this.finalCandidates);
    const latestProof = last(this.proofs);
    const latestReleaseDecision = last(this.releaseDecisions);

    return {
      runId: this.runId,
      summary: this.summary(latestReleaseDecision),
      eventIds: [...this.eventIds],
      proposals: cloneJson(this.proposals),
      effectRequests: cloneJson(this.effectRequests),
      receipts: cloneJson(this.receipts),
      observations: cloneJson(this.observations),
      finalCandidates: cloneJson(this.finalCandidates),
      proofs: cloneJson(this.proofs),
      mismatches: cloneJson(this.mismatches),
      releaseDecisions: cloneJson(this.releaseDecisions),
      finalReleased: this.finalReleased,
      ...(latestFinalCandidate === undefined
        ? {}
        : { finalCandidate: cloneJson(latestFinalCandidate) }),
      ...(latestProof === undefined ? {} : { proof: cloneJson(latestProof) }),
      ...(latestReleaseDecision === undefined
        ? {}
        : { releaseDecision: cloneJson(latestReleaseDecision) }),
      ...(this.finalReleasedCandidate === undefined
        ? {}
        : { finalReleasedCandidate: cloneJson(this.finalReleasedCandidate) }),
    };
  }

  private summary(
    releaseDecision: ReleaseDecision | undefined,
  ): RunProjectionSummary {
    const status =
      releaseDecision === undefined
        ? this.runningStatus()
        : releaseDecision.status;

    return {
      runId: this.runId,
      status,
      eventCount: this.eventIds.length,
      lastSequence: this.lastSequence,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      finalReleased: this.finalReleased,
      ...(this.profile === undefined ? {} : { profile: this.profile }),
      ...(this.metadata === undefined
        ? {}
        : { metadata: cloneJson(this.metadata) }),
    };
  }

  private runningStatus(): RunProjectionStatus {
    return this.eventIds.length === 1 ? "started" : "running";
  }
}

function cloneRunEvent<TType extends RunEvent["type"]>(
  event: RunEvent<TType>,
): RunEvent<TType> {
  return {
    ...event,
    payload: cloneJson(event.payload),
  };
}

type TypedRunEvent<TType extends RunEventType> = RunEvent<
  TType,
  RunEventPayloadByType[TType]
>;

function payloadAs<TType extends RunEventType>(
  event: RunEvent,
  type: TType,
): RunEventPayloadByType[TType] {
  if (event.type !== type) {
    throw new ProjectionError(
      "invalid_event_order",
      `Expected event ${event.eventId} to be ${type}; received ${event.type}.`,
    );
  }

  return event.payload as RunEventPayloadByType[TType];
}

function cloneJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function last<TValue>(values: readonly TValue[]): TValue | undefined {
  return values.at(-1);
}
