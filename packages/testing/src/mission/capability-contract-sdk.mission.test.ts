import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateCapabilityContract,
  type CapabilityContract,
} from "@amca/capabilities";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const capabilitiesSourceDir = path.join(repoRoot, "packages/capabilities/src");
const exampleCapabilitiesDir = path.join(repoRoot, "examples/capabilities");

const bannedRuntimeTokens = [
  "child_process",
  "exec(",
  "execFile(",
  "spawn(",
  "fetch(",
  "EffectBroker",
  "recordEffectReceipt(",
  "submitFinalCandidate(",
  "FinalReleased",
] as const;

describe("Mission P7 Capability Contract SDK", () => {
  it("validates static capability contracts without changing AMCA Core", () => {
    const examples = exampleCapabilityContracts();

    expect(examples.map((example) => example.capabilityId).sort()).toEqual([
      "github.create_pull_request",
      "github.observe_pull_request_state",
      "shell.run_tests",
    ]);

    for (const example of examples) {
      expect(validateCapabilityContract(example)).toMatchObject({
        success: true,
      });
    }
  });

  it("rejects arbitrary proof callbacks", () => {
    expectInvalid({
      ...validCapabilityContract(),
      proofRules: [
        {
          ...validProofRule(),
          callback: "return true",
        },
      ],
    });
  });

  it("rejects capability contracts that try to execute tools directly", () => {
    expectInvalid({
      ...validCapabilityContract(),
      execute: "github.createPullRequest(args)",
    });

    expectInvalid({
      ...validCapabilityContract(),
      handler: {
        module: "./runtime.js",
        export: "run",
      },
    });
  });

  it("rejects capability contracts that try to bypass release authority", () => {
    expectInvalid({
      ...validCapabilityContract(),
      releaseDecision: {
        status: "released",
        approvedClaimIds: ["claim_forged"],
      },
      finalMessage: "Released outside AMCA.",
    });
  });

  it("rejects malformed proof descriptors fail-closed", () => {
    expectInvalid({
      ...validCapabilityContract(),
      proofRules: [
        {
          ...validProofRule(),
          predicateKind: "current_state",
        },
      ],
    });

    expectInvalid({
      ...validCapabilityContract(),
      proofRules: [
        {
          ...validProofRule(),
          evidence: [
            {
              requirementId: "bad",
              evidenceKind: "external_observation",
              source: "claim.evidenceRefs",
              minimumCount: 1,
              resolvesTo: "external_state_observation",
            },
          ],
        },
      ],
    });
  });

  it("keeps the contract SDK free of runtime execution authority", () => {
    for (const sourceFile of sourceFiles(capabilitiesSourceDir)) {
      const source = readFileSync(sourceFile, "utf8");

      for (const token of bannedRuntimeTokens) {
        expect(source, `${sourceFile} must not contain ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});

function exampleCapabilityContracts(): CapabilityContract[] {
  return sourceFiles(exampleCapabilitiesDir)
    .filter((filePath) => filePath.endsWith(".json"))
    .map((filePath) => JSON.parse(readFileSync(filePath, "utf8")) as unknown)
    .map((parsed) => {
      const result = validateCapabilityContract(parsed);
      if (!result.success) {
        throw new Error(
          `Example capability failed validation: ${result.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }

      return result.data;
    });
}

function expectInvalid(input: unknown): void {
  expect(validateCapabilityContract(input).success).toBe(false);
}

function validCapabilityContract(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: "mission.contract_only",
    profile: "standard",
    sideEffectClass: "compute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    receiptSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
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
      },
    ],
    proofRules: [validProofRule()],
  };
}

function validProofRule(): CapabilityContract["proofRules"][number] {
  return {
    ruleId: "mission.contract_only.test_result",
    version: 1,
    claimType: "test_result",
    predicateKind: "test_result",
    description: "Mission contract-only test-result proof descriptor.",
    evidence: [
      {
        requirementId: "mission.effect_receipt",
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
      ],
    },
  };
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry);
      const entryStat = statSync(entryPath);

      if (entryStat.isDirectory()) {
        return sourceFiles(entryPath);
      }

      return entryStat.isFile() ? [entryPath] : [];
    })
    .sort();
}
