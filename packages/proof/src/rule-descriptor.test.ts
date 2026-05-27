import { describe, expect, it } from "vitest";

import {
  BUILTIN_PROOF_RULE_BY_CLAIM_TYPE,
  BUILTIN_PROOF_RULE_DESCRIPTORS,
} from "./builtin-rules.js";

const expectedClaimTypes = [
  "current_state",
  "historical_action",
  "test_result",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const visitDescriptor = (
  value: unknown,
  visitor: (path: string, key: string | null, value: unknown) => void,
  path = "$",
): void => {
  visitor(path, null, value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitDescriptor(entry, visitor, `${path}[${String(index)}]`);
    });
    return;
  }

  if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      visitor(`${path}.${key}`, key, entry);
      visitDescriptor(entry, visitor, `${path}.${key}`);
    });
  }
};

describe("proof rule descriptors", () => {
  it("exports exactly one built-in descriptor for each v0 claim type", () => {
    const descriptorClaimTypes = BUILTIN_PROOF_RULE_DESCRIPTORS.map(
      (descriptor) => descriptor.claimType,
    ).sort();

    expect(descriptorClaimTypes).toEqual(expectedClaimTypes);
    expect(new Set(descriptorClaimTypes).size).toBe(expectedClaimTypes.length);
    expect(Object.keys(BUILTIN_PROOF_RULE_BY_CLAIM_TYPE).sort()).toEqual(
      expectedClaimTypes,
    );
  });

  it("keeps descriptors as JSON data with no executable values", () => {
    const roundTripped = JSON.parse(
      JSON.stringify(BUILTIN_PROOF_RULE_DESCRIPTORS),
    ) as unknown;
    const functionPaths: string[] = [];

    visitDescriptor(BUILTIN_PROOF_RULE_DESCRIPTORS, (path, _key, value) => {
      if (typeof value === "function") {
        functionPaths.push(path);
      }
    });

    expect(roundTripped).toEqual(BUILTIN_PROOF_RULE_DESCRIPTORS);
    expect(functionPaths).toEqual([]);
  });

  it("does not expose callback, judge, similarity, or execution hooks", () => {
    const forbiddenKeyPattern =
      /callback|handler|function|execute|evaluator|judge|similarity/u;
    const forbiddenKeys: string[] = [];

    visitDescriptor(BUILTIN_PROOF_RULE_DESCRIPTORS, (path, key) => {
      if (key !== null && forbiddenKeyPattern.test(key)) {
        forbiddenKeys.push(path);
      }
    });

    expect(forbiddenKeys).toEqual([]);
  });

  it("references claim predicates rather than display text", () => {
    const invalidClaimReferences: string[] = [];
    const statementReferences: string[] = [];

    visitDescriptor(BUILTIN_PROOF_RULE_DESCRIPTORS, (path, key, value) => {
      if (key === "statement") {
        statementReferences.push(path);
      }

      if (typeof value !== "string") {
        return;
      }

      if (value === "statement" || value === "claim.statement") {
        statementReferences.push(path);
      }

      if (
        value.startsWith("claim.") &&
        value !== "claim.evidenceRefs" &&
        !value.startsWith("claim.predicate.")
      ) {
        invalidClaimReferences.push(`${path}: ${value}`);
      }
    });

    expect(statementReferences).toEqual([]);
    expect(invalidClaimReferences).toEqual([]);
  });

  it("declares evidence requirements for the three v0 proof categories", () => {
    expect(
      BUILTIN_PROOF_RULE_BY_CLAIM_TYPE.historical_action.evidence,
    ).toContainEqual({
      requirementId: "historical_action.effect_receipt",
      evidenceKind: "effect_receipt",
      source: "claim.evidenceRefs",
      minimumCount: 1,
      resolvesTo: "effect_receipt",
    });

    expect(
      BUILTIN_PROOF_RULE_BY_CLAIM_TYPE.test_result.evidence,
    ).toContainEqual({
      requirementId: "test_result.effect_receipt",
      evidenceKind: "effect_receipt",
      source: "claim.evidenceRefs",
      minimumCount: 1,
      resolvesTo: "effect_receipt",
    });

    expect(
      BUILTIN_PROOF_RULE_BY_CLAIM_TYPE.current_state.evidence,
    ).toContainEqual({
      requirementId: "current_state.external_observation",
      evidenceKind: "external_observation",
      source: "claim.evidenceRefs",
      minimumCount: 1,
      resolvesTo: "external_state_observation",
    });
  });

  it("describes receipt matching for historical actions and test results", () => {
    expect(
      BUILTIN_PROOF_RULE_BY_CLAIM_TYPE.historical_action.match.clauses,
    ).toEqual(
      expect.arrayContaining([
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
          right: {
            source: "literal",
            value: "succeeded",
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
      ]),
    );

    expect(BUILTIN_PROOF_RULE_BY_CLAIM_TYPE.test_result.match.clauses).toEqual(
      expect.arrayContaining([
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
          right: {
            source: "literal",
            value: "succeeded",
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
      ]),
    );
  });

  it("describes current-state freshness and predicate matching declaratively", () => {
    expect(
      BUILTIN_PROOF_RULE_BY_CLAIM_TYPE.current_state.match.clauses,
    ).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });
});
