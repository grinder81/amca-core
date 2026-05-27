import {
  ClaimTypeSchema,
  CurrentStateOperatorSchema,
  EvidenceKindSchema,
  HistoricalActionVerbSchema,
  JsonObjectSchema,
  JsonPrimitiveSchema,
  NonEmptyStringSchema,
  SideEffectClassSchema as BaseSideEffectClassSchema,
} from "@amca/contracts";
import { z } from "zod";

import type { ProofRuleDescriptor } from "@amca/proof";

import type {
  CapabilityContract,
  CapabilityEvidenceDeclaration,
  CapabilityJsonSchemaDocument,
  CapabilityProfile,
  SupportedClaimDeclaration,
} from "./types.js";

const capabilityIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

export const CapabilityIdSchema = NonEmptyStringSchema.regex(
  capabilityIdPattern,
  "Capability ids must be dot-delimited lowercase identifiers such as shell.run_tests",
);

export const CapabilityProfileSchema = z.enum([
  "light",
  "standard",
  "critical",
  "regulated",
]) satisfies z.ZodType<CapabilityProfile>;

function capabilitySchema<T>(schema: z.ZodType): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

export const SideEffectClassSchema = BaseSideEffectClassSchema;

export const CapabilityJsonSchemaDocumentSchema =
  capabilitySchema<CapabilityJsonSchemaDocument>(
    JsonObjectSchema.superRefine((value, context) => {
      if (value.type !== "object") {
        context.addIssue({
          code: "custom",
          message: "Capability schemas must be JSON Schema object documents",
          path: ["type"],
        });
      }
    }),
  );

export const EffectReceiptEvidenceDeclarationSchema = z.strictObject({
  evidenceKind: z.literal("effect_receipt"),
  receiptType: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
});

export const ExternalObservationEvidenceDeclarationSchema = z.strictObject({
  evidenceKind: z.literal("external_observation"),
  observationType: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
});

export const ArtifactEvidenceDeclarationSchema = z.strictObject({
  evidenceKind: z.enum(["artifact", "test_output", "ledger_event"]),
  artifactType: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
});

export const CapabilityEvidenceDeclarationSchema = z.discriminatedUnion(
  "evidenceKind",
  [
    EffectReceiptEvidenceDeclarationSchema,
    ExternalObservationEvidenceDeclarationSchema,
    ArtifactEvidenceDeclarationSchema,
  ],
) satisfies z.ZodType<CapabilityEvidenceDeclaration>;

export const HistoricalActionClaimSupportSchema = z.strictObject({
  claimType: z.literal("historical_action"),
  predicateKind: z.literal("historical_action"),
  requiredReceiptType: NonEmptyStringSchema,
  actionVerbs: z.array(HistoricalActionVerbSchema).min(1).optional(),
  subjectTypes: z.array(NonEmptyStringSchema).min(1).optional(),
  targetTypes: z.array(NonEmptyStringSchema).min(1).optional(),
});

export const TestResultClaimSupportSchema = z.strictObject({
  claimType: z.literal("test_result"),
  predicateKind: z.literal("test_result"),
  requiredReceiptType: z.literal("test_run"),
  expectedStatuses: z
    .array(z.enum(["passed", "failed"]))
    .min(1)
    .optional(),
});

export const CurrentStateClaimSupportSchema = z.strictObject({
  claimType: z.literal("current_state"),
  predicateKind: z.literal("current_state"),
  observationType: NonEmptyStringSchema,
  supportedOperators: z.array(CurrentStateOperatorSchema).min(1).optional(),
  maximumFreshnessRequirementMs: z.number().int().positive().optional(),
});

export const SupportedClaimDeclarationSchema = z.discriminatedUnion(
  "claimType",
  [
    HistoricalActionClaimSupportSchema,
    TestResultClaimSupportSchema,
    CurrentStateClaimSupportSchema,
  ],
) satisfies z.ZodType<SupportedClaimDeclaration>;

const DescriptorLiteralSchema = JsonPrimitiveSchema;

const ClaimPredicatePathSchema = z.enum([
  "claim.predicate.actionVerb",
  "claim.predicate.capabilityId",
  "claim.predicate.expectedStatus",
  "claim.predicate.expectedValue",
  "claim.predicate.freshnessRequirementMs",
  "claim.predicate.observationType",
  "claim.predicate.operator",
  "claim.predicate.property",
  "claim.predicate.requiredReceiptType",
  "claim.predicate.subjectId",
  "claim.predicate.subjectType",
  "claim.predicate.targetId",
  "claim.predicate.targetType",
  "claim.predicate.testSuiteId",
]);

const EffectReceiptPathSchema = z
  .string()
  .refine(
    (value) =>
      [
        "effectReceipt.capabilityId",
        "effectReceipt.observedAt",
        "effectReceipt.receiptType",
        "effectReceipt.status",
      ].includes(value) ||
      /^effectReceipt\.payload\.[A-Za-z0-9_.-]+$/u.test(value),
    "Expected an effectReceipt field path",
  );

const ExternalObservationPathSchema = z
  .string()
  .refine(
    (value) =>
      [
        "externalObservation.expiresAt",
        "externalObservation.observationType",
        "externalObservation.observedAt",
        "externalObservation.subjectId",
        "externalObservation.subjectType",
      ].includes(value) ||
      /^externalObservation\.observedState\.[A-Za-z0-9_.-]+$/u.test(value),
    "Expected an externalObservation field path",
  );

const MatchValueRefSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("claim_predicate"),
    path: ClaimPredicatePathSchema,
  }),
  z.strictObject({
    source: z.literal("effect_receipt"),
    path: EffectReceiptPathSchema,
  }),
  z.strictObject({
    source: z.literal("external_observation"),
    path: ExternalObservationPathSchema,
  }),
  z.strictObject({
    source: z.literal("external_observation_dynamic"),
    root: z.literal("externalObservation.observedState"),
    pathFrom: z.literal("claim.predicate.property"),
  }),
  z.strictObject({
    source: z.literal("literal"),
    value: DescriptorLiteralSchema,
  }),
]);

const FieldEqualsMatchDescriptorSchema = z.strictObject({
  kind: z.literal("field_equals"),
  left: MatchValueRefSchema,
  right: MatchValueRefSchema,
  presence: z.enum(["always", "when_claim_field_present"]),
});

const FreshWithinMatchDescriptorSchema = z.strictObject({
  kind: z.literal("fresh_within"),
  observedAt: z.strictObject({
    source: z.literal("external_observation"),
    path: z.literal("externalObservation.observedAt"),
  }),
  ttlMs: z.strictObject({
    source: z.literal("claim_predicate"),
    path: z.literal("claim.predicate.freshnessRequirementMs"),
  }),
  evaluatedAt: z.literal("proof.generatedAt"),
});

const ObservedStateSatisfiesPredicateMatchDescriptorSchema = z.strictObject({
  kind: z.literal("observed_state_satisfies_predicate"),
  observedValue: z.strictObject({
    source: z.literal("external_observation_dynamic"),
    root: z.literal("externalObservation.observedState"),
    pathFrom: z.literal("claim.predicate.property"),
  }),
  operator: z.strictObject({
    source: z.literal("claim_predicate"),
    path: z.literal("claim.predicate.operator"),
  }),
  expectedValue: z.strictObject({
    source: z.literal("claim_predicate"),
    path: z.literal("claim.predicate.expectedValue"),
  }),
  supportedOperators: z.array(CurrentStateOperatorSchema).min(1),
});

const MatchClauseDescriptorSchema = z.discriminatedUnion("kind", [
  FieldEqualsMatchDescriptorSchema,
  FreshWithinMatchDescriptorSchema,
  ObservedStateSatisfiesPredicateMatchDescriptorSchema,
]);

const MatchDescriptorSchema = z.strictObject({
  operator: z.literal("all"),
  clauses: z.array(MatchClauseDescriptorSchema).min(1),
});

const EvidenceRequirementSchema = z.strictObject({
  requirementId: NonEmptyStringSchema,
  evidenceKind: EvidenceKindSchema,
  source: z.literal("claim.evidenceRefs"),
  minimumCount: z.literal(1),
  resolvesTo: z.enum([
    "effect_receipt",
    "external_state_observation",
    "artifact",
    "test_output",
    "ledger_event",
  ]),
});

export const DeclarativeProofRuleDescriptorSchema = z
  .strictObject({
    ruleId: NonEmptyStringSchema,
    version: z.literal(1),
    claimType: ClaimTypeSchema,
    predicateKind: ClaimTypeSchema,
    description: NonEmptyStringSchema,
    evidence: z.array(EvidenceRequirementSchema).min(1),
    match: MatchDescriptorSchema,
  })
  .superRefine((value, context) => {
    if (value.claimType !== value.predicateKind) {
      context.addIssue({
        code: "custom",
        message: "Proof rule claimType and predicateKind must match in v0",
        path: ["predicateKind"],
      });
    }
  }) as z.ZodType<ProofRuleDescriptor>;

export const CapabilityContractSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    capabilityId: CapabilityIdSchema,
    profile: CapabilityProfileSchema,
    sideEffectClass: SideEffectClassSchema,
    inputSchema: CapabilityJsonSchemaDocumentSchema,
    receiptSchema: CapabilityJsonSchemaDocumentSchema,
    evidence: z.array(CapabilityEvidenceDeclarationSchema).min(1),
    supportedClaims: z.array(SupportedClaimDeclarationSchema).min(1),
    proofRules: z.array(DeclarativeProofRuleDescriptorSchema).min(1),
    description: NonEmptyStringSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .superRefine((value, context) => {
    const supportedClaimTypes = new Set(
      value.supportedClaims.map((claim) => claim.claimType),
    );
    const declaredEvidenceKinds = new Set(
      value.evidence.map((evidence) => evidence.evidenceKind),
    );

    value.proofRules.forEach((rule, ruleIndex) => {
      if (!supportedClaimTypes.has(rule.claimType)) {
        context.addIssue({
          code: "custom",
          message: `Proof rule ${rule.ruleId} targets an unsupported claim type`,
          path: ["proofRules", ruleIndex, "claimType"],
        });
      }

      rule.evidence.forEach((requirement, requirementIndex) => {
        if (!declaredEvidenceKinds.has(requirement.evidenceKind)) {
          context.addIssue({
            code: "custom",
            message: `Proof rule ${rule.ruleId} requires undeclared evidence kind ${requirement.evidenceKind}`,
            path: [
              "proofRules",
              ruleIndex,
              "evidence",
              requirementIndex,
              "evidenceKind",
            ],
          });
        }
      });
    });

    value.supportedClaims.forEach((claim, claimIndex) => {
      const hasProofRule = value.proofRules.some(
        (rule) => rule.claimType === claim.claimType,
      );

      if (!hasProofRule) {
        context.addIssue({
          code: "custom",
          message: `Supported claim type ${claim.claimType} has no proof rule`,
          path: ["supportedClaims", claimIndex, "claimType"],
        });
      }
    });
  }) as z.ZodType<CapabilityContract>;
