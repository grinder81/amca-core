import { canonicalObjectHash } from "@amca/contracts";
import { EffectBrokerError } from "@amca/effect-broker";
import type {
  Claim,
  EvidenceRef,
  ExternalStateObservationCandidate,
  FinalCandidate,
  JsonObject,
  PendingEvidenceRef,
  ReceiptCandidate,
  RunEventType,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { LocalRunHarness, type LocalRunHarnessOptions } from "./index.js";

const STARTED_AT = "2026-05-24T11:58:00.000Z";
const NOW = "2026-05-24T12:00:00.000Z";
const REEVALUATED_AT = "2026-05-24T12:01:00.000Z";

type BrokerOptions = NonNullable<LocalRunHarnessOptions["brokerOptions"]>;
type Capability = NonNullable<BrokerOptions["capabilities"]>[number];
type Adapter = NonNullable<BrokerOptions["adapters"]>[number];

describe("LocalRunHarness", () => {
  it("releases a test_result claim only after the broker receipt is admitted by the kernel", async () => {
    const fixture = testResultFixture({
      runId: "run_harness_test_result_released",
      sideEffectClass: "compute",
    });
    const harness = startedHarness(fixture);

    const result = await harness.runToRelease({
      toolCommand: fixture.command,
      finalCandidate: fixture.finalCandidate,
      options: {
        finalCandidate: {
          generatedAt: NOW,
          occurredAt: NOW,
        },
      },
    });

    expect(result.finalCandidate.decision.status).toBe("released");
    expect(result.finalCandidate.proof.verdict).toBe("pass");
    expect(result.dispatch.effectReceiptEvent.payload.receipt.evidence).toEqual(
      fixture.finalCandidate.claims[0]?.evidenceRefs,
    );
    expect(fixture.calls).toHaveLength(1);
    expect(eventTypes(harness)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
    expect(eventTypes(harness).indexOf("EffectReceiptRecorded")).toBeLessThan(
      eventTypes(harness).indexOf("ProofGenerated"),
    );
  });

  it("blocks a claim when a broker receipt has not been recorded in the kernel", async () => {
    const fixture = testResultFixture({
      runId: "run_harness_receipt_not_admitted",
      sideEffectClass: "compute",
    });
    const harness = startedHarness(fixture);
    const proposalEvent = harness.kernel.submitToolCommand(fixture.command);
    const brokerResult = await harness.broker.dispatch(fixture.command);

    harness.kernel.recordEffectRequest(brokerResult.effectRequest, {
      causationId: proposalEvent.eventId,
      occurredAt: brokerResult.effectRequest.requestedAt,
    });

    const result = harness.submitFinalCandidate(fixture.finalCandidate, {
      generatedAt: NOW,
      occurredAt: NOW,
    });

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: fixture.claim.claimId,
        blocking: true,
      }),
    );
    expect(eventTypes(harness)).not.toContain("EffectReceiptRecorded");
    expect(eventTypes(harness)).not.toContain("FinalReleased");
  });

  it.each(["compute", "read"] as const)(
    "routes a %s command through broker, kernel, proof, and release",
    async (sideEffectClass) => {
      const fixture = testResultFixture({
        runId: `run_harness_${sideEffectClass}_path`,
        sideEffectClass,
      });
      const harness = startedHarness(fixture);

      const result = await harness.runToRelease({
        toolCommand: fixture.command,
        finalCandidate: fixture.finalCandidate,
        options: {
          finalCandidate: {
            generatedAt: NOW,
            occurredAt: NOW,
          },
        },
      });

      expect(result.dispatch.brokerResult.effectRequest.sideEffectClass).toBe(
        sideEffectClass,
      );
      expect(result.dispatch.effectRequestEvent.payload.effectRequest).toEqual(
        result.dispatch.brokerResult.effectRequest,
      );
      expect(result.dispatch.effectReceiptEvent.payload.receipt).toEqual(
        result.dispatch.recordedReceipt,
      );
      expect(result.finalCandidate.decision.status).toBe("released");
      expect(fixture.calls).toHaveLength(1);
    },
  );

  it("does not duplicate adapter calls or kernel receipt admission for an idempotent duplicate dispatch", async () => {
    const fixture = testResultFixture({
      runId: "run_harness_idempotent_duplicate",
      sideEffectClass: "compute",
      idempotencyKey: "idem_duplicate_dispatch",
    });
    const harness = startedHarness(fixture);

    const first = await harness.dispatchToolCommand(fixture.command);
    const second = await harness.dispatchToolCommand(fixture.command);

    expect(first.status).toBe("dispatched");
    expect(second.status).toBe("cached");
    expect(fixture.calls).toHaveLength(1);
    expect(countEvents(harness, "EffectRequested")).toBe(1);
    expect(countEvents(harness, "EffectReceiptRecorded")).toBe(1);
    expect(countEvents(harness, "ProposalReceived")).toBe(2);
  });

  it("admits broker-certified observations after receipts before proving current-state claims", async () => {
    const fixture = currentStateFixture({
      runId: "run_harness_current_state_released",
      observedState: { state: "open" },
      observedAt: NOW,
    });
    const harness = startedHarness(fixture);

    const result = await harness.runToRelease({
      toolCommand: fixture.command,
      finalCandidate: fixture.finalCandidate,
      options: {
        finalCandidate: {
          generatedAt: NOW,
          occurredAt: NOW,
        },
      },
    });

    expect(result.finalCandidate.decision.status).toBe("released");
    expect(result.dispatch.recordedExternalStateObservation).toEqual(
      result.dispatch.externalStateObservationEvent?.payload.observation,
    );
    expect(result.dispatch.externalStateObservationEvent?.causationId).toBe(
      result.dispatch.effectReceiptEvent.eventId,
    );
    expect(result.dispatch.recordedExternalStateObservation?.evidence).toEqual(
      fixture.finalCandidate.claims[0]?.evidenceRefs,
    );
    expect(eventTypes(harness)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ExternalStateObserved",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
  });

  it("blocks current-state claims when broker observations are not admitted by the kernel", async () => {
    const fixture = currentStateFixture({
      runId: "run_harness_current_state_not_admitted",
      observedState: { state: "open" },
      observedAt: NOW,
    });
    const harness = startedHarness(fixture);
    const proposalEvent = harness.kernel.submitToolCommand(fixture.command);
    const brokerResult = await harness.broker.dispatch(fixture.command);

    harness.kernel.recordEffectRequest(brokerResult.effectRequest, {
      causationId: proposalEvent.eventId,
      occurredAt: brokerResult.effectRequest.requestedAt,
    });
    const receiptEventId = `evt_${fixture.command.commandId}_receipt_recorded`;
    harness.kernel.recordEffectReceipt(
      admitReceiptCandidate(brokerResult.receiptCandidate, receiptEventId),
      {
        eventId: receiptEventId,
        causationId: proposalEvent.eventId,
        occurredAt: brokerResult.receiptCandidate.observedAt,
      },
    );

    const result = harness.submitFinalCandidate(fixture.finalCandidate, {
      generatedAt: NOW,
      occurredAt: NOW,
    });

    expect(brokerResult.externalStateObservationCandidate).toBeDefined();
    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: fixture.claim.claimId,
        blocking: true,
      }),
    );
    expect(eventTypes(harness)).not.toContain("ExternalStateObserved");
    expect(eventTypes(harness)).not.toContain("FinalReleased");
  });

  it("records only one observation for duplicate idempotent dispatches", async () => {
    const fixture = currentStateFixture({
      runId: "run_harness_current_state_duplicate",
      observedState: { state: "open" },
      observedAt: NOW,
      sideEffectClass: "read",
      idempotencyKey: "idem_observation_duplicate",
    });
    const harness = startedHarness(fixture);

    const first = await harness.dispatchToolCommand(fixture.command);
    const second = await harness.dispatchToolCommand(fixture.command);

    expect(first.status).toBe("dispatched");
    expect(second.status).toBe("cached");
    expect(fixture.calls).toHaveLength(1);
    expect(countEvents(harness, "EffectRequested")).toBe(1);
    expect(countEvents(harness, "EffectReceiptRecorded")).toBe(1);
    expect(countEvents(harness, "ExternalStateObserved")).toBe(1);
  });

  it("fails before kernel receipt admission when a write command omits idempotencyKey", async () => {
    const fixture = testResultFixture({
      runId: "run_harness_write_without_idempotency_key",
      sideEffectClass: "idempotent_write",
    });
    const harness = startedHarness(fixture);

    await expectBrokerError(
      harness.dispatchToolCommand(fixture.command),
      "idempotency_key_required",
    );
    expect(fixture.calls).toHaveLength(0);
    expect(eventTypes(harness)).toEqual(["RunStarted", "ProposalReceived"]);
  });

  it("fails closed for critical_write commands", () => {
    const fixture = testResultFixture({
      runId: "run_harness_critical_write",
      sideEffectClass: "critical_write",
      idempotencyKey: "idem_critical_write",
    });

    expectBrokerErrorSync(
      () => startedHarness(fixture),
      "critical_write_requires_approval",
    );
    expect(fixture.calls).toHaveLength(0);
  });

  it("fails closed when a recorded receipt does not satisfy the claim predicate", async () => {
    const fixture = testResultFixture({
      runId: "run_harness_mismatched_receipt",
      sideEffectClass: "compute",
      result: "failed",
    });
    const harness = startedHarness(fixture);

    const result = await harness.runToRelease({
      toolCommand: fixture.command,
      finalCandidate: fixture.finalCandidate,
      options: {
        finalCandidate: {
          generatedAt: NOW,
          occurredAt: NOW,
        },
      },
    });

    expect(result.finalCandidate.decision.status).toBe("blocked");
    expect(result.finalCandidate.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        claimId: fixture.claim.claimId,
        blocking: true,
      }),
    );
    expect(eventTypes(harness)).toContain("EffectReceiptRecorded");
    expect(eventTypes(harness)).not.toContain("FinalReleased");
  });

  it("re-evaluates and replays without dispatching the adapter again", async () => {
    const fixture = testResultFixture({
      runId: "run_harness_reevaluation_no_redispatch",
      sideEffectClass: "compute",
    });
    const harness = startedHarness(fixture);

    await harness.runToRelease({
      toolCommand: fixture.command,
      finalCandidate: fixture.finalCandidate,
      options: {
        finalCandidate: {
          generatedAt: NOW,
          occurredAt: NOW,
        },
      },
    });
    const reevaluation = harness.reevaluateFinalCandidate(
      fixture.finalCandidate,
      {
        generatedAt: REEVALUATED_AT,
        occurredAt: REEVALUATED_AT,
      },
    );
    const replay = harness.replay();

    expect(reevaluation.decision.status).toBe("released");
    expect(replay.events.map((event) => event.sequence)).toEqual(
      replay.events.map((_, index) => index + 1),
    );
    expect(fixture.calls).toHaveLength(1);
    expect(countEvents(harness, "EffectRequested")).toBe(1);
    expect(countEvents(harness, "EffectReceiptRecorded")).toBe(1);
  });
});

interface TestResultFixture {
  readonly command: ToolCommandRequest;
  readonly capability: Capability;
  readonly adapter: Adapter;
  readonly finalCandidate: FinalCandidate;
  readonly claim: Claim;
  readonly calls: ToolCommandRequest[];
}

interface CurrentStateFixture {
  readonly command: ToolCommandRequest;
  readonly capability: Capability;
  readonly adapter: Adapter;
  readonly finalCandidate: FinalCandidate;
  readonly claim: Claim;
  readonly calls: ToolCommandRequest[];
}

function startedHarness(fixture: TestResultFixture): LocalRunHarness {
  const harness = new LocalRunHarness({
    runId: fixture.command.runId,
    clock: () => NOW,
    brokerOptions: {
      capabilities: [fixture.capability],
      adapters: [fixture.adapter],
      clock: () => NOW,
    },
  });
  harness.startRun({
    occurredAt: STARTED_AT,
    profile: "standard",
  });
  return harness;
}

function testResultFixture(input: {
  readonly runId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly idempotencyKey?: string;
  readonly result?: "passed" | "failed";
}): TestResultFixture {
  const capabilityId = "tests.run";
  const toolId = "tests.run";
  const commandId = `cmd_${input.runId}`;
  const payload = {
    result: input.result ?? "passed",
    testSuiteId: "unit",
  };
  const evidenceRef = effectEvidenceRef({
    commandId,
    evidenceId: `ev_${commandId}`,
    hash: canonicalObjectHash(payload),
  });
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId,
    runId: input.runId,
    capabilityId,
    toolId,
    args: {
      testSuiteId: "unit",
    },
    sideEffectClass: input.sideEffectClass,
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
  };
  const claim = testResultClaim({
    runId: input.runId,
    capabilityId,
    evidenceRef,
  });
  const calls: ToolCommandRequest[] = [];
  const receiptType = "test_run";

  return {
    command,
    capability: testResultCapability({
      capabilityId,
      sideEffectClass: input.sideEffectClass,
      receiptType,
    }),
    adapter: testResultAdapter({
      calls,
      payload,
      receiptType,
      sideEffectClass: input.sideEffectClass,
    }),
    finalCandidate: {
      kind: "final_candidate",
      candidateId: `candidate_${input.runId}`,
      runId: input.runId,
      claims: [claim],
      narrativeDraft: "Tests passed.",
    },
    claim,
    calls,
  };
}

function currentStateFixture(input: {
  readonly runId: string;
  readonly observedState: JsonObject;
  readonly observedAt: string;
  readonly sideEffectClass?: SideEffectClass;
  readonly idempotencyKey?: string;
}): CurrentStateFixture {
  const capabilityId = "github.observe_pull_request_state";
  const toolId = "github.observe_pull_request_state";
  const commandId = `cmd_${input.runId}`;
  const observationHash = canonicalObjectHash(input.observedState);
  const observationEvidenceRef = externalObservationEvidenceRef({
    commandId,
    evidenceId: `ev_obs_${commandId}`,
    hash: observationHash,
    observedAt: input.observedAt,
  });
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId,
    runId: input.runId,
    capabilityId,
    toolId,
    args: {
      pullRequestId: "123",
    },
    sideEffectClass: input.sideEffectClass ?? "read",
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
  };
  const claim = currentStateClaim({
    runId: input.runId,
    evidenceRef: observationEvidenceRef,
  });
  const calls: ToolCommandRequest[] = [];

  return {
    command,
    capability: currentStateCapability({
      capabilityId,
      sideEffectClass: command.sideEffectClass,
    }),
    adapter: currentStateAdapter({
      calls,
      observedAt: input.observedAt,
      observedState: input.observedState,
      sideEffectClass: command.sideEffectClass,
    }),
    finalCandidate: {
      kind: "final_candidate",
      candidateId: `candidate_${input.runId}`,
      runId: input.runId,
      claims: [claim],
      narrativeDraft: "Pull request 123 is currently open.",
    },
    claim,
    calls,
  };
}

function testResultClaim(input: {
  readonly runId: string;
  readonly capabilityId: string;
  readonly evidenceRef: EvidenceRef;
}): Claim {
  return {
    claimId: `claim_${input.runId}`,
    type: "test_result",
    statement: "Tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId: input.capabilityId,
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
      testSuiteId: "unit",
    },
    evidenceRefs: [input.evidenceRef],
    criticality: "medium",
  };
}

function testResultAdapter(input: {
  readonly calls: ToolCommandRequest[];
  readonly payload: JsonObject;
  readonly receiptType: string;
  readonly sideEffectClass: SideEffectClass;
}): Adapter {
  return {
    adapterId: "adapter.tests.run",
    capabilityId: "tests.run",
    toolId: "tests.run",
    certification: {
      certificationVersion: 1,
      adapterId: "adapter.tests.run",
      adapterKind: "deterministic_fake",
      capabilityId: "tests.run",
      toolId: "tests.run",
      sideEffectClass: input.sideEffectClass,
      declaredReceiptTypes: [input.receiptType],
      idempotency:
        input.sideEffectClass === "read" || input.sideEffectClass === "compute"
          ? "not_required"
          : "required_for_writes",
      ...writeLifecycleFor(input.sideEffectClass),
      riskProfile: "standard",
    },
    execute: (request) => {
      input.calls.push(request.toolCommand);

      const payloadHash = canonicalObjectHash(input.payload);
      const receiptCandidate: ReceiptCandidate = {
        receiptId: `receipt_${request.effectRequest.effectId}`,
        effectId: request.effectRequest.effectId,
        runId: request.effectRequest.runId,
        capabilityId: request.effectRequest.capabilityId,
        receiptType: input.receiptType,
        status: "succeeded",
        payload: input.payload,
        payloadHash,
        evidence: [
          {
            evidenceId: `ev_${request.toolCommand.commandId}`,
            kind: "effect_receipt",
            admissionStatus: "pending",
            pendingAdmissionToken: `pending_ev_${request.toolCommand.commandId}`,
            hash: payloadHash,
            observedAt: NOW,
            sensitivity: "internal",
          },
        ],
        observedAt: NOW,
      };

      return { receiptCandidate };
    },
  };
}

function testResultCapability(input: {
  readonly capabilityId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly receiptType: string;
}): Capability {
  return {
    schemaVersion: 1,
    capabilityId: input.capabilityId,
    profile: "standard",
    sideEffectClass: input.sideEffectClass,
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    receiptSchema: {
      type: "object",
      additionalProperties: true,
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType: input.receiptType,
      },
    ],
    supportedClaims: [
      {
        claimType: "test_result",
        predicateKind: "test_result",
        requiredReceiptType: "test_run",
      },
    ],
    proofRules: [],
  };
}

function currentStateClaim(input: {
  readonly runId: string;
  readonly evidenceRef: EvidenceRef;
}): Claim {
  return {
    claimId: `claim_${input.runId}`,
    type: "current_state",
    statement: "Pull request 123 is currently open.",
    predicate: {
      kind: "current_state",
      subjectType: "pull_request",
      subjectId: "123",
      property: "state",
      operator: "equals",
      expectedValue: "open",
      observationType: "github.pull_request_state",
      freshnessRequirementMs: 60_000,
    },
    evidenceRefs: [input.evidenceRef],
    criticality: "medium",
  };
}

function currentStateAdapter(input: {
  readonly calls: ToolCommandRequest[];
  readonly observedAt: string;
  readonly observedState: JsonObject;
  readonly sideEffectClass: SideEffectClass;
}): Adapter {
  return {
    adapterId: "adapter.github.observe_pull_request_state",
    capabilityId: "github.observe_pull_request_state",
    toolId: "github.observe_pull_request_state",
    certification: {
      certificationVersion: 1,
      adapterId: "adapter.github.observe_pull_request_state",
      adapterKind: "deterministic_fake",
      capabilityId: "github.observe_pull_request_state",
      toolId: "github.observe_pull_request_state",
      sideEffectClass: input.sideEffectClass,
      declaredReceiptTypes: ["github.pull_request_state_checked"],
      declaredObservationTypes: ["github.pull_request_state"],
      idempotency:
        input.sideEffectClass === "read" || input.sideEffectClass === "compute"
          ? "not_required"
          : "required_for_writes",
      ...writeLifecycleFor(input.sideEffectClass),
      riskProfile: "standard",
    },
    execute: (request) => {
      input.calls.push(request.toolCommand);

      const receiptPayload = { checked: true };
      const receiptHash = canonicalObjectHash(receiptPayload);
      const observationHash = canonicalObjectHash(input.observedState);
      const receiptCandidate: ReceiptCandidate = {
        receiptId: `receipt_${request.effectRequest.effectId}`,
        effectId: request.effectRequest.effectId,
        runId: request.effectRequest.runId,
        capabilityId: request.effectRequest.capabilityId,
        receiptType: "github.pull_request_state_checked",
        status: "succeeded",
        payload: receiptPayload,
        payloadHash: receiptHash,
        evidence: [
          {
            evidenceId: `ev_receipt_${request.toolCommand.commandId}`,
            kind: "effect_receipt",
            admissionStatus: "pending",
            pendingAdmissionToken: `pending_ev_receipt_${request.toolCommand.commandId}`,
            hash: receiptHash,
            observedAt: input.observedAt,
            sensitivity: "internal",
          },
        ],
        observedAt: input.observedAt,
      };
      const externalStateObservationCandidate: ExternalStateObservationCandidate =
        {
          observationId: `obs_${request.toolCommand.commandId}`,
          runId: request.effectRequest.runId,
          observationType: "github.pull_request_state",
          subjectType: "pull_request",
          subjectId: "123",
          observedState: input.observedState,
          observedAt: input.observedAt,
          expiresAt: "2026-05-24T12:01:00.000Z",
          payloadHash: observationHash,
          evidence: [
            {
              evidenceId: `ev_obs_${request.toolCommand.commandId}`,
              kind: "external_observation",
              admissionStatus: "pending",
              pendingAdmissionToken: `pending_ev_obs_${request.toolCommand.commandId}`,
              hash: observationHash,
              observedAt: input.observedAt,
              sensitivity: "internal",
            },
          ],
        };

      return { receiptCandidate, externalStateObservationCandidate };
    },
  };
}

function writeLifecycleFor(sideEffectClass: SideEffectClass) {
  if (
    sideEffectClass === "read" ||
    sideEffectClass === "compute" ||
    sideEffectClass === "critical_write"
  ) {
    return {};
  }

  return {
    writeLifecycle: {
      preflight: "required_before_dispatch",
      idempotencyKey: "tool_command_required",
      dispatch: "broker_governed",
      outcome: "receipt_candidate_or_quarantine_required",
      forbiddenAuthority: [
        "receipt_admission",
        "proof_authority",
        "release_authority",
      ],
    },
  } as const;
}

function currentStateCapability(input: {
  readonly capabilityId: string;
  readonly sideEffectClass: SideEffectClass;
}): Capability {
  return {
    schemaVersion: 1,
    capabilityId: input.capabilityId,
    profile: "standard",
    sideEffectClass: input.sideEffectClass,
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    receiptSchema: {
      type: "object",
      additionalProperties: true,
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType: "github.pull_request_state_checked",
      },
      {
        evidenceKind: "external_observation",
        observationType: "github.pull_request_state",
      },
    ],
    supportedClaims: [
      {
        claimType: "current_state",
        predicateKind: "current_state",
        observationType: "github.pull_request_state",
      },
    ],
    proofRules: [],
  };
}

function effectEvidenceRef(input: {
  readonly commandId: string;
  readonly evidenceId: string;
  readonly hash: EvidenceRef["hash"];
}): EvidenceRef {
  return {
    admissionStatus: "admitted",
    evidenceId: input.evidenceId,
    kind: "effect_receipt",
    sourceEventId: `evt_${input.commandId}_receipt_recorded`,
    hash: input.hash,
    observedAt: NOW,
    sensitivity: "internal",
  };
}

function externalObservationEvidenceRef(input: {
  readonly commandId: string;
  readonly evidenceId: string;
  readonly hash: EvidenceRef["hash"];
  readonly observedAt: string;
}): EvidenceRef {
  return {
    admissionStatus: "admitted",
    evidenceId: input.evidenceId,
    kind: "external_observation",
    sourceEventId: `evt_${input.commandId}_external_state_observed`,
    hash: input.hash,
    observedAt: input.observedAt,
    sensitivity: "internal",
  };
}

function admitReceiptCandidate(
  receiptCandidate: ReceiptCandidate,
  sourceEventId: string,
): import("@amca/protocol").EffectReceipt {
  return {
    ...receiptCandidate,
    evidence: receiptCandidate.evidence.map((evidenceRef) =>
      admitEvidenceRef(evidenceRef, sourceEventId),
    ),
  };
}

function admitEvidenceRef(
  evidenceRef: PendingEvidenceRef,
  sourceEventId: string,
): EvidenceRef {
  const { admissionStatus, pendingAdmissionToken, ...admittedEvidence } =
    evidenceRef;
  void admissionStatus;
  void pendingAdmissionToken;

  return {
    ...admittedEvidence,
    admissionStatus: "admitted",
    sourceEventId,
  };
}

function eventTypes(harness: LocalRunHarness): RunEventType[] {
  return harness.kernel.events().map((event) => event.type);
}

function countEvents(harness: LocalRunHarness, type: RunEventType): number {
  return eventTypes(harness).filter((eventType) => eventType === type).length;
}

async function expectBrokerError(
  promise: Promise<unknown>,
  code: EffectBrokerError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "EffectBrokerError",
    code,
  });
}

function expectBrokerErrorSync(
  callback: () => unknown,
  code: EffectBrokerError["code"],
): void {
  expect(callback).toThrow(EffectBrokerError);
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({
      name: "EffectBrokerError",
      code,
    });
  }
}
