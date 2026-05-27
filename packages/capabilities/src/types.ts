import type {
  ClaimType,
  CurrentStateOperator,
  EvidenceKind,
  HistoricalActionVerb,
  JsonObject,
  SideEffectClass,
} from "@amca/protocol";
import type { ProofRuleDescriptor } from "@amca/proof";

export type CapabilityContractVersion = 1;

export type CapabilityProfile = "light" | "standard" | "critical" | "regulated";

export type CapabilityId = string;

export type CapabilityJsonSchemaDocument = JsonObject & {
  readonly type: "object";
};

export interface EffectReceiptEvidenceDeclaration {
  readonly evidenceKind: "effect_receipt";
  readonly receiptType: string;
  readonly description?: string | undefined;
}

export interface ExternalObservationEvidenceDeclaration {
  readonly evidenceKind: "external_observation";
  readonly observationType: string;
  readonly description?: string | undefined;
}

export interface ArtifactEvidenceDeclaration {
  readonly evidenceKind: "artifact" | "test_output" | "ledger_event";
  readonly artifactType: string;
  readonly description?: string | undefined;
}

export type CapabilityEvidenceDeclaration =
  | ArtifactEvidenceDeclaration
  | EffectReceiptEvidenceDeclaration
  | ExternalObservationEvidenceDeclaration;

export interface HistoricalActionClaimSupport {
  readonly claimType: "historical_action";
  readonly predicateKind: "historical_action";
  readonly requiredReceiptType: string;
  readonly actionVerbs?: readonly HistoricalActionVerb[] | undefined;
  readonly subjectTypes?: readonly string[] | undefined;
  readonly targetTypes?: readonly string[] | undefined;
}

export interface TestResultClaimSupport {
  readonly claimType: "test_result";
  readonly predicateKind: "test_result";
  readonly requiredReceiptType: "test_run";
  readonly expectedStatuses?: readonly ("passed" | "failed")[] | undefined;
}

export interface CurrentStateClaimSupport {
  readonly claimType: "current_state";
  readonly predicateKind: "current_state";
  readonly observationType: string;
  readonly supportedOperators?: readonly CurrentStateOperator[] | undefined;
  readonly maximumFreshnessRequirementMs?: number | undefined;
}

export type SupportedClaimDeclaration =
  | CurrentStateClaimSupport
  | HistoricalActionClaimSupport
  | TestResultClaimSupport;

export interface CapabilityContract {
  readonly schemaVersion: CapabilityContractVersion;
  readonly capabilityId: CapabilityId;
  readonly profile: CapabilityProfile;
  readonly sideEffectClass: SideEffectClass;
  readonly inputSchema: CapabilityJsonSchemaDocument;
  readonly receiptSchema: CapabilityJsonSchemaDocument;
  readonly evidence: readonly CapabilityEvidenceDeclaration[];
  readonly supportedClaims: readonly SupportedClaimDeclaration[];
  readonly proofRules: readonly ProofRuleDescriptor[];
  readonly description?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export type CapabilitySupportedClaimType =
  SupportedClaimDeclaration["claimType"];

export type CapabilityDeclaredEvidenceKind =
  CapabilityEvidenceDeclaration["evidenceKind"];

export type CapabilityProofRuleClaimType = ClaimType;

export type CapabilityProofRuleEvidenceKind = EvidenceKind;
