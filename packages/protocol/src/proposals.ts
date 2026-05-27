import type { Claim } from "./claims.js";
import type { EvidenceRef } from "./evidence.js";
import type { SideEffectClass } from "./effects.js";
import type { MutationCommandRequest } from "./mutations.js";
import type { JsonObject } from "./shared.js";

export type Proposal =
  | ToolCommandRequest
  | MutationCommandRequest
  | FinalCandidate;

export interface ToolCommandRequest {
  kind: "tool_command_request";
  commandId: string;
  runId: string;
  capabilityId: string;
  toolId: string;
  args: JsonObject;
  sideEffectClass: SideEffectClass;
  idempotencyKey?: string;
  requiredEvidence?: EvidenceRef[];
}

export interface FinalCandidate {
  kind: "final_candidate";
  candidateId: string;
  runId: string;
  claims: Claim[];
  narrativeDraft?: string;
}
