import {
  canonicalObjectHash,
  parseApprovalDenial,
  parseApprovalExpiry,
  parseApprovalGrant,
  parseApprovalRequest,
  parseEffectReceipt,
  parseEffectRequest,
  parseExternalStateObservation,
  parseFinalCandidate,
  parseMismatch,
  parseMutationCommandRequest,
  parseMutationCommitted,
  parseProofObject,
  parseReleaseDecision,
  parseRunEvent,
  parseToolCommandRequest,
  parseWritePreflightCandidate,
  parseWritePreflightDecision,
  parseWriteQuarantineState,
} from "@amca/contracts";
import { evaluateProof } from "@amca/proof";
import type {
  EffectReceipt,
  EffectRequest,
  ExternalStateObservation,
  EvidenceRef,
  FinalCandidate,
  ApprovalDenial,
  ApprovalExpiry,
  ApprovalGrant,
  ApprovalRequest,
  ApprovalScope,
  ISODateTimeString,
  JsonObject,
  MutationCommandRequest,
  MutationCommitted,
  Proposal,
  ProofObject,
  ReleaseDecision,
  RunEvent,
  RunEventPayloadByType,
  RunEventType,
  Sha256Hash,
  ToolCommandRequest,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";

import { InMemoryLedger } from "./in-memory-ledger.js";
import { decideRelease } from "./release-gate.js";

export type RunKernelErrorCode =
  | "effect_request_mismatch"
  | "effect_request_not_found"
  | "evidence_hash_mismatch"
  | "evidence_kind_mismatch"
  | "evidence_source_event_mismatch"
  | "insufficient_event_ids"
  | "approval_denied"
  | "approval_expired"
  | "approval_request_not_found"
  | "approval_required"
  | "approval_scope_mismatch"
  | "invalid_causation_id"
  | "invalid_correlation_id"
  | "ledger_append_failed"
  | "mutation_hash_mismatch"
  | "mutation_proposal_not_found"
  | "mutation_stale_revision"
  | "payload_hash_mismatch"
  | "run_already_started"
  | "run_id_mismatch"
  | "run_not_started"
  | "write_preflight_decision_not_found"
  | "write_preflight_mismatch"
  | "write_preflight_request_not_found"
  | "write_quarantine_mismatch";

export class RunKernelError extends Error {
  readonly code: RunKernelErrorCode;

  constructor(code: RunKernelErrorCode, message: string) {
    super(message);
    this.name = "RunKernelError";
    this.code = code;
  }
}

export type RunKernelClock = () => ISODateTimeString;

export interface InMemoryRunKernelOptions {
  readonly runId: string;
  readonly clock?: RunKernelClock;
}

export interface KernelEventOptions {
  readonly eventId?: string;
  readonly occurredAt?: ISODateTimeString;
  readonly payloadHash?: Sha256Hash;
  readonly causationId?: string | null;
  readonly correlationId?: string | null;
}

export interface StartRunOptions extends KernelEventOptions {
  readonly profile?: string;
  readonly metadata?: JsonObject;
}

export interface SubmitFinalCandidateOptions extends KernelEventOptions {
  readonly generatedAt?: ISODateTimeString;
  readonly proofEventId?: string;
  readonly proofId?: string;
  readonly mismatchEventIds?: readonly string[];
  readonly releaseEventId?: string;
  readonly finalReleasedEventId?: string;
}

export interface SubmitFinalCandidateResult {
  readonly candidate: FinalCandidate;
  readonly proof: ProofObject;
  readonly decision: ReleaseDecision;
  readonly proposalEvent: RunEvent<"ProposalReceived">;
  readonly proofEvent: RunEvent<"ProofGenerated">;
  readonly mismatchEvents: readonly RunEvent<"MismatchDetected">[];
  readonly releaseEvent: RunEvent<"ReleaseDecided">;
  readonly finalReleasedEvent?: RunEvent<"FinalReleased">;
  readonly emittedEvents: readonly RunEvent[];
}

export class InMemoryRunKernel {
  readonly runId: string;
  readonly ledger: InMemoryLedger;

  readonly #clock: RunKernelClock;
  #startedEventId: string | undefined;
  #effectRequests: EffectRequest[] = [];
  #effectReceipts: EffectReceipt[] = [];
  #externalStateObservations: ExternalStateObservation[] = [];
  #mutations: MutationCommitted[] = [];
  #stateRevisions = new Map<string, number>();
  #approvalRequests: ApprovalRequest[] = [];
  #approvalGrants: ApprovalGrant[] = [];
  #approvalDenials: ApprovalDenial[] = [];
  #approvalExpiries: ApprovalExpiry[] = [];
  #proposals: Proposal[] = [];
  #writePreflightCandidates: WritePreflightCandidate[] = [];
  #writePreflightDecisions: WritePreflightDecision[] = [];
  #writeQuarantineStates: WriteQuarantineState[] = [];

  constructor(options: InMemoryRunKernelOptions) {
    this.runId = options.runId;
    this.ledger = new InMemoryLedger({ runId: options.runId });
    this.#clock = options.clock ?? systemClock;
  }

  startRun(options: StartRunOptions = {}): RunEvent<"RunStarted"> {
    if (this.#startedEventId !== undefined) {
      throw new RunKernelError(
        "run_already_started",
        `Run ${this.runId} has already started.`,
      );
    }

    const payload: RunEventPayloadByType["RunStarted"] = {
      runId: this.runId,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };

    const event = this.appendEvent("RunStarted", payload, {
      ...options,
      causationId: options.causationId ?? null,
    });
    this.#startedEventId = event.eventId;
    return event;
  }

  submitToolCommand(
    proposal: ToolCommandRequest,
    options: KernelEventOptions = {},
  ): RunEvent<"ProposalReceived"> {
    this.assertStarted();
    const parsedProposal = parseToolCommandRequest(proposal);
    this.assertInputRunId(parsedProposal.runId, "ToolCommandRequest");

    const event = this.appendEvent(
      "ProposalReceived",
      { proposal: parsedProposal },
      this.withDefaultCausation(options),
    );
    this.#proposals.push(parsedProposal);
    return event;
  }

  submitMutationCommand(
    proposal: MutationCommandRequest,
    options: KernelEventOptions = {},
  ): RunEvent<"ProposalReceived"> {
    this.assertStarted();
    const parsedProposal = parseMutationCommandRequest(proposal);
    this.assertInputRunId(parsedProposal.runId, "MutationCommandRequest");
    this.assertMutationCommandPayloadHash(parsedProposal);

    const event = this.appendEvent(
      "ProposalReceived",
      { proposal: parsedProposal },
      this.withDefaultCausation(options),
    );
    this.#proposals.push(parsedProposal);
    return event;
  }

  recordEffectRequest(
    effectRequest: EffectRequest,
    options: KernelEventOptions = {},
  ): RunEvent<"EffectRequested"> {
    this.assertStarted();
    const parsedEffectRequest = parseEffectRequest(effectRequest);
    this.assertInputRunId(parsedEffectRequest.runId, "EffectRequest");

    const event = this.appendEvent(
      "EffectRequested",
      { effectRequest: parsedEffectRequest },
      this.withDefaultCausation(options),
    );
    this.#effectRequests.push(parsedEffectRequest);
    return event;
  }

  recordWritePreflightRequested(
    candidate: WritePreflightCandidate,
    options: KernelEventOptions = {},
  ): RunEvent<"WritePreflightRequested"> {
    this.assertStarted();
    const parsedCandidate = parseWritePreflightCandidate(candidate);
    this.assertInputRunId(parsedCandidate.runId, "WritePreflightCandidate");

    const event = this.appendEvent(
      "WritePreflightRequested",
      { candidate: parsedCandidate },
      this.withDefaultCausation(options),
    );
    this.#writePreflightCandidates.push(parsedCandidate);
    return event;
  }

  recordWritePreflightDecided(
    decision: WritePreflightDecision,
    options: KernelEventOptions = {},
  ): RunEvent<"WritePreflightDecided"> {
    this.assertStarted();
    const parsedDecision = parseWritePreflightDecision(decision);
    this.assertInputRunId(parsedDecision.runId, "WritePreflightDecision");
    this.assertWritePreflightDecisionMatchesRequest(parsedDecision);
    this.assertCriticalWriteApproval(parsedDecision);

    const event = this.appendEvent(
      "WritePreflightDecided",
      { decision: parsedDecision },
      this.withDefaultCausation(options),
    );
    this.#writePreflightDecisions.push(parsedDecision);
    return event;
  }

  recordWriteQuarantined(
    quarantine: WriteQuarantineState,
    options: KernelEventOptions = {},
  ): RunEvent<"WriteQuarantined"> {
    this.assertStarted();
    const parsedQuarantine = parseWriteQuarantineState(quarantine);
    this.assertInputRunId(parsedQuarantine.runId, "WriteQuarantineState");
    this.assertWriteQuarantineMatchesDecision(parsedQuarantine);

    const event = this.appendEvent(
      "WriteQuarantined",
      { quarantine: parsedQuarantine },
      this.withDefaultCausation(options),
    );
    this.#writeQuarantineStates.push(parsedQuarantine);
    return event;
  }

  recordApprovalRequested(
    request: ApprovalRequest,
    options: KernelEventOptions = {},
  ): RunEvent<"ApprovalRequested"> {
    this.assertStarted();
    const parsedRequest = parseApprovalRequest(request);
    this.assertInputRunId(parsedRequest.runId, "ApprovalRequest");

    const event = this.appendEvent(
      "ApprovalRequested",
      { request: parsedRequest },
      this.withDefaultCausation(options),
    );
    this.#approvalRequests.push(parsedRequest);
    return event;
  }

  recordApprovalGranted(
    grant: ApprovalGrant,
    options: KernelEventOptions = {},
  ): RunEvent<"ApprovalGranted"> {
    this.assertStarted();
    const parsedGrant = parseApprovalGrant(grant);
    this.assertInputRunId(parsedGrant.runId, "ApprovalGrant");
    this.assertApprovalMatchesRequest(parsedGrant);

    const event = this.appendEvent(
      "ApprovalGranted",
      { grant: parsedGrant },
      this.withDefaultCausation(options),
    );
    this.#approvalGrants.push(parsedGrant);
    return event;
  }

  recordApprovalDenied(
    denial: ApprovalDenial,
    options: KernelEventOptions = {},
  ): RunEvent<"ApprovalDenied"> {
    this.assertStarted();
    const parsedDenial = parseApprovalDenial(denial);
    this.assertInputRunId(parsedDenial.runId, "ApprovalDenial");
    this.assertApprovalMatchesRequest(parsedDenial);

    const event = this.appendEvent(
      "ApprovalDenied",
      { denial: parsedDenial },
      this.withDefaultCausation(options),
    );
    this.#approvalDenials.push(parsedDenial);
    return event;
  }

  recordApprovalExpired(
    expiry: ApprovalExpiry,
    options: KernelEventOptions = {},
  ): RunEvent<"ApprovalExpired"> {
    this.assertStarted();
    const parsedExpiry = parseApprovalExpiry(expiry);
    this.assertInputRunId(parsedExpiry.runId, "ApprovalExpiry");
    this.assertApprovalMatchesRequest(parsedExpiry);

    const event = this.appendEvent(
      "ApprovalExpired",
      { expiry: parsedExpiry },
      this.withDefaultCausation(options),
    );
    this.#approvalExpiries.push(parsedExpiry);
    return event;
  }

  commitMutation(
    command: MutationCommandRequest,
    options: KernelEventOptions = {},
  ): RunEvent<"MutationCommitted"> {
    this.assertStarted();
    const parsedCommand = parseMutationCommandRequest(command);
    this.assertInputRunId(parsedCommand.runId, "MutationCommandRequest");
    this.assertMutationCommandPayloadHash(parsedCommand);
    this.assertMutationWasProposed(parsedCommand);

    const currentRevision =
      this.#stateRevisions.get(parsedCommand.target.stateRef) ?? 0;
    if (currentRevision !== parsedCommand.precondition.expectedRevision) {
      throw new RunKernelError(
        "mutation_stale_revision",
        `Mutation ${parsedCommand.mutationId} expected revision ${String(
          parsedCommand.precondition.expectedRevision,
        )} for ${parsedCommand.target.stateRef}, but current revision is ${String(
          currentRevision,
        )}.`,
      );
    }

    const mutation: MutationCommitted = parseMutationCommitted({
      kind: "mutation_committed",
      mutationId: parsedCommand.mutationId,
      commandId: parsedCommand.commandId,
      runId: parsedCommand.runId,
      stateRef: parsedCommand.target.stateRef,
      previousRevision: currentRevision,
      newRevision: currentRevision + 1,
      operation: parsedCommand.operation,
      provenance: parsedCommand.provenance,
      committedAt: options.occurredAt ?? this.#clock(),
      payloadHash: canonicalObjectHash(
        mutationCommittedHashPayload({
          command: parsedCommand,
          previousRevision: currentRevision,
          newRevision: currentRevision + 1,
        }),
      ),
      ...(parsedCommand.metadata === undefined
        ? {}
        : { metadata: parsedCommand.metadata }),
    });

    const event = this.appendEvent(
      "MutationCommitted",
      { mutation },
      this.withDefaultCausation(options),
    );
    this.#mutations.push(mutation);
    this.#stateRevisions.set(mutation.stateRef, mutation.newRevision);
    return event;
  }

  recordEffectReceipt(
    receipt: EffectReceipt,
    options: KernelEventOptions = {},
  ): RunEvent<"EffectReceiptRecorded"> {
    this.assertStarted();
    const parsedReceipt = parseEffectReceipt(receipt);
    this.assertInputRunId(parsedReceipt.runId, "EffectReceipt");
    this.assertEffectRequestForReceipt(parsedReceipt);
    this.assertPayloadHash(
      "EffectReceipt",
      parsedReceipt.payload,
      parsedReceipt.payloadHash,
    );
    const eventId =
      options.eventId ?? this.nextEventId("EffectReceiptRecorded");
    this.assertAdmittedEvidenceRefs(
      parsedReceipt.evidence,
      eventId,
      "EffectReceipt",
      "effect_receipt",
      parsedReceipt.payloadHash,
    );

    const event = this.appendEvent(
      "EffectReceiptRecorded",
      { receipt: parsedReceipt },
      this.withDefaultCausation({
        ...options,
        eventId,
      }),
    );
    this.#effectReceipts.push(parsedReceipt);
    return event;
  }

  recordExternalStateObservation(
    observation: ExternalStateObservation,
    options: KernelEventOptions = {},
  ): RunEvent<"ExternalStateObserved"> {
    this.assertStarted();
    const parsedObservation = parseExternalStateObservation(observation);
    this.assertInputRunId(parsedObservation.runId, "ExternalStateObservation");
    this.assertPayloadHash(
      "ExternalStateObservation",
      parsedObservation.observedState,
      parsedObservation.payloadHash,
    );
    const eventId =
      options.eventId ?? this.nextEventId("ExternalStateObserved");
    this.assertAdmittedEvidenceRefs(
      parsedObservation.evidence,
      eventId,
      "ExternalStateObservation",
      "external_observation",
      parsedObservation.payloadHash,
    );

    const event = this.appendEvent(
      "ExternalStateObserved",
      { observation: parsedObservation },
      this.withDefaultCausation({
        ...options,
        eventId,
      }),
    );
    this.#externalStateObservations.push(parsedObservation);
    return event;
  }

  submitFinalCandidate(
    candidate: FinalCandidate,
    options: SubmitFinalCandidateOptions = {},
  ): SubmitFinalCandidateResult {
    this.assertStarted();
    const parsedCandidate = parseFinalCandidate(candidate);
    this.assertInputRunId(parsedCandidate.runId, "FinalCandidate");

    const proposalEvent = this.appendEvent(
      "ProposalReceived",
      { proposal: parsedCandidate },
      this.withDefaultCausation(options),
    );
    this.#proposals.push(parsedCandidate);

    const generatedAt = options.generatedAt ?? proposalEvent.occurredAt;
    const proof = parseProofObject(
      evaluateProof({
        candidate: parsedCandidate,
        effectReceipts: this.effectReceipts(),
        externalStateObservations: this.externalStateObservations(),
        generatedAt,
        ...(options.proofId === undefined ? {} : { proofId: options.proofId }),
      }),
    );

    const proofEvent = this.appendEvent(
      "ProofGenerated",
      { proof },
      kernelEventOptions({
        eventId: options.proofEventId,
        occurredAt: generatedAt,
        causationId: proposalEvent.eventId,
        correlationId: options.correlationId,
      }),
    );

    const mismatchEvents = proof.blockingMismatches.map((mismatch, index) => {
      const eventId = options.mismatchEventIds?.[index];
      if (options.mismatchEventIds !== undefined && eventId === undefined) {
        throw new RunKernelError(
          "insufficient_event_ids",
          "submitFinalCandidate received fewer mismatchEventIds than blocking mismatches.",
        );
      }

      return this.appendEvent(
        "MismatchDetected",
        { mismatch: parseMismatch(mismatch) },
        kernelEventOptions({
          eventId,
          occurredAt: generatedAt,
          causationId: proofEvent.eventId,
          correlationId: options.correlationId,
        }),
      );
    });

    const decision = parseReleaseDecision(
      decideRelease({
        candidate: parsedCandidate,
        proof,
      }),
    );

    const releaseEvent = this.appendEvent(
      "ReleaseDecided",
      { decision },
      kernelEventOptions({
        eventId: options.releaseEventId,
        occurredAt: generatedAt,
        causationId: proofEvent.eventId,
        correlationId: options.correlationId,
      }),
    );

    const finalReleasedEvent =
      decision.status === "released"
        ? this.appendEvent(
            "FinalReleased",
            { decision, candidate: parsedCandidate },
            kernelEventOptions({
              eventId: options.finalReleasedEventId,
              occurredAt: generatedAt,
              causationId: releaseEvent.eventId,
              correlationId: options.correlationId,
            }),
          )
        : undefined;

    return {
      candidate: parsedCandidate,
      proof,
      decision,
      proposalEvent,
      proofEvent,
      mismatchEvents,
      releaseEvent,
      ...(finalReleasedEvent === undefined ? {} : { finalReleasedEvent }),
      emittedEvents: [
        proposalEvent,
        proofEvent,
        ...mismatchEvents,
        releaseEvent,
        ...(finalReleasedEvent === undefined ? [] : [finalReleasedEvent]),
      ],
    };
  }

  effectRequests(): EffectRequest[] {
    return this.#effectRequests.map((effectRequest) =>
      parseEffectRequest(effectRequest),
    );
  }

  effectReceipts(): EffectReceipt[] {
    return this.#effectReceipts.map((receipt) => parseEffectReceipt(receipt));
  }

  externalStateObservations(): ExternalStateObservation[] {
    return this.#externalStateObservations.map((observation) =>
      parseExternalStateObservation(observation),
    );
  }

  mutations(): MutationCommitted[] {
    return this.#mutations.map((mutation) => parseMutationCommitted(mutation));
  }

  stateRevision(stateRef: string): number {
    return this.#stateRevisions.get(stateRef) ?? 0;
  }

  approvalRequests(): ApprovalRequest[] {
    return this.#approvalRequests.map((request) =>
      parseApprovalRequest(request),
    );
  }

  approvalGrants(): ApprovalGrant[] {
    return this.#approvalGrants.map((grant) => parseApprovalGrant(grant));
  }

  approvalDenials(): ApprovalDenial[] {
    return this.#approvalDenials.map((denial) => parseApprovalDenial(denial));
  }

  approvalExpiries(): ApprovalExpiry[] {
    return this.#approvalExpiries.map((expiry) => parseApprovalExpiry(expiry));
  }

  writePreflightCandidates(): WritePreflightCandidate[] {
    return this.#writePreflightCandidates.map((candidate) =>
      parseWritePreflightCandidate(candidate),
    );
  }

  writePreflightDecisions(): WritePreflightDecision[] {
    return this.#writePreflightDecisions.map((decision) =>
      parseWritePreflightDecision(decision),
    );
  }

  writeQuarantineStates(): WriteQuarantineState[] {
    return this.#writeQuarantineStates.map((quarantine) =>
      parseWriteQuarantineState(quarantine),
    );
  }

  proposals(): Proposal[] {
    return this.#proposals.map((proposal) =>
      proposal.kind === "tool_command_request"
        ? parseToolCommandRequest(proposal)
        : proposal.kind === "mutation_command_request"
          ? parseMutationCommandRequest(proposal)
          : parseFinalCandidate(proposal),
    );
  }

  events(): RunEvent[] {
    return this.ledger.events();
  }

  replay(): RunEvent[] {
    return this.ledger.replay();
  }

  private appendEvent<TType extends RunEventType>(
    type: TType,
    payload: RunEventPayloadByType[TType],
    options: KernelEventOptions,
  ): RunEvent<TType> {
    this.assertEventReferences(options);
    this.assertEventPayloadHash(type, payload, options.payloadHash);

    const event = this.ledger.append({
      eventId: options.eventId ?? this.nextEventId(type),
      runId: this.runId,
      type,
      payload,
      occurredAt: options.occurredAt ?? this.#clock(),
      ...(options.payloadHash === undefined
        ? {}
        : { payloadHash: options.payloadHash }),
      ...(options.causationId === undefined
        ? {}
        : { causationId: options.causationId }),
      ...(options.correlationId === undefined
        ? {}
        : { correlationId: options.correlationId }),
    });

    parseRunEvent(event);
    return event;
  }

  private withDefaultCausation(
    options: KernelEventOptions,
  ): KernelEventOptions {
    return {
      ...options,
      causationId:
        options.causationId === undefined
          ? (this.#startedEventId ?? null)
          : options.causationId,
    };
  }

  private nextEventId(type: RunEventType): string {
    const sequence = this.ledger.lastSequence + 1;
    return `evt_${sanitizeIdPart(this.runId)}_${String(sequence).padStart(
      4,
      "0",
    )}_${sanitizeIdPart(type)}`;
  }

  private assertStarted(): void {
    if (this.#startedEventId === undefined) {
      throw new RunKernelError(
        "run_not_started",
        `Run ${this.runId} must be started before appending semantic events.`,
      );
    }
  }

  private assertInputRunId(inputRunId: string, contractName: string): void {
    if (inputRunId !== this.runId) {
      throw new RunKernelError(
        "run_id_mismatch",
        `${contractName} runId ${inputRunId} does not match kernel runId ${this.runId}.`,
      );
    }
  }

  private assertEventReferences(options: KernelEventOptions): void {
    if (options.correlationId !== undefined && options.correlationId !== null) {
      if (options.correlationId.trim().length === 0) {
        throw new RunKernelError(
          "invalid_correlation_id",
          "RunEvent correlationId must be null or a non-empty string.",
        );
      }
    }

    if (options.causationId !== undefined && options.causationId !== null) {
      if (options.causationId.trim().length === 0) {
        throw new RunKernelError(
          "invalid_causation_id",
          "RunEvent causationId must be null or reference an earlier event.",
        );
      }

      const hasCausationEvent = this.ledger
        .events()
        .some((event) => event.eventId === options.causationId);

      if (!hasCausationEvent) {
        throw new RunKernelError(
          "invalid_causation_id",
          `RunEvent causationId ${options.causationId} does not reference an earlier event in run ${this.runId}.`,
        );
      }
    }
  }

  private assertEventPayloadHash<TType extends RunEventType>(
    type: TType,
    payload: RunEventPayloadByType[TType],
    expectedPayloadHash: Sha256Hash | undefined,
  ): void {
    if (expectedPayloadHash === undefined) {
      return;
    }

    const actualPayloadHash = canonicalObjectHash(
      payload as unknown as JsonObject,
    );

    if (expectedPayloadHash !== actualPayloadHash) {
      throw new RunKernelError(
        "payload_hash_mismatch",
        `${type} payloadHash ${expectedPayloadHash} does not match canonical event payload hash ${actualPayloadHash}.`,
      );
    }
  }

  private assertWritePreflightDecisionMatchesRequest(
    decision: WritePreflightDecision,
  ): void {
    const candidate = this.writePreflightCandidateById(decision.preflightId);

    if (candidate === undefined) {
      throw new RunKernelError(
        "write_preflight_request_not_found",
        `WritePreflightDecision ${decision.preflightId} cannot be recorded because no matching WritePreflightRequested event exists in run ${this.runId}.`,
      );
    }

    if (
      candidate.runId !== decision.runId ||
      candidate.commandId !== decision.commandId ||
      candidate.capabilityId !== decision.capabilityId ||
      candidate.toolId !== decision.toolId ||
      candidate.sideEffectClass !== decision.sideEffectClass ||
      candidate.idempotencyKey !== decision.idempotencyKey
    ) {
      throw new RunKernelError(
        "write_preflight_mismatch",
        `WritePreflightDecision ${decision.preflightId} does not match its recorded WritePreflightRequested candidate.`,
      );
    }

    if (
      decision.status === "quarantined" &&
      (decision.quarantine.runId !== decision.runId ||
        decision.quarantine.preflightId !== decision.preflightId ||
        decision.quarantine.commandId !== decision.commandId ||
        decision.quarantine.capabilityId !== decision.capabilityId ||
        decision.quarantine.toolId !== decision.toolId ||
        decision.quarantine.sideEffectClass !== decision.sideEffectClass ||
        decision.quarantine.idempotencyKey !== decision.idempotencyKey)
    ) {
      throw new RunKernelError(
        "write_quarantine_mismatch",
        `WritePreflightDecision ${decision.preflightId} embeds a quarantine state that does not match the decision identity.`,
      );
    }
  }

  private assertWriteQuarantineMatchesDecision(
    quarantine: WriteQuarantineState,
  ): void {
    const candidate = this.writePreflightCandidateById(quarantine.preflightId);

    if (candidate === undefined) {
      throw new RunKernelError(
        "write_preflight_request_not_found",
        `WriteQuarantineState ${quarantine.quarantineId} cannot be recorded because no matching WritePreflightRequested event exists in run ${this.runId}.`,
      );
    }

    if (
      candidate.runId !== quarantine.runId ||
      candidate.commandId !== quarantine.commandId ||
      candidate.capabilityId !== quarantine.capabilityId ||
      candidate.toolId !== quarantine.toolId ||
      candidate.sideEffectClass !== quarantine.sideEffectClass ||
      candidate.idempotencyKey !== quarantine.idempotencyKey
    ) {
      throw new RunKernelError(
        "write_quarantine_mismatch",
        `WriteQuarantineState ${quarantine.quarantineId} does not match its recorded WritePreflightRequested candidate.`,
      );
    }

    const decision = this.#writePreflightDecisions.find(
      (
        candidateDecision,
      ): candidateDecision is Extract<
        WritePreflightDecision,
        { status: "quarantined" }
      > =>
        candidateDecision.status === "quarantined" &&
        candidateDecision.preflightId === quarantine.preflightId &&
        candidateDecision.quarantine.quarantineId === quarantine.quarantineId,
    );

    if (decision === undefined) {
      throw new RunKernelError(
        "write_preflight_decision_not_found",
        `WriteQuarantineState ${quarantine.quarantineId} cannot be recorded because no matching quarantined WritePreflightDecided event exists in run ${this.runId}.`,
      );
    }

    if (
      canonicalObjectHash(decision.quarantine as unknown as JsonObject) !==
      canonicalObjectHash(quarantine as unknown as JsonObject)
    ) {
      throw new RunKernelError(
        "write_quarantine_mismatch",
        `WriteQuarantineState ${quarantine.quarantineId} does not match its recorded WritePreflightDecided quarantine payload.`,
      );
    }
  }

  private assertCriticalWriteApproval(decision: WritePreflightDecision): void {
    if (
      decision.status !== "allowed" ||
      decision.sideEffectClass !== "critical_write"
    ) {
      return;
    }

    if (decision.approvalId === undefined) {
      throw new RunKernelError(
        "approval_required",
        `Critical write preflight ${decision.preflightId} requires a scoped approval grant.`,
      );
    }

    const grant = this.#approvalGrants.find(
      (candidate) => candidate.approvalId === decision.approvalId,
    );
    if (grant === undefined) {
      throw new RunKernelError(
        "approval_required",
        `Critical write preflight ${decision.preflightId} references approval ${decision.approvalId}, but no grant exists in run ${this.runId}.`,
      );
    }

    if (
      !sameApprovalScope(grant.scope, writePreflightApprovalScope(decision))
    ) {
      throw new RunKernelError(
        "approval_scope_mismatch",
        `Approval ${decision.approvalId} is not scoped to critical write preflight ${decision.preflightId}.`,
      );
    }

    const denied = this.#approvalDenials.some(
      (denial) => denial.approvalId === decision.approvalId,
    );
    if (denied) {
      throw new RunKernelError(
        "approval_denied",
        `Approval ${decision.approvalId} was denied and cannot authorize critical write preflight ${decision.preflightId}.`,
      );
    }

    const explicitlyExpired = this.#approvalExpiries.some(
      (expiry) => expiry.approvalId === decision.approvalId,
    );
    if (
      explicitlyExpired ||
      Date.parse(decision.decidedAt) > Date.parse(grant.expiresAt)
    ) {
      throw new RunKernelError(
        "approval_expired",
        `Approval ${decision.approvalId} is expired and cannot authorize critical write preflight ${decision.preflightId}.`,
      );
    }
  }

  private assertApprovalMatchesRequest(
    approval: ApprovalGrant | ApprovalDenial | ApprovalExpiry,
  ): void {
    const request = this.#approvalRequests.find(
      (candidate) => candidate.approvalId === approval.approvalId,
    );

    if (request === undefined) {
      throw new RunKernelError(
        "approval_request_not_found",
        `Approval ${approval.approvalId} cannot be recorded because no matching ApprovalRequested event exists in run ${this.runId}.`,
      );
    }

    if (
      request.runId !== approval.runId ||
      !sameApprovalScope(request.scope, approval.scope)
    ) {
      throw new RunKernelError(
        "approval_scope_mismatch",
        `Approval ${approval.approvalId} scope does not match its recorded request.`,
      );
    }

    const effectiveAt =
      approval.kind === "approval_grant"
        ? approval.grantedAt
        : approval.kind === "approval_denial"
          ? approval.deniedAt
          : approval.expiredAt;

    if (
      approval.kind === "approval_grant" &&
      Date.parse(effectiveAt) > Date.parse(request.expiresAt)
    ) {
      throw new RunKernelError(
        "approval_expired",
        `Approval ${approval.approvalId} grant is after the request expiry.`,
      );
    }
  }

  private assertMutationWasProposed(command: MutationCommandRequest): void {
    const proposal = this.#proposals.find(
      (candidate): candidate is MutationCommandRequest =>
        candidate.kind === "mutation_command_request" &&
        candidate.commandId === command.commandId &&
        candidate.mutationId === command.mutationId,
    );

    if (proposal === undefined) {
      throw new RunKernelError(
        "mutation_proposal_not_found",
        `Mutation ${command.mutationId} cannot be committed because no matching MutationCommandRequest proposal exists in run ${this.runId}.`,
      );
    }

    if (
      canonicalObjectHash(proposal as unknown as JsonObject) !==
      canonicalObjectHash(command as unknown as JsonObject)
    ) {
      throw new RunKernelError(
        "mutation_hash_mismatch",
        `Mutation ${command.mutationId} does not match its recorded proposal.`,
      );
    }
  }

  private assertMutationCommandPayloadHash(
    command: MutationCommandRequest,
  ): void {
    const actualHash = canonicalObjectHash(mutationCommandHashPayload(command));

    if (command.payloadHash !== actualHash) {
      throw new RunKernelError(
        "mutation_hash_mismatch",
        `MutationCommandRequest ${command.mutationId} payloadHash ${command.payloadHash} does not match canonical mutation payload hash ${actualHash}.`,
      );
    }
  }

  private writePreflightCandidateById(
    preflightId: string,
  ): WritePreflightCandidate | undefined {
    return this.#writePreflightCandidates.find(
      (candidate) => candidate.preflightId === preflightId,
    );
  }

  private assertEffectRequestForReceipt(receipt: EffectReceipt): void {
    const effectRequest = this.#effectRequests.find(
      (request) => request.effectId === receipt.effectId,
    );

    if (effectRequest === undefined) {
      throw new RunKernelError(
        "effect_request_not_found",
        `EffectReceipt ${receipt.receiptId} cannot be recorded because effect ${receipt.effectId} was not requested in run ${this.runId}.`,
      );
    }

    if (effectRequest.capabilityId !== receipt.capabilityId) {
      throw new RunKernelError(
        "effect_request_mismatch",
        `EffectReceipt ${receipt.receiptId} capabilityId ${receipt.capabilityId} does not match requested capabilityId ${effectRequest.capabilityId}.`,
      );
    }
  }

  private assertPayloadHash(
    contractName: string,
    payload: JsonObject,
    payloadHash: string,
  ): void {
    const actualHash = canonicalObjectHash(payload);

    if (payloadHash !== actualHash) {
      throw new RunKernelError(
        "payload_hash_mismatch",
        `${contractName} payloadHash ${payloadHash} does not match canonical payload hash ${actualHash}.`,
      );
    }
  }

  private assertAdmittedEvidenceRefs(
    evidenceRefs: readonly EvidenceRef[],
    expectedSourceEventId: string,
    contractName: string,
    expectedKind: EvidenceRef["kind"],
    expectedHash: string,
  ): void {
    const mismatchedEvidence = evidenceRefs.find(
      (evidenceRef) => evidenceRef.sourceEventId !== expectedSourceEventId,
    );

    if (mismatchedEvidence !== undefined) {
      throw new RunKernelError(
        "evidence_source_event_mismatch",
        `${contractName} evidence ${mismatchedEvidence.evidenceId} sourceEventId ${mismatchedEvidence.sourceEventId} does not match admitting event ${expectedSourceEventId}.`,
      );
    }

    const kindMismatch = evidenceRefs.find(
      (evidenceRef) => evidenceRef.kind !== expectedKind,
    );

    if (kindMismatch !== undefined) {
      throw new RunKernelError(
        "evidence_kind_mismatch",
        `${contractName} evidence ${kindMismatch.evidenceId} kind ${kindMismatch.kind} does not match expected kind ${expectedKind}.`,
      );
    }

    const hashMismatch = evidenceRefs.find(
      (evidenceRef) => evidenceRef.hash !== expectedHash,
    );

    if (hashMismatch !== undefined) {
      throw new RunKernelError(
        "evidence_hash_mismatch",
        `${contractName} evidence ${hashMismatch.evidenceId} hash ${hashMismatch.hash} does not match admitted payload hash ${expectedHash}.`,
      );
    }
  }
}

export function runFinalCandidateThroughKernel(input: {
  readonly runId: string;
  readonly candidate: FinalCandidate;
  readonly effectRequests?: readonly EffectRequest[];
  readonly effectReceipts?: readonly EffectReceipt[];
  readonly externalStateObservations?: readonly ExternalStateObservation[];
  readonly occurredAt?: ISODateTimeString;
  readonly generatedAt?: ISODateTimeString;
  readonly profile?: string;
  readonly metadata?: JsonObject;
  readonly clock?: RunKernelClock;
}): SubmitFinalCandidateResult {
  const kernel = new InMemoryRunKernel({
    runId: input.runId,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  kernel.startRun(
    kernelEventOptions({
      occurredAt: input.occurredAt,
      profile: input.profile,
      metadata: input.metadata,
    }),
  );

  for (const effectRequest of input.effectRequests ?? []) {
    kernel.recordEffectRequest(effectRequest);
  }

  for (const receipt of input.effectReceipts ?? []) {
    kernel.recordEffectReceipt(
      receipt,
      kernelEventOptions({
        eventId: sourceEventIdForEvidence(receipt.evidence),
        occurredAt: receipt.observedAt,
      }),
    );
  }

  for (const observation of input.externalStateObservations ?? []) {
    kernel.recordExternalStateObservation(
      observation,
      kernelEventOptions({
        eventId: sourceEventIdForEvidence(observation.evidence),
        occurredAt: observation.observedAt,
      }),
    );
  }

  return kernel.submitFinalCandidate(
    input.candidate,
    kernelEventOptions({
      occurredAt: input.occurredAt,
      generatedAt: input.generatedAt,
    }),
  );
}

function systemClock(): ISODateTimeString {
  return new Date().toISOString();
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function sourceEventIdForEvidence(
  evidenceRefs: readonly EvidenceRef[],
): string | undefined {
  const sourceEventIds = new Set(
    evidenceRefs.map((evidenceRef) => evidenceRef.sourceEventId),
  );

  if (sourceEventIds.size === 1) {
    return evidenceRefs[0]?.sourceEventId;
  }

  return undefined;
}

function mutationCommandHashPayload(
  command: MutationCommandRequest,
): JsonObject {
  return {
    kind: command.kind,
    commandId: command.commandId,
    mutationId: command.mutationId,
    runId: command.runId,
    target: command.target as unknown as JsonObject,
    operation: command.operation as unknown as JsonObject,
    precondition: command.precondition as unknown as JsonObject,
    provenance: command.provenance as unknown as JsonObject,
    requestedAt: command.requestedAt,
    ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
  };
}

function mutationCommittedHashPayload(input: {
  readonly command: MutationCommandRequest;
  readonly previousRevision: number;
  readonly newRevision: number;
}): JsonObject {
  return {
    kind: "mutation_committed",
    mutationId: input.command.mutationId,
    commandId: input.command.commandId,
    runId: input.command.runId,
    stateRef: input.command.target.stateRef,
    previousRevision: input.previousRevision,
    newRevision: input.newRevision,
    operation: input.command.operation as unknown as JsonObject,
    provenance: input.command.provenance as unknown as JsonObject,
    ...(input.command.metadata === undefined
      ? {}
      : { metadata: input.command.metadata }),
  };
}

function writePreflightApprovalScope(
  decision: Extract<WritePreflightDecision, { status: "allowed" }>,
): ApprovalScope {
  return {
    kind: "write_preflight",
    preflightId: decision.preflightId,
    commandId: decision.commandId,
    capabilityId: decision.capabilityId,
    toolId: decision.toolId,
    sideEffectClass: decision.sideEffectClass,
    idempotencyKey: decision.idempotencyKey,
  };
}

function sameApprovalScope(left: ApprovalScope, right: ApprovalScope): boolean {
  return (
    canonicalObjectHash(left as unknown as JsonObject) ===
    canonicalObjectHash(right as unknown as JsonObject)
  );
}

function kernelEventOptions<TOptions extends KernelEventOptions>(options: {
  readonly [TKey in keyof TOptions]: TOptions[TKey] | undefined;
}): TOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as TOptions;
}
