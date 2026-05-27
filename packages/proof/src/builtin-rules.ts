import type { ClaimType } from "@amca/protocol";

import type { ProofRuleDescriptor } from "./rule-descriptor.js";

const succeededReceipt = {
  source: "literal",
  value: "succeeded",
} as const;

export const HISTORICAL_ACTION_PROOF_RULE = {
  ruleId: "amca.v0.proof.historical_action",
  version: 1,
  claimType: "historical_action",
  predicateKind: "historical_action",
  description:
    "A historical action claim is supported by a matching successful effect receipt.",
  evidence: [
    {
      requirementId: "historical_action.effect_receipt",
      evidenceKind: "effect_receipt",
      source: "claim.evidenceRefs",
      minimumCount: 1,
      resolvesTo: "effect_receipt",
    },
  ],
  match: {
    operator: "all",
    clauses: [
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.receiptType",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.requiredReceiptType",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.status",
        },
        right: succeededReceipt,
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.capabilityId",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.capabilityId",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.payload.actionVerb",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.actionVerb",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.payload.subjectType",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.subjectType",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.payload.targetType",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.targetType",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.payload.subjectId",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.subjectId",
        },
        presence: "when_claim_field_present",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.payload.targetId",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.targetId",
        },
        presence: "when_claim_field_present",
      },
    ],
  },
} as const satisfies ProofRuleDescriptor;

export const TEST_RESULT_PROOF_RULE = {
  ruleId: "amca.v0.proof.test_result",
  version: 1,
  claimType: "test_result",
  predicateKind: "test_result",
  description:
    "A test-result claim is supported by a matching successful test-run receipt.",
  evidence: [
    {
      requirementId: "test_result.effect_receipt",
      evidenceKind: "effect_receipt",
      source: "claim.evidenceRefs",
      minimumCount: 1,
      resolvesTo: "effect_receipt",
    },
  ],
  match: {
    operator: "all",
    clauses: [
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.receiptType",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.requiredReceiptType",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.status",
        },
        right: succeededReceipt,
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.capabilityId",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.capabilityId",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.payload.result",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.expectedStatus",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "effect_receipt",
          path: "effectReceipt.payload.testSuiteId",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.testSuiteId",
        },
        presence: "when_claim_field_present",
      },
    ],
  },
} as const satisfies ProofRuleDescriptor;

export const CURRENT_STATE_PROOF_RULE = {
  ruleId: "amca.v0.proof.current_state",
  version: 1,
  claimType: "current_state",
  predicateKind: "current_state",
  description:
    "A current-state claim is supported by a matching fresh external observation.",
  evidence: [
    {
      requirementId: "current_state.external_observation",
      evidenceKind: "external_observation",
      source: "claim.evidenceRefs",
      minimumCount: 1,
      resolvesTo: "external_state_observation",
    },
  ],
  match: {
    operator: "all",
    clauses: [
      {
        kind: "field_equals",
        left: {
          source: "external_observation",
          path: "externalObservation.observationType",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.observationType",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "external_observation",
          path: "externalObservation.subjectType",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.subjectType",
        },
        presence: "always",
      },
      {
        kind: "field_equals",
        left: {
          source: "external_observation",
          path: "externalObservation.subjectId",
        },
        right: {
          source: "claim_predicate",
          path: "claim.predicate.subjectId",
        },
        presence: "always",
      },
      {
        kind: "fresh_within",
        observedAt: {
          source: "external_observation",
          path: "externalObservation.observedAt",
        },
        ttlMs: {
          source: "claim_predicate",
          path: "claim.predicate.freshnessRequirementMs",
        },
        evaluatedAt: "proof.generatedAt",
      },
      {
        kind: "observed_state_satisfies_predicate",
        observedValue: {
          source: "external_observation_dynamic",
          root: "externalObservation.observedState",
          pathFrom: "claim.predicate.property",
        },
        operator: {
          source: "claim_predicate",
          path: "claim.predicate.operator",
        },
        expectedValue: {
          source: "claim_predicate",
          path: "claim.predicate.expectedValue",
        },
        supportedOperators: ["equals", "not_equals", "contains"],
      },
    ],
  },
} as const satisfies ProofRuleDescriptor;

export const BUILTIN_PROOF_RULE_DESCRIPTORS = [
  HISTORICAL_ACTION_PROOF_RULE,
  TEST_RESULT_PROOF_RULE,
  CURRENT_STATE_PROOF_RULE,
] as const satisfies readonly ProofRuleDescriptor[];

export const BUILTIN_PROOF_RULE_BY_CLAIM_TYPE = {
  historical_action: HISTORICAL_ACTION_PROOF_RULE,
  test_result: TEST_RESULT_PROOF_RULE,
  current_state: CURRENT_STATE_PROOF_RULE,
} as const satisfies Readonly<Record<ClaimType, ProofRuleDescriptor>>;

export type BuiltinProofRuleDescriptor =
  (typeof BUILTIN_PROOF_RULE_DESCRIPTORS)[number];
