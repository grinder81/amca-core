import type {
  ClaimType,
  CurrentStateOperator,
  EvidenceKind,
} from "@amca/protocol";

export type RuleDescriptorVersion = 1;

export type DescriptorLiteral = string | number | boolean | null;

export type EvidenceResolutionTarget =
  | "effect_receipt"
  | "external_state_observation"
  | "artifact"
  | "test_output"
  | "ledger_event";

export type ClaimPredicatePath =
  | "claim.predicate.actionVerb"
  | "claim.predicate.capabilityId"
  | "claim.predicate.expectedStatus"
  | "claim.predicate.expectedValue"
  | "claim.predicate.freshnessRequirementMs"
  | "claim.predicate.observationType"
  | "claim.predicate.operator"
  | "claim.predicate.property"
  | "claim.predicate.requiredReceiptType"
  | "claim.predicate.subjectId"
  | "claim.predicate.subjectType"
  | "claim.predicate.targetId"
  | "claim.predicate.targetType"
  | "claim.predicate.testSuiteId";

export type EffectReceiptPath =
  | "effectReceipt.capabilityId"
  | "effectReceipt.observedAt"
  | "effectReceipt.receiptType"
  | "effectReceipt.status"
  | `effectReceipt.payload.${string}`;

export type ExternalObservationPath =
  | "externalObservation.expiresAt"
  | "externalObservation.observationType"
  | "externalObservation.observedAt"
  | "externalObservation.subjectId"
  | "externalObservation.subjectType"
  | `externalObservation.observedState.${string}`;

export interface ClaimPredicateValueRef {
  readonly source: "claim_predicate";
  readonly path: ClaimPredicatePath;
}

export interface EffectReceiptValueRef {
  readonly source: "effect_receipt";
  readonly path: EffectReceiptPath;
}

export interface ExternalObservationValueRef {
  readonly source: "external_observation";
  readonly path: ExternalObservationPath;
}

export interface ExternalObservationDynamicValueRef {
  readonly source: "external_observation_dynamic";
  readonly root: "externalObservation.observedState";
  readonly pathFrom: "claim.predicate.property";
}

export interface LiteralValueRef {
  readonly source: "literal";
  readonly value: DescriptorLiteral;
}

export type MatchValueRef =
  | ClaimPredicateValueRef
  | EffectReceiptValueRef
  | ExternalObservationDynamicValueRef
  | ExternalObservationValueRef
  | LiteralValueRef;

export type MatchPresence = "always" | "when_claim_field_present";

export interface FieldEqualsMatchDescriptor {
  readonly kind: "field_equals";
  readonly left: MatchValueRef;
  readonly right: MatchValueRef;
  readonly presence: MatchPresence;
}

export interface FreshWithinMatchDescriptor {
  readonly kind: "fresh_within";
  readonly observedAt: ExternalObservationValueRef;
  readonly ttlMs: ClaimPredicateValueRef;
  readonly evaluatedAt: "proof.generatedAt";
}

export interface ObservedStateSatisfiesPredicateMatchDescriptor {
  readonly kind: "observed_state_satisfies_predicate";
  readonly observedValue: ExternalObservationDynamicValueRef;
  readonly operator: ClaimPredicateValueRef;
  readonly expectedValue: ClaimPredicateValueRef;
  readonly supportedOperators: readonly CurrentStateOperator[];
}

export type MatchClauseDescriptor =
  | FieldEqualsMatchDescriptor
  | FreshWithinMatchDescriptor
  | ObservedStateSatisfiesPredicateMatchDescriptor;

export interface MatchDescriptor {
  readonly operator: "all";
  readonly clauses: readonly MatchClauseDescriptor[];
}

export interface EvidenceRequirement {
  readonly requirementId: string;
  readonly evidenceKind: EvidenceKind;
  readonly source: "claim.evidenceRefs";
  readonly minimumCount: 1;
  readonly resolvesTo: EvidenceResolutionTarget;
}

export interface ProofRuleDescriptor {
  readonly ruleId: string;
  readonly version: RuleDescriptorVersion;
  readonly claimType: ClaimType;
  readonly predicateKind: ClaimType;
  readonly description: string;
  readonly evidence: readonly EvidenceRequirement[];
  readonly match: MatchDescriptor;
}
