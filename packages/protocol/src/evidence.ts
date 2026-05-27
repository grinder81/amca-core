import type { ISODateTimeString, JsonObject, Sha256Hash } from "./shared.js";

export type EvidenceKind =
  | "effect_receipt"
  | "external_observation"
  | "artifact"
  | "test_output"
  | "ledger_event";

export type EvidenceSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type EvidenceAdmissionStatus = "pending" | "admitted";

export interface PendingEvidenceRef {
  admissionStatus: "pending";
  pendingAdmissionToken: string;
  evidenceId: string;
  kind: EvidenceKind;
  hash: Sha256Hash;
  observedAt: ISODateTimeString;
  sensitivity: EvidenceSensitivity;
  artifactUri?: string;
  expiresAt?: ISODateTimeString;
  metadata?: JsonObject;
}

export interface AdmittedEvidenceRef {
  admissionStatus?: "admitted";
  evidenceId: string;
  kind: EvidenceKind;
  sourceEventId: string;
  hash: Sha256Hash;
  observedAt: ISODateTimeString;
  sensitivity: EvidenceSensitivity;
  artifactUri?: string;
  expiresAt?: ISODateTimeString;
  metadata?: JsonObject;
}

export interface EvidenceRef extends AdmittedEvidenceRef {}

export interface ExternalStateObservation {
  observationId: string;
  runId: string;
  observationType: string;
  subjectType: string;
  subjectId: string;
  observedState: JsonObject;
  observedAt: ISODateTimeString;
  expiresAt: ISODateTimeString;
  payloadHash: Sha256Hash;
  evidence: EvidenceRef[];
}

export interface ExternalStateObservationCandidate {
  observationId: string;
  runId: string;
  observationType: string;
  subjectType: string;
  subjectId: string;
  observedState: JsonObject;
  observedAt: ISODateTimeString;
  expiresAt: ISODateTimeString;
  payloadHash: Sha256Hash;
  evidence: PendingEvidenceRef[];
}
