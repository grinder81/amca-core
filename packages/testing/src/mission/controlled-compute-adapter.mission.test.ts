import { describe, expect, it } from "vitest";

import type { CapabilityContract } from "@amca/capabilities";
import {
  EffectBrokerError,
  type EffectDispatchResult,
  InMemoryEffectBroker,
} from "@amca/effect-broker";
import type { EffectAdapter } from "@amca/effect-sdk";
import { LocalRunHarness } from "@amca/harness";
import type {
  Claim,
  FinalCandidate,
  JsonObject,
  JsonValue,
  ReceiptCandidate,
  ToolCommandRequest,
} from "@amca/protocol";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { eventTypes, GENERATED_AT, STARTED_AT } from "./mission-helpers.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const adapterModuleUrl = pathToFileURL(
  path.join(repoRoot, "packages/adapters-tools/src/index.ts"),
).href;

const now = "2026-05-24T12:00:00.000Z";
const reevaluatedAt = "2026-05-24T12:01:00.000Z";
const capabilityId = "amca.controlled_compute.run_profile";
const toolId = "controlled_compute.run_profile";
const receiptType = "test_run";
const testSuiteId = "controlled-compute";
const stdoutSecret = "amca-secret-stdout-token";
const stderrSecret = "amca-secret-stderr-token";
const environmentSecret = "amca-secret-parent-environment-token";
const maliciousMarker = "AMCA_MALICIOUS_REQUEST_COMMAND_RAN";

describe("Mission controlled compute adapter conformance", () => {
  it("rejects controlled_compute adapters by broker default unless explicitly allowed", async () => {
    await withControlledComputeFixture(async (fixture) => {
      expect(
        () =>
          new InMemoryEffectBroker({
            adapters: [fixture.adapter],
            capabilities: [fixture.capability],
            clock: () => now,
          }),
      ).toThrow(EffectBrokerError);

      const broker = allowedBroker(fixture);
      await expect(
        broker.dispatch(fixture.command("pass")),
      ).resolves.toMatchObject({
        status: "dispatched",
        receiptCandidate: {
          receiptType,
          status: "succeeded",
          payload: {
            result: "passed",
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
          },
        },
      });
    });
  });

  it("allows only configured static profile IDs and ignores or rejects arbitrary request commands", async () => {
    await withControlledComputeFixture(async (fixture) => {
      const broker = allowedBroker(fixture);

      await expectNotSuccessfulEvidence(
        broker.dispatch(
          fixture.command("unregistered-profile", {
            command: process.execPath,
            args: ["-e", `console.log("${maliciousMarker}")`],
            shell: `echo ${maliciousMarker}`,
          }),
        ),
      );

      await expectRequestCommandIgnoredOrRejected(
        broker.dispatch(
          fixture.command("pass", {
            command: process.execPath,
            args: ["-e", `console.log("${maliciousMarker}")`],
            shell: `echo ${maliciousMarker}`,
          }),
        ),
      );
    });
  });

  it("produces bounded redacted test_run receipts for passed and failed static profiles", async () => {
    await withControlledComputeFixture(async (fixture) => {
      const broker = allowedBroker(fixture);

      const passed = await broker.dispatch(fixture.command("pass"));
      expect(passed.receiptCandidate).toMatchObject({
        receiptType,
        status: "succeeded",
        payload: {
          result: "passed",
          profileId: "pass",
          testSuiteId,
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        },
      });
      expectReceiptCandidateEvidence(passed.receiptCandidate);

      const failed = await broker.dispatch(fixture.command("fail"));
      expect(failed.receiptCandidate).toMatchObject({
        receiptType,
        status: "failed",
        payload: {
          result: "failed",
          profileId: "fail",
          testSuiteId,
          exitCode: 7,
          timedOut: false,
        },
      });
      expectReceiptCandidateEvidence(failed.receiptCandidate);

      for (const receipt of [
        passed.receiptCandidate,
        failed.receiptCandidate,
      ]) {
        const serialized = JSON.stringify(receipt.payload);
        expect(serialized).not.toContain(stdoutSecret);
        expect(serialized).not.toContain(stderrSecret);
        expect(snippet(receipt, "stdoutSnippet").length).toBeLessThanOrEqual(
          96,
        );
        expect(snippet(receipt, "stderrSnippet").length).toBeLessThanOrEqual(
          96,
        );
      }
    });
  });

  it("records timeout as a failed receipt instead of successful evidence", async () => {
    await withControlledComputeFixture(async (fixture) => {
      const result = await allowedBroker(fixture).dispatch(
        fixture.command("timeout"),
      );

      expect(result.receiptCandidate).toMatchObject({
        receiptType,
        status: "failed",
        payload: {
          result: "failed",
          profileId: "timeout",
          testSuiteId,
          timedOut: true,
        },
      });
      expectReceiptCandidateEvidence(result.receiptCandidate);
    });
  });

  it("does not inherit parent process environment by default", async () => {
    const priorSecret = process.env.AMCA_CONTROLLED_COMPUTE_SECRET;
    process.env.AMCA_CONTROLLED_COMPUTE_SECRET = environmentSecret;

    try {
      await withControlledComputeFixture(async (fixture) => {
        const result = await allowedBroker(fixture).dispatch(
          fixture.command("env-leak"),
        );

        expect(result.receiptCandidate.status).toBe("succeeded");
        expect(
          jsonContains(result.receiptCandidate.payload, environmentSecret),
        ).toBe(false);
        expect(snippet(result.receiptCandidate, "stdoutSnippet")).toContain(
          "missing",
        );
      });
    } finally {
      if (priorSecret === undefined) {
        delete process.env.AMCA_CONTROLLED_COMPUTE_SECRET;
      } else {
        process.env.AMCA_CONTROLLED_COMPUTE_SECRET = priorSecret;
      }
    }
  });

  it("replays and re-evaluates from admitted events without redispatching compute", async () => {
    await withControlledComputeFixture(async (fixture) => {
      const counted = adapterWithExecutionCount(fixture.adapter);
      const harness = new LocalRunHarness({
        runId: fixture.runId,
        clock: () => now,
        brokerOptions: {
          adapters: [counted.adapter],
          capabilities: [fixture.capability],
          allowedAdapterKinds: ["controlled_compute"],
          clock: () => now,
        },
      });
      harness.startRun({
        occurredAt: STARTED_AT,
        profile: "standard",
      });

      const dispatch = await harness.dispatchToolCommand(
        fixture.command("pass"),
      );
      const evidenceRef = dispatch.recordedReceipt.evidence[0];
      if (evidenceRef === undefined) {
        throw new Error(
          "controlled_compute adapter receipt must carry first-class evidence.",
        );
      }

      const finalCandidate = candidateWith(
        fixture.runId,
        testResultClaim(evidenceRef),
      );
      const released = harness.submitFinalCandidate(finalCandidate, {
        generatedAt: GENERATED_AT,
        occurredAt: GENERATED_AT,
      });
      const beforeReplay = eventTypes(harness.kernel);

      expect(released.decision.status).toBe("released");
      expect(harness.replay().events.map((event) => event.type)).toEqual(
        beforeReplay,
      );
      expect(counted.calls()).toBe(1);

      const reevaluated = harness.reevaluateFinalCandidate(finalCandidate, {
        generatedAt: reevaluatedAt,
        occurredAt: reevaluatedAt,
      });

      expect(reevaluated.decision.status).toBe("released");
      expect(counted.calls()).toBe(1);
      expect(
        eventTypes(harness.kernel).filter((type) => type === "EffectRequested"),
      ).toHaveLength(1);
      expect(
        eventTypes(harness.kernel).filter(
          (type) => type === "EffectReceiptRecorded",
        ),
      ).toHaveLength(1);
    });
  });
});

interface ControlledComputeProfile {
  readonly profileId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

interface ControlledComputeAdapterFactoryInput {
  readonly adapterId?: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly receiptType: string;
  readonly profiles: readonly ControlledComputeProfile[];
  readonly maxOutputSnippetBytes: number;
  readonly redactions: readonly string[];
  readonly clock: () => string;
}

interface ControlledComputeAdapterModule {
  readonly createControlledComputeAdapter: (
    input: ControlledComputeAdapterFactoryInput,
  ) => EffectAdapter;
}

interface ControlledComputeFixture {
  readonly adapter: EffectAdapter;
  readonly capability: CapabilityContract;
  readonly runId: string;
  readonly command: (
    profileId: string,
    args?: JsonObject,
  ) => ToolCommandRequest;
}

async function withControlledComputeFixture(
  callback: (fixture: ControlledComputeFixture) => Promise<void>,
): Promise<void> {
  const module = await loadControlledComputeAdapterModule();
  const runId = `mission_controlled_compute_${String(Date.now())}`;
  const adapter = module.createControlledComputeAdapter({
    adapterId: "adapter.amca.controlled_compute.run_profile",
    capabilityId,
    toolId,
    receiptType,
    profiles: [
      {
        profileId: "pass",
        command: process.execPath,
        args: [
          "-e",
          `console.log("AMCA static profile passed ${stdoutSecret}"); console.error("stderr ${stderrSecret}")`,
        ],
        timeoutMs: 2_000,
      },
      {
        profileId: "fail",
        command: process.execPath,
        args: [
          "-e",
          `console.log("AMCA static profile failed ${stdoutSecret}"); console.error("failure ${stderrSecret}"); process.exit(7)`,
        ],
        timeoutMs: 2_000,
      },
      {
        profileId: "timeout",
        command: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 10_000)"],
        timeoutMs: 25,
      },
      {
        profileId: "env-leak",
        command: process.execPath,
        args: [
          "-e",
          "console.log(process.env.AMCA_CONTROLLED_COMPUTE_SECRET ?? 'missing')",
        ],
        timeoutMs: 2_000,
      },
    ],
    maxOutputSnippetBytes: 96,
    redactions: [stdoutSecret, stderrSecret],
    clock: () => now,
  });

  await callback({
    adapter,
    capability: controlledComputeCapability(),
    command: (profileId, args = {}) =>
      controlledComputeCommand(runId, profileId, args),
    runId,
  });
}

async function loadControlledComputeAdapterModule(): Promise<ControlledComputeAdapterModule> {
  let module: unknown;
  try {
    module = await import(adapterModuleUrl);
  } catch (error) {
    throw new Error(
      `Phase 19 controlled_compute adapter conformance requires ${adapterModuleUrl}. Baseline is expected to fail until the governed controlled compute adapter is added. ${String(error)}`,
      { cause: error },
    );
  }

  if (
    typeof module !== "object" ||
    module === null ||
    !("createControlledComputeAdapter" in module) ||
    typeof module.createControlledComputeAdapter !== "function"
  ) {
    throw new Error(
      "packages/adapters-tools must export createControlledComputeAdapter(input): EffectAdapter.",
    );
  }

  return module as ControlledComputeAdapterModule;
}

function allowedBroker(
  fixture: ControlledComputeFixture,
): InMemoryEffectBroker {
  return new InMemoryEffectBroker({
    adapters: [fixture.adapter],
    capabilities: [fixture.capability],
    allowedAdapterKinds: ["controlled_compute"],
    clock: () => now,
  });
}

async function expectNotSuccessfulEvidence(
  dispatch: Promise<EffectDispatchResult>,
): Promise<void> {
  try {
    const result = await dispatch;
    expect(result.receiptCandidate.status).not.toBe("succeeded");
    expect(result.receiptCandidate.payload).toMatchObject({
      result: "failed",
    });
  } catch (error) {
    expect(error).toBeInstanceOf(EffectBrokerError);
  }
}

async function expectRequestCommandIgnoredOrRejected(
  dispatch: Promise<EffectDispatchResult>,
): Promise<void> {
  try {
    const result = await dispatch;
    expect(jsonContains(result.receiptCandidate.payload, maliciousMarker)).toBe(
      false,
    );
    if (result.receiptCandidate.status === "succeeded") {
      expect(result.receiptCandidate.payload).toMatchObject({
        result: "passed",
        profileId: "pass",
      });
      expect(snippet(result.receiptCandidate, "stdoutSnippet")).toContain(
        "AMCA static profile passed",
      );
    } else {
      expect(result.receiptCandidate.payload).toMatchObject({
        result: "failed",
      });
    }
  } catch (error) {
    expect(error).toBeInstanceOf(EffectBrokerError);
  }
}

function controlledComputeCapability(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId,
    profile: "standard",
    sideEffectClass: "compute",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string" },
      },
      required: ["profileId"],
      additionalProperties: false,
    },
    receiptSchema: {
      type: "object",
      properties: {
        result: { enum: ["passed", "failed"] },
        profileId: { type: "string" },
        testSuiteId: { type: "string" },
        exitCode: { type: ["number", "null"] },
        timedOut: { type: "boolean" },
        outputTruncated: { type: "boolean" },
        stdoutSnippet: { type: "string" },
        stderrSnippet: { type: "string" },
      },
      required: [
        "result",
        "profileId",
        "testSuiteId",
        "exitCode",
        "timedOut",
        "outputTruncated",
        "stdoutSnippet",
        "stderrSnippet",
      ],
      additionalProperties: false,
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType,
      },
    ],
    supportedClaims: [
      {
        claimType: "test_result",
        predicateKind: "test_result",
        requiredReceiptType: receiptType,
        expectedStatuses: ["passed", "failed"],
      },
    ],
    proofRules: [],
    metadata: {
      authorityBoundary: "governed_controlled_compute",
    },
  };
}

function controlledComputeCommand(
  runId: string,
  profileId: string,
  args: JsonObject,
): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `command_controlled_compute_${sanitizeId(profileId)}`,
    runId,
    capabilityId,
    toolId,
    args: {
      profileId,
      ...args,
    },
    sideEffectClass: "compute",
  };
}

function testResultClaim(evidenceRef: Claim["evidenceRefs"][number]): Claim {
  return {
    claimId: "claim_controlled_compute_tests_passed",
    type: "test_result",
    statement: "Controlled compute tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId,
      expectedStatus: "passed",
      requiredReceiptType: receiptType,
      testSuiteId,
    },
    evidenceRefs: [evidenceRef],
    criticality: "medium",
  };
}

function candidateWith(runId: string, claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${claim.claimId}`,
    runId,
    claims: [claim],
  };
}

function adapterWithExecutionCount(adapter: EffectAdapter): {
  readonly adapter: EffectAdapter;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    adapter: {
      ...adapter,
      execute: async (request, context) => {
        calls += 1;
        return adapter.execute(request, context);
      },
    },
    calls: () => calls,
  };
}

function expectReceiptCandidateEvidence(receipt: ReceiptCandidate): void {
  expect(receipt.evidence).toEqual([
    expect.objectContaining({
      hash: receipt.payloadHash,
      kind: "effect_receipt",
      sensitivity: "internal",
    }),
  ]);
  expect(receipt.evidence[0]).not.toHaveProperty("sourceEventId");
}

function snippet(receipt: ReceiptCandidate, field: string): string {
  const value = receipt.payload[field];
  if (typeof value !== "string") {
    throw new Error(`Expected receipt payload ${field} to be a string.`);
  }
  return value;
}

function jsonContains(value: JsonValue, needle: string): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => jsonContains(item, needle));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => jsonContains(item, needle));
  }
  return false;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
