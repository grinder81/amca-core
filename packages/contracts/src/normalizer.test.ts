import type {
  Claim,
  CurrentStatePredicate,
  TestResultPredicate,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { normalizeProtocolInput } from "./normalizer.js";
import { validateClaim } from "./validate.js";

const testPredicate = {
  kind: "test_result",
  capabilityId: "shell.run_tests",
  expectedStatus: "passed",
  requiredReceiptType: "test_run",
} satisfies TestResultPredicate;

const testClaim = {
  claimId: "claim_tests_passed",
  type: "test_result",
  statement: "Tests passed.",
  predicate: testPredicate,
  evidenceRefs: [],
  criticality: "medium",
} satisfies Claim;

const currentStatePredicate = {
  kind: "current_state",
  subjectType: "package",
  subjectId: "@amca/contracts",
  property: "typecheck",
  operator: "equals",
  expectedValue: "passed",
  observationType: "command_status",
  freshnessRequirementMs: 300_000,
} satisfies CurrentStatePredicate;

const currentStateClaim = {
  claimId: "claim_current_state",
  type: "current_state",
  statement: "Contracts package typecheck is passing.",
  predicate: currentStatePredicate,
  evidenceRefs: [],
  criticality: "high",
} satisfies Claim;

describe("v0 normalizer policy", () => {
  it("normalizes only recognized enum fields", () => {
    const normalized = normalizeProtocolInput({
      ...testClaim,
      type: " TEST_RESULT ",
      predicate: {
        ...testPredicate,
        kind: " TEST_RESULT ",
        expectedStatus: " PASSED ",
      },
      criticality: " MEDIUM ",
    });

    expect(normalized).toEqual(testClaim);
    expect(validateClaim(normalized).success).toBe(true);
  });

  it("does not remove unknown fields", () => {
    const normalized = normalizeProtocolInput({
      ...testClaim,
      type: " TEST_RESULT ",
      unexpectedField: {
        type: " TEST_RESULT ",
      },
    });

    expect(normalized).toEqual({
      ...testClaim,
      unexpectedField: {
        type: " TEST_RESULT ",
      },
    });
    expect(validateClaim(normalized).success).toBe(false);
  });

  it("does not coerce semantic values", () => {
    const normalized = normalizeProtocolInput({
      ...currentStateClaim,
      predicate: {
        ...currentStatePredicate,
        operator: " EQUALS ",
        expectedValue: "42",
        freshnessRequirementMs: "300000",
        observationType: " command_status ",
      },
    });

    expect(normalized).toEqual({
      ...currentStateClaim,
      predicate: {
        ...currentStatePredicate,
        operator: "equals",
        expectedValue: "42",
        freshnessRequirementMs: "300000",
        observationType: " command_status ",
      },
    });
    expect(validateClaim(normalized).success).toBe(false);
  });

  it("does not normalize inside semantic JSON containers", () => {
    const normalized = normalizeProtocolInput({
      kind: "tool_command_request",
      commandId: "command_001",
      runId: "run_001",
      capabilityId: "shell.run_tests",
      toolId: "pnpm",
      sideEffectClass: " COMPUTE ",
      args: {
        type: " TEST_RESULT ",
        status: " PASSED ",
      },
    });

    expect(normalized).toEqual({
      kind: "tool_command_request",
      commandId: "command_001",
      runId: "run_001",
      capabilityId: "shell.run_tests",
      toolId: "pnpm",
      sideEffectClass: "compute",
      args: {
        type: " TEST_RESULT ",
        status: " PASSED ",
      },
    });
  });
});
