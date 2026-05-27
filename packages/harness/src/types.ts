import type {
  DispatchEffectOptions,
  EffectDispatchResult,
  InMemoryEffectBrokerOptions,
} from "@amca/effect-broker";
import type {
  InMemoryRunKernel,
  KernelEventOptions,
  StartRunOptions,
  SubmitFinalCandidateOptions,
  SubmitFinalCandidateResult,
} from "@amca/kernel";
import type {
  EffectReceipt,
  ExternalStateObservation,
  FinalCandidate,
  ISODateTimeString,
  RunEvent,
  ToolCommandRequest,
} from "@amca/protocol";

export type LocalRunHarnessClock = () => ISODateTimeString;

export type LocalRunHarnessErrorCode = "run_id_mismatch";

export class LocalRunHarnessError extends Error {
  readonly code: LocalRunHarnessErrorCode;

  constructor(code: LocalRunHarnessErrorCode, message: string) {
    super(message);
    this.name = "LocalRunHarnessError";
    this.code = code;
  }
}

export interface LocalRunHarnessOptions {
  readonly runId: string;
  readonly clock?: LocalRunHarnessClock;
  readonly brokerOptions?: InMemoryEffectBrokerOptions;
  readonly broker?: InMemoryEffectBrokerLike;
  readonly kernel?: InMemoryRunKernel;
}

export type InMemoryEffectBrokerLike = {
  dispatch(
    command: ToolCommandRequest,
    options?: DispatchEffectOptions,
  ): Promise<EffectDispatchResult>;
};

export interface LocalRunHarnessDispatchOptions {
  readonly broker?: DispatchEffectOptions;
  readonly proposalEvent?: KernelEventOptions;
  readonly effectRequestEvent?: KernelEventOptions;
  readonly effectReceiptEvent?: KernelEventOptions;
  readonly externalStateObservationEvent?: KernelEventOptions;
}

export interface LocalRunHarnessDispatchResult {
  readonly status: EffectDispatchResult["status"];
  readonly brokerResult: EffectDispatchResult;
  readonly recordedReceipt: EffectReceipt;
  readonly recordedExternalStateObservation?: ExternalStateObservation;
  readonly proposalEvent: RunEvent<"ProposalReceived">;
  readonly effectRequestEvent: RunEvent<"EffectRequested">;
  readonly effectReceiptEvent: RunEvent<"EffectReceiptRecorded">;
  readonly externalStateObservationEvent?: RunEvent<"ExternalStateObserved">;
  readonly emittedEvents: readonly RunEvent[];
}

export interface LocalRunHarnessRunOptions {
  readonly dispatch?: LocalRunHarnessDispatchOptions;
  readonly finalCandidate?: SubmitFinalCandidateOptions;
}

export interface LocalRunHarnessRunInput {
  readonly toolCommand: ToolCommandRequest;
  readonly finalCandidate: FinalCandidate;
  readonly options?: LocalRunHarnessRunOptions;
}

export interface LocalRunHarnessRunResult {
  readonly dispatch: LocalRunHarnessDispatchResult;
  readonly finalCandidate: SubmitFinalCandidateResult;
  readonly emittedEvents: readonly RunEvent[];
}

export interface LocalRunHarnessReplayResult {
  readonly events: readonly RunEvent[];
}

export type LocalRunHarnessStartOptions = StartRunOptions;
