import { describe, expect, it } from "vitest";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CapabilityContract } from "@amca/capabilities";
import { EffectBrokerError, InMemoryEffectBroker } from "@amca/effect-broker";
import type { EffectAdapter } from "@amca/effect-sdk";
import { LocalRunHarness } from "@amca/harness";
import { hashRunEventPayload } from "@amca/kernel";
import type {
  Claim,
  EffectReceipt,
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  PendingEvidenceRef,
  ReceiptCandidate,
  RunEventType,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";

import {
  eventTypes,
  FRESH_OBSERVED_AT,
  STARTED_AT,
  startedKernel,
} from "./mission-helpers.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const now = "2026-05-24T12:00:00.000Z";
const reevaluatedAt = "2026-05-24T12:01:00.000Z";
const harnessImportPattern =
  /(?:from\s+["']@amca\/harness(?:\/[^"']*)?["']|import\s+["']@amca\/harness(?:\/[^"']*)?["']|import\s*\(\s*["']@amca\/harness(?:\/[^"']*)?["'])/u;

describe("Mission governed run harness litmus", () => {
  it("releases only after broker receipts are admitted through the kernel", async () => {
    const fixture = testResultFixture({
      runId: "mission_harness_receipt_admitted",
      sideEffectClass: "compute",
    });
    const harness = startedHarness(fixture);

    const result = await harness.runToRelease({
      toolCommand: fixture.command,
      finalCandidate: fixture.finalCandidate,
      options: {
        finalCandidate: {
          generatedAt: now,
          occurredAt: now,
        },
      },
    });

    expect(result.finalCandidate.decision.status).toBe("released");
    expect(result.finalCandidate.proof.verdict).toBe("pass");
    expect(result.dispatch.effectReceiptEvent.payload.receipt.evidence).toEqual(
      fixture.finalCandidate.claims[0]?.evidenceRefs,
    );
    expect(fixture.calls).toHaveLength(1);
    expect(eventTypes(harness.kernel)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
  });

  it("blocks broker receipts that were never admitted into the kernel", async () => {
    const fixture = testResultFixture({
      runId: "mission_harness_unadmitted_broker_receipt",
      sideEffectClass: "compute",
    });
    const kernel = startedKernel(fixture.command.runId);
    const broker = new InMemoryEffectBroker({
      capabilities: [fixture.capability],
      adapters: [fixture.adapter],
      clock: () => now,
    });
    const proposalEvent = kernel.submitToolCommand(fixture.command);
    const dispatch = await broker.dispatch(fixture.command);

    kernel.recordEffectRequest(dispatch.effectRequest, {
      causationId: proposalEvent.eventId,
      occurredAt: dispatch.effectRequest.requestedAt,
    });
    const blocked = kernel.submitFinalCandidate(fixture.finalCandidate, {
      generatedAt: now,
      occurredAt: now,
    });

    expect(fixture.calls).toHaveLength(1);
    expect(kernel.effectReceipts()).toEqual([]);
    expect(blocked.decision.status).toBe("blocked");
    expect(blocked.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: fixture.claim.claimId,
        blocking: true,
      }),
    );
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("blocks direct adapter receipt bypass before broker-certified kernel admission", async () => {
    const fixture = testResultFixture({
      runId: "mission_harness_direct_adapter_bypass",
      sideEffectClass: "compute",
    });
    const kernel = startedKernel(fixture.command.runId);
    const effectRequest = {
      effectId: "effect_direct_adapter_bypass",
      commandId: fixture.command.commandId,
      runId: fixture.command.runId,
      capabilityId: fixture.command.capabilityId,
      toolId: fixture.command.toolId,
      args: fixture.command.args,
      sideEffectClass: fixture.command.sideEffectClass,
      requestedAt: FRESH_OBSERVED_AT,
    };
    const adapterResult = await fixture.adapter.execute(
      {
        toolCommand: fixture.command,
        effectRequest,
        capability: fixture.capability,
      },
      {
        now: () => now,
      },
    );
    const receiptCandidate = adapterResult.receiptCandidate;
    if (receiptCandidate === undefined) {
      throw new Error(
        "Direct adapter bypass test requires a receipt candidate.",
      );
    }
    expect(receiptCandidate.evidence[0]).not.toHaveProperty("sourceEventId");

    expect(() =>
      kernel.recordEffectReceipt(receiptCandidate as unknown as EffectReceipt, {
        eventId: receiptEventIdForCommand(fixture.command.commandId),
        occurredAt: receiptCandidate.observedAt,
      }),
    ).toThrow();
    expect(eventTypes(kernel)).toEqual(["RunStarted"]);
  });

  it("fails before adapter execution and receipt admission for unsafe writes", async () => {
    const write = testResultFixture({
      runId: "mission_harness_write_without_idempotency",
      sideEffectClass: "idempotent_write",
    });
    const writeHarness = startedHarness(write);

    await expectBrokerError(
      writeHarness.dispatchToolCommand(write.command),
      "idempotency_key_required",
    );
    expect(write.calls).toHaveLength(0);
    expect(eventTypes(writeHarness.kernel)).toEqual([
      "RunStarted",
      "ProposalReceived",
    ]);

    const critical = testResultFixture({
      runId: "mission_harness_critical_write",
      sideEffectClass: "critical_write",
      idempotencyKey: "critical-write-001",
    });

    expectBrokerErrorSync(
      () => startedHarness(critical),
      "critical_write_requires_approval",
    );
    expect(critical.calls).toHaveLength(0);
  });

  it("replays and re-evaluates without redispatching adapters", async () => {
    const fixture = testResultFixture({
      runId: "mission_harness_replay_no_redispatch",
      sideEffectClass: "compute",
    });
    const harness = startedHarness(fixture);

    await harness.runToRelease({
      toolCommand: fixture.command,
      finalCandidate: fixture.finalCandidate,
      options: {
        finalCandidate: {
          generatedAt: now,
          occurredAt: now,
        },
      },
    });
    const beforeReplay = eventTypes(harness.kernel);

    expect(harness.replay().events.map((event) => event.type)).toEqual(
      beforeReplay,
    );
    expect(fixture.calls).toHaveLength(1);

    const reevaluated = harness.reevaluateFinalCandidate(
      fixture.finalCandidate,
      {
        generatedAt: reevaluatedAt,
        occurredAt: reevaluatedAt,
      },
    );

    expect(reevaluated.decision.status).toBe("released");
    expect(fixture.calls).toHaveLength(1);
    expect(countEvents(harness.kernel, "EffectRequested")).toBe(1);
    expect(countEvents(harness.kernel, "EffectReceiptRecorded")).toBe(1);
  });

  it("keeps lower-level core packages independent from the harness", () => {
    for (const sourceFile of sourceFiles([
      path.join(repoRoot, "packages/protocol/src"),
      path.join(repoRoot, "packages/contracts/src"),
      path.join(repoRoot, "packages/proof/src"),
      path.join(repoRoot, "packages/effect-broker/src"),
      path.join(repoRoot, "packages/kernel/src"),
    ])) {
      const source = readFileSync(sourceFile, "utf8");
      expect(
        source,
        `${sourceFile} must not import harness authority.`,
      ).not.toMatch(harnessImportPattern);
    }
  });

  it("keeps the harness free of real execution and direct release hooks", () => {
    const forbiddenTokens = [
      "FinalReleased",
      "ReleaseDecided",
      "decideRelease",
      "child_process",
      "exec(",
      "execFile(",
      "spawn(",
      "fetch(",
    ];

    for (const sourceFile of sourceFiles([
      path.join(repoRoot, "packages/harness/src"),
    ])) {
      const source = readFileSync(sourceFile, "utf8");
      for (const token of forbiddenTokens) {
        expect(source, `${sourceFile} must not contain ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});

interface TestResultFixture {
  readonly command: ToolCommandRequest;
  readonly capability: CapabilityContract;
  readonly adapter: EffectAdapter;
  readonly finalCandidate: FinalCandidate;
  readonly claim: Claim;
  readonly calls: ToolCommandRequest[];
}

function startedHarness(fixture: TestResultFixture): LocalRunHarness {
  const harness = new LocalRunHarness({
    runId: fixture.command.runId,
    clock: () => now,
    brokerOptions: {
      capabilities: [fixture.capability],
      adapters: [fixture.adapter],
      clock: () => now,
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
  const capabilityId = "mission.harness.run_tests";
  const toolId = "mission.harness.run_tests";
  const commandId = `cmd_${input.runId}`;
  const payload = {
    result: input.result ?? "passed",
    testSuiteId: "mission",
  };
  const evidenceRef = effectEvidenceRef({
    commandId,
    evidenceId: `ev_${commandId}`,
    hash: hashRunEventPayload(payload),
  });
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId,
    runId: input.runId,
    capabilityId,
    toolId,
    args: {
      testSuiteId: "mission",
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
      testSuiteId: "mission",
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
}): EffectAdapter {
  return {
    adapterId: "adapter.mission.harness.run_tests",
    capabilityId: "mission.harness.run_tests",
    toolId: "mission.harness.run_tests",
    certification: {
      certificationVersion: 1,
      adapterId: "adapter.mission.harness.run_tests",
      adapterKind: "deterministic_fake",
      capabilityId: "mission.harness.run_tests",
      toolId: "mission.harness.run_tests",
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

      const payloadHash = hashRunEventPayload(input.payload);
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
          pendingEvidenceRef({
            evidenceId: `ev_${request.toolCommand.commandId}`,
            kind: "effect_receipt",
            hash: payloadHash,
            observedAt: now,
            sensitivity: "internal",
          }),
        ],
        observedAt: now,
      };

      return { receiptCandidate };
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

function pendingEvidenceRef(
  input: Omit<PendingEvidenceRef, "admissionStatus" | "pendingAdmissionToken">,
): PendingEvidenceRef {
  return {
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${input.evidenceId}`,
    ...input,
  };
}

function testResultCapability(input: {
  readonly capabilityId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly receiptType: string;
}): CapabilityContract {
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

function effectEvidenceRef(input: {
  readonly commandId: string;
  readonly evidenceId: string;
  readonly hash: EvidenceRef["hash"];
}): EvidenceRef {
  return {
    admissionStatus: "admitted",
    evidenceId: input.evidenceId,
    kind: "effect_receipt",
    sourceEventId: receiptEventIdForCommand(input.commandId),
    hash: input.hash,
    observedAt: now,
    sensitivity: "internal",
  };
}

function receiptEventIdForCommand(commandId: string): string {
  return `evt_${commandId.replace(/[^A-Za-z0-9_-]/gu, "_")}_receipt_recorded`;
}

function countEvents(
  kernel: LocalRunHarness["kernel"],
  type: RunEventType,
): number {
  return eventTypes(kernel).filter((eventType) => eventType === type).length;
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

function sourceFiles(directories: readonly string[]): string[] {
  return directories
    .filter((directory) => existsSync(directory))
    .flatMap((directory) =>
      readdirSync(directory).flatMap((entry) => {
        const entryPath = path.join(directory, entry);
        const entryStat = statSync(entryPath);

        if (entryStat.isDirectory()) {
          return sourceFiles([entryPath]);
        }

        if (!entryStat.isFile() || entryPath.endsWith(".test.ts")) {
          return [];
        }

        return [entryPath];
      }),
    )
    .sort();
}
