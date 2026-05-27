import type {
  EffectReceipt,
  FinalCandidate,
  JsonObject,
  Proposal,
  ProofObject,
  ReleaseDecision,
  ToolCommandRequest,
} from "@amca/protocol";

export type SubstrateKind =
  | "generic"
  | "langgraph"
  | "temporal"
  | "openai_agents"
  | "custom";

export type AdapterEmissionKind =
  | "proposal"
  | "tool_call"
  | "final_output"
  | "substrate_state"
  | "effect_receipt"
  | "proof_object"
  | "release_decision"
  | "raw_final_text";

export type AdapterConformanceIssueCode =
  | "run_id_mismatch"
  | "malformed_tool_command"
  | "malformed_final_candidate"
  | "raw_final_text_forbidden"
  | "direct_effect_receipt_forbidden"
  | "direct_proof_forbidden"
  | "direct_release_forbidden"
  | "substrate_state_as_truth_forbidden"
  | "final_candidate_without_claims"
  | "unsupported_proposal_kind"
  | "contract_identity_mismatch";

export interface AdapterBoundaryContract {
  readonly adapterId: string;
  readonly substrate: SubstrateKind;
  readonly runId: string;
  readonly canEmitToolCommandRequests: true;
  readonly canEmitFinalCandidates: true;
  readonly mustNotEmitEffectReceipts: true;
  readonly mustNotEmitReleaseDecisions: true;
  readonly mustNotTreatSubstrateStateAsEvidence: true;
}

export type SubstrateEmission =
  | ProposalEmission
  | ToolCallEmission
  | FinalOutputEmission
  | SubstrateStateEmission
  | EffectReceiptEmission
  | ProofObjectEmission
  | ReleaseDecisionEmission
  | RawFinalTextEmission;

export interface BaseSubstrateEmission {
  readonly emissionId: string;
  readonly adapterId: string;
  readonly substrate: SubstrateKind;
  readonly runId: string;
  readonly metadata?: JsonObject | undefined;
}

export interface ProposalEmission extends BaseSubstrateEmission {
  readonly kind: "proposal";
  readonly proposal: Proposal;
}

export interface ToolCallEmission extends BaseSubstrateEmission {
  readonly kind: "tool_call";
  readonly toolCommand: ToolCommandRequest;
}

export interface FinalOutputEmission extends BaseSubstrateEmission {
  readonly kind: "final_output";
  readonly finalCandidate: FinalCandidate;
}

export interface SubstrateStateEmission extends BaseSubstrateEmission {
  readonly kind: "substrate_state";
  readonly state: JsonObject;
  readonly usedAsEvidence?: boolean | undefined;
}

export interface EffectReceiptEmission extends BaseSubstrateEmission {
  readonly kind: "effect_receipt";
  readonly receipt: EffectReceipt;
}

export interface ProofObjectEmission extends BaseSubstrateEmission {
  readonly kind: "proof_object";
  readonly proof: ProofObject;
}

export interface ReleaseDecisionEmission extends BaseSubstrateEmission {
  readonly kind: "release_decision";
  readonly decision: ReleaseDecision;
}

export interface RawFinalTextEmission extends BaseSubstrateEmission {
  readonly kind: "raw_final_text";
  readonly text: string;
}

export interface ToolCallInterceptionContract {
  readonly adapterId: string;
  readonly substrate: SubstrateKind;
  readonly toolCommand: ToolCommandRequest;
}

export interface FinalCandidateConversionContract {
  readonly adapterId: string;
  readonly substrate: SubstrateKind;
  readonly finalCandidate: FinalCandidate;
}

export interface AdapterConformanceIssue {
  readonly code: AdapterConformanceIssueCode;
  readonly emissionId?: string | undefined;
  readonly message: string;
}

export interface AdapterConformanceReport {
  readonly adapterId: string;
  readonly substrate: SubstrateKind;
  readonly runId: string;
  readonly status: "pass" | "fail";
  readonly issues: readonly AdapterConformanceIssue[];
  readonly toolCommandCount: number;
  readonly finalCandidateCount: number;
}

export class AdapterConformanceError extends Error {
  readonly report: AdapterConformanceReport;

  constructor(report: AdapterConformanceReport) {
    super(`Adapter ${report.adapterId} failed AMCA conformance.`);
    this.name = "AdapterConformanceError";
    this.report = report;
  }
}
