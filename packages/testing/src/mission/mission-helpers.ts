import { expect } from "vitest";

import type {
  Claim,
  CurrentStatePredicate,
  EffectReceipt,
  EffectRequest,
  EffectStatus,
  EvidenceRef,
  ExternalStateObservation,
  FinalCandidate,
  HistoricalActionPredicate,
  JsonObject,
  ReleaseDecision,
  RunEventType,
  Sha256Hash,
  TestResultPredicate,
  ToolCommandRequest,
} from "@amca/protocol";
import {
  hashRunEventPayload,
  InMemoryRunKernel,
  RunKernelError,
} from "@amca/kernel";

export const STARTED_AT = "2026-05-24T11:58:00.000Z";
export const GENERATED_AT = "2026-05-24T12:00:00.000Z";
export const FRESH_OBSERVED_AT = "2026-05-24T11:59:30.000Z";
export const STALE_OBSERVED_AT = "2026-05-24T11:00:00.000Z";
export const FUTURE_OBSERVED_AT = "2026-05-24T12:00:01.000Z";
export const EXPIRES_AT = "2026-05-24T12:05:00.000Z";
export const BAD_HASH =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" satisfies Sha256Hash;

export function startedKernel(runId: string): InMemoryRunKernel {
  const kernel = new InMemoryRunKernel({
    runId,
    clock: () => GENERATED_AT,
  });
  kernel.startRun({
    occurredAt: STARTED_AT,
    profile: "standard",
  });
  return kernel;
}

export function eventTypes(kernel: InMemoryRunKernel): RunEventType[] {
  return kernel.events().map((event) => event.type);
}

export function expectRunKernelError(
  operation: () => unknown,
  code: RunKernelError["code"],
): void {
  expect(operation).toThrow(RunKernelError);

  try {
    operation();
  } catch (error) {
    expect((error as RunKernelError).code).toBe(code);
    return;
  }

  throw new Error(`Expected RunKernelError with code ${code}.`);
}

export function submitReleasedTestClaim(runId: string): {
  readonly decision: ReleaseDecision;
  readonly kernel: InMemoryRunKernel;
  readonly claim: Claim;
  readonly evidenceRef: EvidenceRef;
} {
  const receiptEventId = `evt_${runId}_test_receipt`;
  const payload = testRunPayload({ testSuiteId: "unit" });
  const evidenceRef = effectEvidenceRef(
    "ev_test_receipt",
    hashRunEventPayload(payload),
    {
      sourceEventId: receiptEventId,
    },
  );
  const kernel = startedKernel(runId);
  kernel.recordEffectRequest(testRunEffectRequest(runId));
  kernel.recordEffectReceipt(
    testRunReceipt(runId, {
      evidence: [evidenceRef],
      payload,
    }),
    {
      eventId: receiptEventId,
      occurredAt: FRESH_OBSERVED_AT,
    },
  );

  const claim = testResultClaim({
    evidenceRefs: [evidenceRef],
    testSuiteId: "unit",
  });
  const result = kernel.submitFinalCandidate(candidateWith(runId, claim), {
    occurredAt: GENERATED_AT,
    generatedAt: GENERATED_AT,
  });

  return {
    decision: result.decision,
    kernel,
    claim,
    evidenceRef,
  };
}

export function candidateWith(runId: string, claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${claim.claimId}`,
    runId,
    claims: [claim],
  };
}

export function toolCommandRequest(runId: string): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: "command_test_001",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    idempotencyKey: `${runId}:test`,
  };
}

export function testRunEffectRequest(runId: string): EffectRequest {
  return {
    effectId: "effect_test_001",
    commandId: "command_test_001",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    requestedAt: FRESH_OBSERVED_AT,
  };
}

export function pullRequestEffectRequest(runId: string): EffectRequest {
  return {
    effectId: "effect_pr_001",
    commandId: "command_pr_001",
    runId,
    capabilityId: "github.create_pull_request",
    toolId: "github.create_pull_request",
    args: {
      targetType: "pull_request",
      targetId: "123",
    },
    sideEffectClass: "idempotent_write",
    requestedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:pull_request:123`,
  };
}

export function testResultClaim(options: {
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly statement?: string;
  readonly expectedStatus?: TestResultPredicate["expectedStatus"];
  readonly testSuiteId?: string;
}): Claim {
  const expectedStatus = options.expectedStatus ?? "passed";
  const predicate: TestResultPredicate = {
    kind: "test_result",
    capabilityId: "shell.run_tests",
    expectedStatus,
    requiredReceiptType: "test_run",
    ...(options.testSuiteId === undefined
      ? {}
      : { testSuiteId: options.testSuiteId }),
  };

  return {
    claimId: "claim_tests_passed",
    type: "test_result",
    statement: options.statement ?? "Tests passed.",
    predicate,
    evidenceRefs: [...options.evidenceRefs],
    criticality: "medium",
  };
}

export function historicalActionClaim(options: {
  readonly evidenceRefs: readonly EvidenceRef[];
}): Claim {
  const predicate: HistoricalActionPredicate = {
    kind: "historical_action",
    actionVerb: "created",
    subjectType: "agent",
    subjectId: "agent_001",
    targetType: "pull_request",
    targetId: "123",
    capabilityId: "github.create_pull_request",
    requiredReceiptType: "github.pull_request_created",
  };

  return {
    claimId: "claim_pr_opened",
    type: "historical_action",
    statement: "I opened PR #123.",
    predicate,
    evidenceRefs: [...options.evidenceRefs],
    criticality: "medium",
  };
}

export function currentStateClaim(options: {
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly expectedValue?: CurrentStatePredicate["expectedValue"];
}): Claim {
  const predicate: CurrentStatePredicate = {
    kind: "current_state",
    subjectType: "pull_request",
    subjectId: "123",
    property: "state",
    operator: "equals",
    expectedValue: options.expectedValue ?? "open",
    observationType: "github.pull_request_state",
    freshnessRequirementMs: 60_000,
  };

  return {
    claimId: "claim_pr_currently_open",
    type: "current_state",
    statement: "PR #123 is currently open.",
    predicate,
    evidenceRefs: [...options.evidenceRefs],
    criticality: "medium",
  };
}

export function effectEvidenceRef(
  evidenceId: string,
  hash: Sha256Hash,
  options: {
    readonly sourceEventId: string;
    readonly observedAt?: string;
  },
): EvidenceRef {
  return {
    evidenceId,
    kind: "effect_receipt",
    sourceEventId: options.sourceEventId,
    hash,
    observedAt: options.observedAt ?? FRESH_OBSERVED_AT,
    sensitivity: "internal",
  };
}

export function observationEvidenceRef(
  evidenceId: string,
  hash: Sha256Hash,
  options: {
    readonly sourceEventId: string;
    readonly observedAt?: string;
  },
): EvidenceRef {
  return {
    evidenceId,
    kind: "external_observation",
    sourceEventId: options.sourceEventId,
    hash,
    observedAt: options.observedAt ?? FRESH_OBSERVED_AT,
    sensitivity: "internal",
  };
}

export function testRunPayload(options: JsonObject = {}): JsonObject {
  return {
    result: "passed",
    ...options,
  };
}

export function pullRequestPayload(options: JsonObject = {}): JsonObject {
  return {
    actionVerb: "created",
    subjectType: "agent",
    subjectId: "agent_001",
    targetType: "pull_request",
    targetId: "123",
    ...options,
  };
}

export function testRunReceipt(
  runId: string,
  options: {
    readonly evidence: readonly EvidenceRef[];
    readonly payload?: JsonObject;
    readonly status?: EffectStatus;
    readonly capabilityId?: string;
    readonly receiptType?: string;
    readonly payloadHash?: Sha256Hash;
  },
): EffectReceipt {
  const payload = options.payload ?? testRunPayload();
  return {
    receiptId: "receipt_test_001",
    effectId: "effect_test_001",
    runId,
    capabilityId: options.capabilityId ?? "shell.run_tests",
    receiptType: options.receiptType ?? "test_run",
    status: options.status ?? "succeeded",
    payload,
    payloadHash: options.payloadHash ?? hashRunEventPayload(payload),
    evidence: [...options.evidence],
    observedAt: FRESH_OBSERVED_AT,
  };
}

export function pullRequestReceipt(
  runId: string,
  options: {
    readonly evidence: readonly EvidenceRef[];
    readonly status?: EffectStatus;
    readonly payload?: JsonObject;
  },
): EffectReceipt {
  const payload = options.payload ?? pullRequestPayload();
  return {
    receiptId: "receipt_pr_001",
    effectId: "effect_pr_001",
    runId,
    capabilityId: "github.create_pull_request",
    receiptType: "github.pull_request_created",
    status: options.status ?? "succeeded",
    payload,
    payloadHash: hashRunEventPayload(payload),
    evidence: [...options.evidence],
    observedAt: FRESH_OBSERVED_AT,
    externalRef: "https://github.example/pr/123",
  };
}

export function pullRequestStateObservation(
  runId: string,
  options: {
    readonly evidence: readonly EvidenceRef[];
    readonly observedAt?: string;
    readonly observedState?: JsonObject;
    readonly subjectId?: string;
    readonly subjectType?: string;
    readonly payloadHash?: Sha256Hash;
  },
): ExternalStateObservation {
  const observedState = options.observedState ?? { state: "open" };
  return {
    observationId: "observation_pr_state_001",
    runId,
    observationType: "github.pull_request_state",
    subjectType: options.subjectType ?? "pull_request",
    subjectId: options.subjectId ?? "123",
    observedState,
    observedAt: options.observedAt ?? FRESH_OBSERVED_AT,
    expiresAt: EXPIRES_AT,
    payloadHash: options.payloadHash ?? hashRunEventPayload(observedState),
    evidence: [...options.evidence],
  };
}
