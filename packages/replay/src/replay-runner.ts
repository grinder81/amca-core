import {
  parseApprovalDenial,
  parseApprovalExpiry,
  parseApprovalGrant,
  parseApprovalRequest,
  parseEffectReceipt,
  parseEffectRequest,
  parseExternalStateObservation,
  parseFinalCandidate,
  parseMutationCommandRequest,
  parseProofObject,
  parseReleaseDecision,
  parseRunEvent,
  parseWritePreflightCandidate,
  parseWritePreflightDecision,
  parseWriteQuarantineState,
} from "@amca/contracts";
import {
  InMemoryRunKernel,
  orderAndValidateRunEvents,
  type KernelEventOptions,
} from "@amca/kernel";
import type {
  MutationCommandRequest,
  ProofObject,
  ReleaseDecision,
  RunEvent,
} from "@amca/protocol";

export type ReplayFailureCode =
  | "event_stream_integrity_failed"
  | "final_candidate_missing"
  | "proof_event_missing"
  | "release_event_missing"
  | "replay_diverged";

export class ReplayRunError extends Error {
  readonly code: ReplayFailureCode;

  constructor(code: ReplayFailureCode, message: string) {
    super(message);
    this.name = "ReplayRunError";
    this.code = code;
  }
}

export interface ReplayRunEventsInput {
  readonly runId?: string;
  readonly events: readonly RunEvent[];
}

export interface ReplaySuccess {
  readonly status: "passed";
  readonly runId: string;
  readonly replayedEvents: readonly RunEvent[];
  readonly replayedDecision: ReleaseDecision;
  readonly storedDecision: ReleaseDecision;
  readonly notes: readonly string[];
}

export interface ReplayFailure {
  readonly status: "failed";
  readonly runId?: string;
  readonly code: ReplayFailureCode;
  readonly message: string;
  readonly notes: readonly string[];
}

export type ReplayResult = ReplaySuccess | ReplayFailure;

export function replayRunEvents(input: ReplayRunEventsInput): ReplayResult {
  try {
    assertStreamOrder(input.events);
    const events = orderAndValidateRunEvents(
      input.events.map((event) => parseRunEvent(event)),
      input.runId,
    );
    const runId = input.runId ?? events[0]?.runId;

    if (runId === undefined) {
      throw new ReplayRunError(
        "event_stream_integrity_failed",
        "Replay requires at least one accepted semantic event.",
      );
    }

    const finalProposalEvent = lastFinalCandidateEvent(events);
    if (finalProposalEvent === undefined) {
      throw new ReplayRunError(
        "final_candidate_missing",
        `Run ${runId} has no final candidate proposal event.`,
      );
    }

    const finalCandidate = parseFinalCandidate(
      finalProposalEvent.payload.proposal,
    );
    const proofEvent = firstEventAfter(
      events,
      finalProposalEvent,
      "ProofGenerated",
    );
    if (proofEvent === undefined) {
      throw new ReplayRunError(
        "proof_event_missing",
        `Run ${runId} has no ProofGenerated event after final candidate ${finalCandidate.candidateId}.`,
      );
    }

    const storedProof = parseProofObject(proofEvent.payload.proof);
    const releaseEvent = firstEventAfter(events, proofEvent, "ReleaseDecided");
    if (releaseEvent === undefined) {
      throw new ReplayRunError(
        "release_event_missing",
        `Run ${runId} has no ReleaseDecided event after proof ${storedProof.proofId}.`,
      );
    }

    const storedDecision = parseReleaseDecision(releaseEvent.payload.decision);
    const mismatchEvents = events.filter(
      (event): event is RunEvent<"MismatchDetected"> =>
        event.type === "MismatchDetected" &&
        event.sequence > proofEvent.sequence &&
        event.sequence < releaseEvent.sequence,
    );
    const finalReleasedEvent = firstEventAfter(
      events,
      releaseEvent,
      "FinalReleased",
    );

    const kernel = new InMemoryRunKernel({
      runId,
      clock: () => storedProof.generatedAt,
    });
    replayAcceptedInputsBeforeFinalCandidate({
      events,
      finalProposalEvent,
      kernel,
    });

    const replayedFinal = kernel.submitFinalCandidate(finalCandidate, {
      ...eventOptionsFrom(finalProposalEvent),
      generatedAt: storedProof.generatedAt,
      proofId: storedProof.proofId,
      proofEventId: proofEvent.eventId,
      mismatchEventIds: mismatchEvents.map((event) => event.eventId),
      releaseEventId: releaseEvent.eventId,
      ...(finalReleasedEvent === undefined
        ? {}
        : { finalReleasedEventId: finalReleasedEvent.eventId }),
    });
    const notes = replayDivergenceNotes({
      expectedEvents: events,
      replayedEvents: kernel.events(),
      replayedDecision: replayedFinal.decision,
      storedDecision,
      storedProof,
      replayedProof: replayedFinal.proof,
    });

    if (notes.length > 0) {
      return {
        status: "failed",
        runId,
        code: "replay_diverged",
        message: `Run ${runId} replay diverged from stored semantic events.`,
        notes,
      };
    }

    return {
      status: "passed",
      runId,
      replayedEvents: kernel.events(),
      replayedDecision: replayedFinal.decision,
      storedDecision,
      notes: [],
    };
  } catch (error) {
    if (error instanceof ReplayRunError) {
      return {
        status: "failed",
        code: error.code,
        message: error.message,
        notes: [error.message],
      };
    }

    return {
      status: "failed",
      code: "event_stream_integrity_failed",
      message: formatError(error),
      notes: [formatError(error)],
    };
  }
}

function replayAcceptedInputsBeforeFinalCandidate(input: {
  readonly events: readonly RunEvent[];
  readonly finalProposalEvent: RunEvent<"ProposalReceived">;
  readonly kernel: InMemoryRunKernel;
}): void {
  for (const event of input.events) {
    if (event.sequence >= input.finalProposalEvent.sequence) {
      return;
    }

    switch (event.type) {
      case "RunStarted":
        {
          const runStartedEvent = event as RunEvent<"RunStarted">;
          const profile = runStartedEvent.payload.profile;
          const metadata = runStartedEvent.payload.metadata;
          input.kernel.startRun({
            ...eventOptionsFrom(runStartedEvent),
            ...(profile === undefined ? {} : { profile }),
            ...(metadata === undefined ? {} : { metadata }),
          });
        }
        break;

      case "ProposalReceived":
        {
          const proposalEvent = event as RunEvent<"ProposalReceived">;
          if (proposalEvent.payload.proposal.kind === "tool_command_request") {
            input.kernel.submitToolCommand(
              proposalEvent.payload.proposal,
              eventOptionsFrom(proposalEvent),
            );
          } else if (
            proposalEvent.payload.proposal.kind === "mutation_command_request"
          ) {
            input.kernel.submitMutationCommand(
              parseMutationCommandRequest(proposalEvent.payload.proposal),
              eventOptionsFrom(proposalEvent),
            );
          }
        }
        break;

      case "EffectRequested":
        {
          const effectRequestedEvent = event as RunEvent<"EffectRequested">;
          input.kernel.recordEffectRequest(
            parseEffectRequest(effectRequestedEvent.payload.effectRequest),
            eventOptionsFrom(effectRequestedEvent),
          );
        }
        break;

      case "WritePreflightRequested":
        {
          const preflightRequestedEvent =
            event as RunEvent<"WritePreflightRequested">;
          input.kernel.recordWritePreflightRequested(
            parseWritePreflightCandidate(
              preflightRequestedEvent.payload.candidate,
            ),
            eventOptionsFrom(preflightRequestedEvent),
          );
        }
        break;

      case "WritePreflightDecided":
        {
          const preflightDecidedEvent =
            event as RunEvent<"WritePreflightDecided">;
          input.kernel.recordWritePreflightDecided(
            parseWritePreflightDecision(preflightDecidedEvent.payload.decision),
            eventOptionsFrom(preflightDecidedEvent),
          );
        }
        break;

      case "WriteQuarantined":
        {
          const quarantinedEvent = event as RunEvent<"WriteQuarantined">;
          input.kernel.recordWriteQuarantined(
            parseWriteQuarantineState(quarantinedEvent.payload.quarantine),
            eventOptionsFrom(quarantinedEvent),
          );
        }
        break;

      case "ApprovalRequested":
        {
          const requestedEvent = event as RunEvent<"ApprovalRequested">;
          input.kernel.recordApprovalRequested(
            parseApprovalRequest(requestedEvent.payload.request),
            eventOptionsFrom(requestedEvent),
          );
        }
        break;

      case "ApprovalGranted":
        {
          const grantedEvent = event as RunEvent<"ApprovalGranted">;
          input.kernel.recordApprovalGranted(
            parseApprovalGrant(grantedEvent.payload.grant),
            eventOptionsFrom(grantedEvent),
          );
        }
        break;

      case "ApprovalDenied":
        {
          const deniedEvent = event as RunEvent<"ApprovalDenied">;
          input.kernel.recordApprovalDenied(
            parseApprovalDenial(deniedEvent.payload.denial),
            eventOptionsFrom(deniedEvent),
          );
        }
        break;

      case "ApprovalExpired":
        {
          const expiredEvent = event as RunEvent<"ApprovalExpired">;
          input.kernel.recordApprovalExpired(
            parseApprovalExpiry(expiredEvent.payload.expiry),
            eventOptionsFrom(expiredEvent),
          );
        }
        break;

      case "MutationCommitted":
        {
          const mutationEvent = event as RunEvent<"MutationCommitted">;
          const proposal = mutationProposalBefore(
            input.events,
            event,
            mutationEvent.payload.mutation.mutationId,
          );

          if (proposal === undefined) {
            throw new ReplayRunError(
              "event_stream_integrity_failed",
              `Run ${event.runId} has MutationCommitted ${mutationEvent.payload.mutation.mutationId} before its proposal.`,
            );
          }

          input.kernel.commitMutation(
            parseMutationCommandRequest(proposal),
            eventOptionsFrom(mutationEvent),
          );
        }
        break;

      case "EffectReceiptRecorded":
        {
          const receiptEvent = event as RunEvent<"EffectReceiptRecorded">;
          input.kernel.recordEffectReceipt(
            parseEffectReceipt(receiptEvent.payload.receipt),
            eventOptionsFrom(receiptEvent),
          );
        }
        break;

      case "ExternalStateObserved":
        {
          const observationEvent = event as RunEvent<"ExternalStateObserved">;
          input.kernel.recordExternalStateObservation(
            parseExternalStateObservation(observationEvent.payload.observation),
            eventOptionsFrom(observationEvent),
          );
        }
        break;

      case "ProofGenerated":
      case "MismatchDetected":
      case "ReleaseDecided":
      case "FinalReleased":
        throw new ReplayRunError(
          "event_stream_integrity_failed",
          `Run ${event.runId} has generated event ${event.type} before the final candidate being replayed.`,
        );
    }
  }
}

function replayDivergenceNotes(input: {
  readonly expectedEvents: readonly RunEvent[];
  readonly replayedEvents: readonly RunEvent[];
  readonly replayedDecision: ReleaseDecision;
  readonly storedDecision: ReleaseDecision;
  readonly storedProof: ProofObject;
  readonly replayedProof: ProofObject;
}): string[] {
  const notes: string[] = [];
  const expectedPrefix = input.expectedEvents.slice(
    0,
    input.replayedEvents.length,
  );
  const expectedTypes = expectedPrefix.map((event) => event.type);
  const replayedTypes = input.replayedEvents.map((event) => event.type);

  if (!sameValues(expectedTypes, replayedTypes)) {
    notes.push(
      `event types changed: stored=${expectedTypes.join(",")} replayed=${replayedTypes.join(",")}`,
    );
  }

  if (input.replayedDecision.status !== input.storedDecision.status) {
    notes.push(
      `release status changed: stored=${input.storedDecision.status} replayed=${input.replayedDecision.status}`,
    );
  }

  if (
    !sameValues(
      input.storedProof.blockingMismatches.map((mismatch) => mismatch.type),
      input.replayedProof.blockingMismatches.map((mismatch) => mismatch.type),
    )
  ) {
    notes.push("blocking mismatch types changed during replay.");
  }

  if (
    !sameValues(
      input.storedDecision.approvedClaimIds,
      input.replayedDecision.approvedClaimIds,
    )
  ) {
    notes.push("approved claim ids changed during replay.");
  }

  return notes;
}

function assertStreamOrder(events: readonly RunEvent[]): void {
  for (const [index, event] of events.entries()) {
    const expected = index + 1;
    if (event.sequence !== expected) {
      throw new ReplayRunError(
        "event_stream_integrity_failed",
        `Replay input stream must be in contiguous sequence order; expected ${String(
          expected,
        )}, received ${String(event.sequence)} at index ${String(index)}.`,
      );
    }
  }
}

function eventOptionsFrom(event: RunEvent): KernelEventOptions {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    causationId: event.causationId,
    correlationId: event.correlationId,
  };
}

function lastFinalCandidateEvent(
  events: readonly RunEvent[],
): RunEvent<"ProposalReceived"> | undefined {
  let finalCandidate: RunEvent<"ProposalReceived"> | undefined;
  for (const event of events) {
    if (event.type === "ProposalReceived") {
      const proposalEvent = event as RunEvent<"ProposalReceived">;
      if (proposalEvent.payload.proposal.kind === "final_candidate") {
        finalCandidate = proposalEvent;
      }
    }
  }

  return finalCandidate;
}

function firstEventAfter<TType extends RunEvent["type"]>(
  events: readonly RunEvent[],
  after: RunEvent,
  type: TType,
): RunEvent<TType> | undefined {
  return events.find(
    (event): event is RunEvent<TType> =>
      event.type === type && event.sequence > after.sequence,
  );
}

function mutationProposalBefore(
  events: readonly RunEvent[],
  before: RunEvent,
  mutationId: string,
): MutationCommandRequest | undefined {
  for (const event of events) {
    if (event.sequence >= before.sequence) {
      return undefined;
    }

    if (event.type !== "ProposalReceived") {
      continue;
    }

    const proposal = (event as RunEvent<"ProposalReceived">).payload.proposal;
    if (
      proposal.kind === "mutation_command_request" &&
      proposal.mutationId === mutationId
    ) {
      return proposal;
    }
  }

  return undefined;
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
