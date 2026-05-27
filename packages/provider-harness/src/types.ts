import type {
  AdapterConformanceIssue,
  AdapterConformanceReport,
  SubstrateEmission,
} from "@amca/adapters-conformance";
import type {
  JsonObject,
  JsonValue,
  Proposal,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";

export type LocalProviderType = "openai-compatible";

export type ProviderHarnessFailureCode =
  | "provider_config_invalid"
  | "provider_fetch_failed"
  | "provider_invalid_json"
  | "provider_missing_content"
  | "provider_no_structured_candidate"
  | "provider_extra_authority_field"
  | "provider_metadata_evidence_ref_forbidden"
  | "provider_direct_tool_result_forbidden"
  | "provider_unsupported_proposal_kind"
  | "provider_tool_call_unknown"
  | "provider_tool_calls_unsupported"
  | "provider_contract_invalid";

export interface LocalProviderDiscoveryConfig {
  readonly enabled: boolean;
  readonly prefer: readonly string[];
  readonly timeoutMs: number;
}

export interface LocalProviderRequestConfig {
  readonly timeoutMs: number;
  readonly stream: boolean;
  readonly extraBody: JsonObject;
}

export interface LocalProviderCapabilities {
  readonly toolCalls: boolean;
  readonly parallelToolCalls: boolean;
  readonly systemMessages: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly maxContextTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export interface LocalProviderConfig {
  readonly provider: LocalProviderType;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  readonly apiKeyEnv?: string | undefined;
  readonly discovery: LocalProviderDiscoveryConfig;
  readonly request: LocalProviderRequestConfig;
  readonly capabilities: LocalProviderCapabilities;
}

export interface ProviderChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly toolCalls?: readonly ProviderToolCallCandidate[] | undefined;
}

export interface ProviderToolBinding {
  readonly name: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly description?: string | undefined;
  readonly inputJSONSchema?: JsonObject | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface ProviderToolCallCandidate {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ProviderChatRequest {
  readonly runId: string;
  readonly messages: readonly ProviderChatMessage[];
  readonly tools?: readonly ProviderToolBinding[] | undefined;
  readonly model?: string | undefined;
}

export interface ProviderRequestPreview {
  readonly url: string;
  readonly method: "POST";
  readonly headers: JsonObject;
  readonly body: JsonObject;
}

export interface ProviderNonProofMetadata {
  readonly provider: LocalProviderType;
  readonly model: string;
  readonly responseId?: string | undefined;
  readonly finishReason?: string | undefined;
  readonly usage?: JsonValue | undefined;
  readonly toolCallIds: readonly string[];
  readonly proofUsable: false;
}

export interface ProviderChatCompletion {
  readonly content: string;
  readonly toolCalls: readonly ProviderToolCallCandidate[];
  readonly metadata: ProviderNonProofMetadata;
}

export interface ProviderHarnessIssue {
  readonly code: ProviderHarnessFailureCode | AdapterConformanceIssue["code"];
  readonly message: string;
  readonly path?: readonly PropertyKey[] | undefined;
}

export type ProviderProposalResult =
  | {
      readonly status: "accepted";
      readonly proposalCandidates: readonly Proposal[];
      readonly toolCommandCandidates: readonly ToolCommandRequest[];
      readonly emissions: readonly SubstrateEmission[];
      readonly conformanceReport: AdapterConformanceReport;
      readonly metadata: ProviderNonProofMetadata;
    }
  | {
      readonly status: "blocked";
      readonly issues: readonly ProviderHarnessIssue[];
      readonly proposalCandidates: readonly Proposal[];
      readonly toolCommandCandidates: readonly ToolCommandRequest[];
      readonly emissions: readonly SubstrateEmission[];
      readonly conformanceReport?: AdapterConformanceReport | undefined;
      readonly metadata: ProviderNonProofMetadata;
    };

export class ProviderHarnessError extends Error {
  readonly code: ProviderHarnessFailureCode;

  constructor(code: ProviderHarnessFailureCode, message: string) {
    super(message);
    this.name = "ProviderHarnessError";
    this.code = code;
  }
}
