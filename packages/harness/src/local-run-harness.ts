import {
  parseEffectReceipt,
  parseExternalStateObservation,
  parseExternalStateObservationCandidate,
  parseReceiptCandidate,
} from "@amca/contracts";
import { InMemoryEffectBroker } from "@amca/effect-broker";
import {
  InMemoryRunKernel,
  type KernelEventOptions,
  type SubmitFinalCandidateOptions,
  type SubmitFinalCandidateResult,
} from "@amca/kernel";
import type {
  EffectReceipt,
  EvidenceRef,
  ExternalStateObservation,
  ExternalStateObservationCandidate,
  FinalCandidate,
  PendingEvidenceRef,
  ReceiptCandidate,
  RunEvent,
} from "@amca/protocol";

import type {
  InMemoryEffectBrokerLike,
  LocalRunHarnessDispatchOptions,
  LocalRunHarnessDispatchResult,
  LocalRunHarnessOptions,
  LocalRunHarnessReplayResult,
  LocalRunHarnessRunInput,
  LocalRunHarnessRunResult,
  LocalRunHarnessStartOptions,
} from "./types.js";
import { LocalRunHarnessError } from "./types.js";

interface RecordedEffectEvents {
  readonly effectRequestEvent: RunEvent<"EffectRequested">;
  readonly effectReceiptEvent: RunEvent<"EffectReceiptRecorded">;
  readonly recordedReceipt: EffectReceipt;
  readonly externalStateObservationEvent?: RunEvent<"ExternalStateObserved">;
  readonly recordedExternalStateObservation?: ExternalStateObservation;
}

export class LocalRunHarness {
  readonly runId: string;
  readonly broker: InMemoryEffectBrokerLike;
  readonly kernel: InMemoryRunKernel;

  readonly #recordedEffectsByEffectId = new Map<string, RecordedEffectEvents>();

  constructor(options: LocalRunHarnessOptions) {
    this.runId = options.runId;
    this.kernel =
      options.kernel ??
      new InMemoryRunKernel({
        runId: options.runId,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });

    if (this.kernel.runId !== options.runId) {
      throw new LocalRunHarnessError(
        "run_id_mismatch",
        `Harness runId ${options.runId} does not match kernel runId ${this.kernel.runId}.`,
      );
    }

    this.broker =
      options.broker ??
      new InMemoryEffectBroker(
        brokerOptionsWithClock(options.brokerOptions, options.clock),
      );
  }

  startRun(options: LocalRunHarnessStartOptions = {}): RunEvent<"RunStarted"> {
    return this.kernel.startRun(options);
  }

  async dispatchToolCommand(
    toolCommand: LocalRunHarnessRunInput["toolCommand"],
    options: LocalRunHarnessDispatchOptions = {},
  ): Promise<LocalRunHarnessDispatchResult> {
    const proposalEvent = this.kernel.submitToolCommand(
      toolCommand,
      options.proposalEvent,
    );
    const brokerResult = await this.broker.dispatch(
      toolCommand,
      options.broker,
    );

    const recordedEffect = this.#recordEffectLifecycle({
      proposalEvent,
      brokerResult,
      options,
    });

    return {
      status: brokerResult.status,
      brokerResult,
      recordedReceipt: recordedEffect.recordedReceipt,
      ...(recordedEffect.recordedExternalStateObservation === undefined
        ? {}
        : {
            recordedExternalStateObservation:
              recordedEffect.recordedExternalStateObservation,
          }),
      proposalEvent,
      effectRequestEvent: recordedEffect.effectRequestEvent,
      effectReceiptEvent: recordedEffect.effectReceiptEvent,
      ...(recordedEffect.externalStateObservationEvent === undefined
        ? {}
        : {
            externalStateObservationEvent:
              recordedEffect.externalStateObservationEvent,
          }),
      emittedEvents:
        brokerResult.status === "cached"
          ? [proposalEvent]
          : [
              proposalEvent,
              recordedEffect.effectRequestEvent,
              recordedEffect.effectReceiptEvent,
              ...(recordedEffect.externalStateObservationEvent === undefined
                ? []
                : [recordedEffect.externalStateObservationEvent]),
            ],
    };
  }

  async runToRelease(
    input: LocalRunHarnessRunInput,
  ): Promise<LocalRunHarnessRunResult> {
    const dispatch = await this.dispatchToolCommand(
      input.toolCommand,
      input.options?.dispatch,
    );
    const finalCandidate = this.submitFinalCandidate(
      input.finalCandidate,
      mergeSubmitFinalCandidateOptions(
        {
          causationId:
            dispatch.externalStateObservationEvent?.eventId ??
            dispatch.effectReceiptEvent.eventId,
          correlationId:
            dispatch.externalStateObservationEvent?.correlationId ??
            dispatch.effectReceiptEvent.correlationId,
        },
        input.options?.finalCandidate,
      ),
    );

    return {
      dispatch,
      finalCandidate,
      emittedEvents: [
        ...dispatch.emittedEvents,
        ...finalCandidate.emittedEvents,
      ],
    };
  }

  submitFinalCandidate(
    finalCandidate: FinalCandidate,
    options: SubmitFinalCandidateOptions = {},
  ): SubmitFinalCandidateResult {
    return this.kernel.submitFinalCandidate(finalCandidate, options);
  }

  reevaluateFinalCandidate(
    finalCandidate: FinalCandidate,
    options: SubmitFinalCandidateOptions = {},
  ): SubmitFinalCandidateResult {
    return this.submitFinalCandidate(finalCandidate, options);
  }

  replay(): LocalRunHarnessReplayResult {
    return {
      events: this.kernel.replay(),
    };
  }

  #recordEffectLifecycle(input: {
    readonly proposalEvent: RunEvent<"ProposalReceived">;
    readonly brokerResult: LocalRunHarnessDispatchResult["brokerResult"];
    readonly options: LocalRunHarnessDispatchOptions;
  }): RecordedEffectEvents {
    const cachedEffect = this.#recordedEffectsByEffectId.get(
      input.brokerResult.effectRequest.effectId,
    );

    if (input.brokerResult.status === "cached" && cachedEffect !== undefined) {
      return cachedEffect;
    }

    const effectRequestEvent = this.kernel.recordEffectRequest(
      input.brokerResult.effectRequest,
      mergeKernelEventOptions(
        {
          causationId: input.proposalEvent.eventId,
          correlationId: input.proposalEvent.correlationId,
          occurredAt: input.brokerResult.effectRequest.requestedAt,
        },
        input.options.effectRequestEvent,
      ),
    );
    const receiptEventId =
      input.options.effectReceiptEvent?.eventId ??
      receiptEventIdForCommand(input.brokerResult.effectRequest.commandId);
    const receiptEventOptions = mergeKernelEventOptions(
      {
        eventId: receiptEventId,
        causationId: effectRequestEvent.eventId,
        correlationId: effectRequestEvent.correlationId,
        occurredAt: input.brokerResult.receiptCandidate.observedAt,
      },
      input.options.effectReceiptEvent,
    );
    const admittedReceipt = admitReceiptEvidence(
      input.brokerResult.receiptCandidate,
      receiptEventId,
    );
    const effectReceiptEvent = this.kernel.recordEffectReceipt(
      admittedReceipt,
      receiptEventOptions,
    );
    const observationEvent =
      input.brokerResult.externalStateObservationCandidate === undefined
        ? undefined
        : this.#recordExternalStateObservation({
            effectReceiptEvent,
            observation: input.brokerResult.externalStateObservationCandidate,
            options: input.options,
            commandId: input.brokerResult.effectRequest.commandId,
          });

    const recordedEffect = {
      effectRequestEvent,
      effectReceiptEvent,
      recordedReceipt: admittedReceipt,
      ...(observationEvent === undefined
        ? {}
        : {
            externalStateObservationEvent: observationEvent.event,
            recordedExternalStateObservation: observationEvent.observation,
          }),
    };
    this.#recordedEffectsByEffectId.set(
      input.brokerResult.effectRequest.effectId,
      recordedEffect,
    );
    return recordedEffect;
  }

  #recordExternalStateObservation(input: {
    readonly commandId: string;
    readonly effectReceiptEvent: RunEvent<"EffectReceiptRecorded">;
    readonly observation: ExternalStateObservationCandidate;
    readonly options: LocalRunHarnessDispatchOptions;
  }): {
    readonly event: RunEvent<"ExternalStateObserved">;
    readonly observation: ExternalStateObservation;
  } {
    const observationEventId =
      input.options.externalStateObservationEvent?.eventId ??
      observationEventIdForCommand(input.commandId);
    const observationEventOptions = mergeKernelEventOptions(
      {
        eventId: observationEventId,
        causationId: input.effectReceiptEvent.eventId,
        correlationId: input.effectReceiptEvent.correlationId,
        occurredAt: input.observation.observedAt,
      },
      input.options.externalStateObservationEvent,
    );
    const admittedObservation = admitObservationEvidence(
      input.observation,
      observationEventId,
    );
    const externalStateObservationEvent =
      this.kernel.recordExternalStateObservation(
        admittedObservation,
        observationEventOptions,
      );

    return {
      event: externalStateObservationEvent,
      observation: admittedObservation,
    };
  }
}

function admitReceiptEvidence(
  receipt: ReceiptCandidate,
  sourceEventId: string,
): EffectReceipt {
  const parsedReceipt = parseReceiptCandidate(receipt);
  return parseEffectReceipt({
    ...parsedReceipt,
    evidence: parsedReceipt.evidence.map((evidenceRef) =>
      admitEvidenceRef(evidenceRef, sourceEventId),
    ),
  });
}

function admitObservationEvidence(
  observation: ExternalStateObservationCandidate,
  sourceEventId: string,
): ExternalStateObservation {
  const parsedObservation = parseExternalStateObservationCandidate(observation);
  return parseExternalStateObservation({
    ...parsedObservation,
    evidence: parsedObservation.evidence.map((evidenceRef) =>
      admitEvidenceRef(evidenceRef, sourceEventId),
    ),
  });
}

function admitEvidenceRef(
  evidenceRef: PendingEvidenceRef,
  sourceEventId: string,
): EvidenceRef {
  const { admissionStatus, pendingAdmissionToken, ...admitted } = evidenceRef;
  void admissionStatus;
  void pendingAdmissionToken;
  return {
    ...admitted,
    admissionStatus: "admitted",
    sourceEventId,
  };
}

function receiptEventIdForCommand(commandId: string): string {
  return `evt_${sanitizeId(commandId)}_receipt_recorded`;
}

function observationEventIdForCommand(commandId: string): string {
  return `evt_${sanitizeId(commandId)}_external_state_observed`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function mergeKernelEventOptions(
  defaults: KernelEventOptions,
  overrides: KernelEventOptions | undefined,
): KernelEventOptions {
  return kernelEventOptions({
    eventId: overrides?.eventId ?? defaults.eventId,
    occurredAt: overrides?.occurredAt ?? defaults.occurredAt,
    causationId: overrides?.causationId ?? defaults.causationId,
    correlationId: overrides?.correlationId ?? defaults.correlationId,
  });
}

function mergeSubmitFinalCandidateOptions(
  defaults: SubmitFinalCandidateOptions,
  overrides: SubmitFinalCandidateOptions | undefined,
): SubmitFinalCandidateOptions {
  return submitFinalCandidateOptions({
    ...overrides,
    causationId: overrides?.causationId ?? defaults.causationId,
    correlationId: overrides?.correlationId ?? defaults.correlationId,
  });
}

function kernelEventOptions(input: {
  readonly eventId?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly causationId?: string | null | undefined;
  readonly correlationId?: string | null | undefined;
}): KernelEventOptions {
  return {
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.causationId === undefined
      ? {}
      : { causationId: input.causationId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
  };
}

function submitFinalCandidateOptions(options: {
  readonly eventId?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly causationId?: string | null | undefined;
  readonly correlationId?: string | null | undefined;
  readonly generatedAt?: string | undefined;
  readonly proofEventId?: string | undefined;
  readonly proofId?: string | undefined;
  readonly mismatchEventIds?: readonly string[] | undefined;
  readonly releaseEventId?: string | undefined;
  readonly finalReleasedEventId?: string | undefined;
}): SubmitFinalCandidateOptions {
  return {
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.occurredAt === undefined
      ? {}
      : { occurredAt: options.occurredAt }),
    ...(options.causationId === undefined
      ? {}
      : { causationId: options.causationId }),
    ...(options.correlationId === undefined
      ? {}
      : { correlationId: options.correlationId }),
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
    ...(options.proofEventId === undefined
      ? {}
      : { proofEventId: options.proofEventId }),
    ...(options.proofId === undefined ? {} : { proofId: options.proofId }),
    ...(options.mismatchEventIds === undefined
      ? {}
      : { mismatchEventIds: options.mismatchEventIds }),
    ...(options.releaseEventId === undefined
      ? {}
      : { releaseEventId: options.releaseEventId }),
    ...(options.finalReleasedEventId === undefined
      ? {}
      : { finalReleasedEventId: options.finalReleasedEventId }),
  };
}

function brokerOptionsWithClock(
  options: LocalRunHarnessOptions["brokerOptions"],
  clock: LocalRunHarnessOptions["clock"],
): NonNullable<LocalRunHarnessOptions["brokerOptions"]> {
  return {
    ...(options?.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
    ...(options?.adapters === undefined ? {} : { adapters: options.adapters }),
    ...(options?.allowedAdapterKinds === undefined
      ? {}
      : { allowedAdapterKinds: options.allowedAdapterKinds }),
    ...(options?.clock === undefined
      ? clock === undefined
        ? {}
        : { clock }
      : { clock: options.clock }),
  };
}
