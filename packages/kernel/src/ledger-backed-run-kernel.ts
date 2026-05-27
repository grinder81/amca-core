import type { SemanticLedger } from "@amca/ledger";
import type {
  ApprovalDenial,
  ApprovalExpiry,
  ApprovalGrant,
  ApprovalRequest,
  EffectReceipt,
  EffectRequest,
  ExternalStateObservation,
  FinalCandidate,
  JsonObject,
  MutationCommandRequest,
  MutationCommitted,
  Proposal,
  RunEvent,
  ToolCommandRequest,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";

import {
  InMemoryRunKernel,
  type InMemoryRunKernelOptions,
  type KernelEventOptions,
  RunKernelError,
  type RunKernelClock,
  type StartRunOptions,
  type SubmitFinalCandidateOptions,
  type SubmitFinalCandidateResult,
} from "./run-kernel.js";

export interface KernelEventSink {
  appendAcceptedEvent(event: RunEvent): Promise<void>;
}

export interface SemanticLedgerEventSinkOptions {
  readonly ledger: Pick<SemanticLedger, "appendAcceptedEventToRun">;
}

export function semanticLedgerEventSink(
  options: SemanticLedgerEventSinkOptions,
): KernelEventSink {
  return {
    async appendAcceptedEvent(event) {
      await options.ledger.appendAcceptedEventToRun(event.runId, event);
    },
  };
}

export interface LedgerBackedRunKernelOptions extends InMemoryRunKernelOptions {
  readonly eventSink: KernelEventSink;
}

export class LedgerBackedRunKernel {
  readonly runId: string;

  readonly #kernel: InMemoryRunKernel;
  readonly #eventSink: KernelEventSink;
  #appendFailure: RunKernelError | undefined;

  constructor(options: LedgerBackedRunKernelOptions) {
    this.#kernel = new InMemoryRunKernel({
      runId: options.runId,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.#eventSink = options.eventSink;
    this.runId = this.#kernel.runId;
  }

  async startRun(
    options: StartRunOptions = {},
  ): Promise<RunEvent<"RunStarted">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.startRun(options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async submitToolCommand(
    proposal: ToolCommandRequest,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"ProposalReceived">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.submitToolCommand(proposal, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordEffectRequest(
    effectRequest: EffectRequest,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"EffectRequested">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordEffectRequest(effectRequest, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordWritePreflightRequested(
    candidate: WritePreflightCandidate,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"WritePreflightRequested">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordWritePreflightRequested(
      candidate,
      options,
    );
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordWritePreflightDecided(
    decision: WritePreflightDecision,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"WritePreflightDecided">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordWritePreflightDecided(decision, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordWriteQuarantined(
    quarantine: WriteQuarantineState,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"WriteQuarantined">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordWriteQuarantined(quarantine, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordApprovalRequested(
    request: ApprovalRequest,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"ApprovalRequested">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordApprovalRequested(request, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordApprovalGranted(
    grant: ApprovalGrant,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"ApprovalGranted">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordApprovalGranted(grant, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordApprovalDenied(
    denial: ApprovalDenial,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"ApprovalDenied">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordApprovalDenied(denial, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordApprovalExpired(
    expiry: ApprovalExpiry,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"ApprovalExpired">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordApprovalExpired(expiry, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async submitMutationCommand(
    proposal: MutationCommandRequest,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"ProposalReceived">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.submitMutationCommand(proposal, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async commitMutation(
    command: MutationCommandRequest,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"MutationCommitted">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.commitMutation(command, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordEffectReceipt(
    receipt: EffectReceipt,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"EffectReceiptRecorded">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordEffectReceipt(receipt, options);
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async recordExternalStateObservation(
    observation: ExternalStateObservation,
    options: KernelEventOptions = {},
  ): Promise<RunEvent<"ExternalStateObserved">> {
    this.assertLedgerBackedPathOpen();
    const event = this.#kernel.recordExternalStateObservation(
      observation,
      options,
    );
    await this.persistAcceptedEvents([event]);
    return event;
  }

  async submitFinalCandidate(
    candidate: FinalCandidate,
    options: SubmitFinalCandidateOptions = {},
  ): Promise<SubmitFinalCandidateResult> {
    this.assertLedgerBackedPathOpen();
    const result = this.#kernel.submitFinalCandidate(candidate, options);
    await this.persistAcceptedEvents(result.emittedEvents);
    return result;
  }

  effectRequests(): EffectRequest[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.effectRequests();
  }

  effectReceipts(): EffectReceipt[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.effectReceipts();
  }

  externalStateObservations(): ExternalStateObservation[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.externalStateObservations();
  }

  mutations(): MutationCommitted[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.mutations();
  }

  stateRevision(stateRef: string): number {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.stateRevision(stateRef);
  }

  approvalRequests(): ApprovalRequest[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.approvalRequests();
  }

  approvalGrants(): ApprovalGrant[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.approvalGrants();
  }

  approvalDenials(): ApprovalDenial[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.approvalDenials();
  }

  approvalExpiries(): ApprovalExpiry[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.approvalExpiries();
  }

  writePreflightCandidates(): WritePreflightCandidate[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.writePreflightCandidates();
  }

  writePreflightDecisions(): WritePreflightDecision[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.writePreflightDecisions();
  }

  writeQuarantineStates(): WriteQuarantineState[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.writeQuarantineStates();
  }

  proposals(): Proposal[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.proposals();
  }

  events(): RunEvent[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.events();
  }

  replay(): RunEvent[] {
    this.assertLedgerBackedPathOpen();
    return this.#kernel.replay();
  }

  private async persistAcceptedEvents(
    events: readonly RunEvent[],
  ): Promise<void> {
    for (const event of events) {
      try {
        await this.#eventSink.appendAcceptedEvent(event);
      } catch (error) {
        this.#appendFailure = new RunKernelError(
          "ledger_append_failed",
          `Semantic ledger append failed for event ${event.eventId}: ${errorMessage(
            error,
          )}`,
        );
        throw this.#appendFailure;
      }
    }
  }

  private assertLedgerBackedPathOpen(): void {
    if (this.#appendFailure !== undefined) {
      throw this.#appendFailure;
    }
  }
}

export async function runFinalCandidateThroughLedgerBackedKernel(input: {
  readonly runId: string;
  readonly eventSink: KernelEventSink;
  readonly candidate: FinalCandidate;
  readonly effectRequests?: readonly EffectRequest[];
  readonly effectReceipts?: readonly EffectReceipt[];
  readonly externalStateObservations?: readonly ExternalStateObservation[];
  readonly occurredAt?: string;
  readonly generatedAt?: string;
  readonly profile?: string;
  readonly metadata?: JsonObject;
  readonly clock?: RunKernelClock;
}): Promise<SubmitFinalCandidateResult> {
  const kernel = new LedgerBackedRunKernel({
    runId: input.runId,
    eventSink: input.eventSink,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  await kernel.startRun({
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });

  for (const effectRequest of input.effectRequests ?? []) {
    await kernel.recordEffectRequest(effectRequest);
  }

  for (const receipt of input.effectReceipts ?? []) {
    await kernel.recordEffectReceipt(receipt, {
      ...optionalEventId(sourceEventIdForEvidence(receipt.evidence)),
      occurredAt: receipt.observedAt,
    });
  }

  for (const observation of input.externalStateObservations ?? []) {
    await kernel.recordExternalStateObservation(observation, {
      ...optionalEventId(sourceEventIdForEvidence(observation.evidence)),
      occurredAt: observation.observedAt,
    });
  }

  return kernel.submitFinalCandidate(input.candidate, {
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.generatedAt === undefined
      ? {}
      : { generatedAt: input.generatedAt }),
  });
}

function sourceEventIdForEvidence(
  evidenceRefs: readonly { readonly sourceEventId: string }[],
): string | undefined {
  const sourceEventIds = new Set(
    evidenceRefs.map((evidenceRef) => evidenceRef.sourceEventId),
  );

  if (sourceEventIds.size === 1) {
    return evidenceRefs[0]?.sourceEventId;
  }

  return undefined;
}

function optionalEventId(eventId: string | undefined): KernelEventOptions {
  return eventId === undefined ? {} : { eventId };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}
