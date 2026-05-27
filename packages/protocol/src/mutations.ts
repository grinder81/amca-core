import type {
  ISODateTimeString,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from "./shared.js";

export type MutationOperation =
  | MutationSetOperation
  | MutationMergeOperation
  | MutationDeleteOperation;

export interface MutationSetOperation {
  kind: "set";
  path: string;
  value: JsonValue;
}

export interface MutationMergeOperation {
  kind: "merge";
  path: string;
  value: JsonObject;
}

export interface MutationDeleteOperation {
  kind: "delete";
  path: string;
}

export interface MutationTarget {
  stateRef: string;
}

export interface MutationPrecondition {
  expectedRevision: number;
}

export type MutationProvenanceKind =
  | "effect_receipt"
  | "external_observation"
  | "human_input"
  | "system_policy";

export interface MutationProvenance {
  kind: MutationProvenanceKind;
  sourceEventId: string;
  reason: string;
  actorId?: string;
  metadata?: JsonObject;
}

export interface MutationCommandRequest {
  kind: "mutation_command_request";
  commandId: string;
  mutationId: string;
  runId: string;
  target: MutationTarget;
  operation: MutationOperation;
  precondition: MutationPrecondition;
  provenance: MutationProvenance;
  requestedAt: ISODateTimeString;
  payloadHash: Sha256Hash;
  metadata?: JsonObject;
}

export interface MutationCommitted {
  kind: "mutation_committed";
  mutationId: string;
  commandId: string;
  runId: string;
  stateRef: string;
  previousRevision: number;
  newRevision: number;
  operation: MutationOperation;
  provenance: MutationProvenance;
  committedAt: ISODateTimeString;
  payloadHash: Sha256Hash;
  metadata?: JsonObject;
}
