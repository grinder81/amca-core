import { TEST_RESULT_PROOF_RULE } from "@amca/proof";
import { describe, expect, it } from "vitest";

import {
  capabilityContractToJsonSchema,
  defineCapability,
  parseCapabilityContract,
  validateCapabilityContract,
  validateCapabilityId,
  validateCapabilityJsonSchemaDocument,
} from "./index.js";
import type { CapabilityContract } from "./types.js";

const objectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const validCapability = {
  schemaVersion: 1,
  capabilityId: "shell.run_tests",
  profile: "standard",
  sideEffectClass: "compute",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
      },
    },
    required: ["command"],
  },
  receiptSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      result: {
        enum: ["passed", "failed"],
      },
    },
    required: ["result"],
  },
  evidence: [
    {
      evidenceKind: "effect_receipt",
      receiptType: "test_run",
    },
  ],
  supportedClaims: [
    {
      claimType: "test_result",
      predicateKind: "test_result",
      requiredReceiptType: "test_run",
      expectedStatuses: ["passed"],
    },
  ],
  proofRules: [TEST_RESULT_PROOF_RULE],
  description: "Runs a test suite and emits a test_run receipt.",
} as const satisfies CapabilityContract;

const expectInvalid = (input: unknown): void => {
  expect(validateCapabilityContract(input).success).toBe(false);
};

describe("capability contract DSL validation", () => {
  it("defines a valid capability contract as strict data", () => {
    const capability = defineCapability(validCapability);

    expect(capability.capabilityId).toBe("shell.run_tests");
    expect(capability.supportedClaims).toHaveLength(1);
    expect(capability.proofRules).toEqual([TEST_RESULT_PROOF_RULE]);
  });

  it("validates helper primitives used by capability authors", () => {
    expect(validateCapabilityId("shell.run_tests").success).toBe(true);
    expect(validateCapabilityId("Shell.RunTests").success).toBe(false);
    expect(validateCapabilityJsonSchemaDocument(objectSchema).success).toBe(
      true,
    );
    expect(
      validateCapabilityJsonSchemaDocument({
        type: "string",
      }),
    ).toMatchObject({
      success: false,
    });
  });

  it("exports a JSON Schema for static capability contracts", () => {
    const schema = capabilityContractToJsonSchema();

    expect(schema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
    });
  });

  it("rejects malformed identity, profile, and side-effect declarations", () => {
    expectInvalid({
      ...validCapability,
      capabilityId: "not lowercase",
    });
    expectInvalid({
      ...validCapability,
      profile: "enterprise",
    });
    expectInvalid({
      ...validCapability,
      sideEffectClass: "write",
    });
  });

  it("rejects missing required schemas and unknown contract fields", () => {
    const missingReceiptSchema = { ...validCapability } as Record<
      string,
      unknown
    >;
    Reflect.deleteProperty(missingReceiptSchema, "receiptSchema");

    expectInvalid(missingReceiptSchema);
    expectInvalid({
      ...validCapability,
      runtimeAdapter: "shell",
    });
  });

  it("rejects executable proof callbacks and callback-shaped hooks", () => {
    expectInvalid({
      ...validCapability,
      proofRules: [
        {
          ...TEST_RESULT_PROOF_RULE,
          callback: () => true,
        },
      ],
    });

    expectInvalid({
      ...validCapability,
      proofRules: [
        {
          ...TEST_RESULT_PROOF_RULE,
          match: {
            ...TEST_RESULT_PROOF_RULE.match,
            evaluator: "llm_judge",
          },
        },
      ],
    });
  });

  it("rejects non-JSON schema values such as functions", () => {
    expectInvalid({
      ...validCapability,
      inputSchema: {
        type: "object",
        properties: {
          command: () => "run",
        },
      },
    });
  });

  it("rejects proof rules that target unsupported claims", () => {
    expectInvalid({
      ...validCapability,
      supportedClaims: [
        {
          claimType: "historical_action",
          predicateKind: "historical_action",
          requiredReceiptType: "github.pull_request_created",
        },
      ],
    });
  });

  it("rejects proof rules that require undeclared evidence kinds", () => {
    expectInvalid({
      ...validCapability,
      evidence: [
        {
          evidenceKind: "external_observation",
          observationType: "github.pull_request_state",
        },
      ],
    });
  });

  it("surfaces validation issues for callers without throwing", () => {
    const result = validateCapabilityContract({
      ...validCapability,
      proofRules: [],
    });

    expect(result).toMatchObject({
      success: false,
    });

    if (!result.success) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("throws a named validation error for parser callers", () => {
    expect(() =>
      parseCapabilityContract({
        ...validCapability,
        capabilityId: "bad id",
      }),
    ).toThrow("CapabilityContract validation failed");
  });
});
