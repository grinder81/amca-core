import type {
  ApprovalDenial,
  ApprovalExpiry,
  ApprovalGrant,
  ApprovalRequest,
} from "./approvals.js";
import type { ExternalStateObservation } from "./evidence.js";
import type {
  EffectRequest,
  EffectReceipt,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "./effects.js";
import type { Mismatch } from "./mismatch.js";
import type { MutationCommitted } from "./mutations.js";
import type { FinalCandidate, Proposal } from "./proposals.js";
import type { ProofObject } from "./proof.js";
import type { ReleaseDecision } from "./release.js";
import type {
  ISODateTimeString,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from "./shared.js";

export type RunEventType =
  | "RunStarted"
  | "ProposalReceived"
  | "EffectRequested"
  | "WritePreflightRequested"
  | "WritePreflightDecided"
  | "WriteQuarantined"
  | "MutationCommitted"
  | "ApprovalRequested"
  | "ApprovalGranted"
  | "ApprovalDenied"
  | "ApprovalExpired"
  | "EffectReceiptRecorded"
  | "ExternalStateObserved"
  | "ProofGenerated"
  | "MismatchDetected"
  | "ReleaseDecided"
  | "FinalReleased";

export interface RunStartedPayload {
  runId: string;
  profile?: string;
  metadata?: JsonObject;
}

export interface ProposalReceivedPayload {
  proposal: Proposal;
}

export interface EffectRequestedPayload {
  effectRequest: EffectRequest;
}

export interface WritePreflightRequestedPayload {
  candidate: WritePreflightCandidate;
}

export interface WritePreflightDecidedPayload {
  decision: WritePreflightDecision;
}

export interface WriteQuarantinedPayload {
  quarantine: WriteQuarantineState;
}

export interface MutationCommittedPayload {
  mutation: MutationCommitted;
}

export interface ApprovalRequestedPayload {
  request: ApprovalRequest;
}

export interface ApprovalGrantedPayload {
  grant: ApprovalGrant;
}

export interface ApprovalDeniedPayload {
  denial: ApprovalDenial;
}

export interface ApprovalExpiredPayload {
  expiry: ApprovalExpiry;
}

export interface EffectReceiptRecordedPayload {
  receipt: EffectReceipt;
}

export interface ExternalStateObservedPayload {
  observation: ExternalStateObservation;
}

export interface ProofGeneratedPayload {
  proof: ProofObject;
}

export interface MismatchDetectedPayload {
  mismatch: Mismatch;
}

export interface ReleaseDecidedPayload {
  decision: ReleaseDecision;
}

export interface FinalReleasedPayload {
  decision: Extract<ReleaseDecision, { status: "released" }>;
  candidate: FinalCandidate;
}

export type RunEventPayloadByType = {
  RunStarted: RunStartedPayload;
  ProposalReceived: ProposalReceivedPayload;
  EffectRequested: EffectRequestedPayload;
  WritePreflightRequested: WritePreflightRequestedPayload;
  WritePreflightDecided: WritePreflightDecidedPayload;
  WriteQuarantined: WriteQuarantinedPayload;
  MutationCommitted: MutationCommittedPayload;
  ApprovalRequested: ApprovalRequestedPayload;
  ApprovalGranted: ApprovalGrantedPayload;
  ApprovalDenied: ApprovalDeniedPayload;
  ApprovalExpired: ApprovalExpiredPayload;
  EffectReceiptRecorded: EffectReceiptRecordedPayload;
  ExternalStateObserved: ExternalStateObservedPayload;
  ProofGenerated: ProofGeneratedPayload;
  MismatchDetected: MismatchDetectedPayload;
  ReleaseDecided: ReleaseDecidedPayload;
  FinalReleased: FinalReleasedPayload;
};

export type RunEventPayload = RunEventPayloadByType[RunEventType];

export interface RunEvent<
  TType extends RunEventType = RunEventType,
  TPayload extends JsonValue | RunEventPayload = RunEventPayloadByType[TType],
> {
  eventId: string;
  runId: string;
  sequence: number;
  type: TType;
  payload: TPayload;
  payloadHash: Sha256Hash;
  causationId: string | null;
  correlationId: string | null;
  occurredAt: ISODateTimeString;
}
