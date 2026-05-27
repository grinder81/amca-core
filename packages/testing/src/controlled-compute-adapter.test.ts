import type { CapabilityContract } from "@amca/capabilities";
import { createControlledComputeAdapter } from "@amca/adapters-tools";
import { EffectBrokerError, InMemoryEffectBroker } from "@amca/effect-broker";
import type { ReceiptCandidate, ToolCommandRequest } from "@amca/protocol";
import { describe, expect, it } from "vitest";

const NOW = "2026-05-25T13:00:00.000Z";
const receiptType = "test_run";

describe("createControlledComputeAdapter", () => {
  it("is rejected by broker defaults unless controlled_compute is explicitly allowed", async () => {
    const command = computeCommand("pass");

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [adapter()],
          capabilities: [capability()],
          clock: () => NOW,
        }),
      "adapter_certification_kind_forbidden",
    );

    await expect(broker().dispatch(command)).resolves.toMatchObject({
      receiptCandidate: {
        receiptType,
        status: "succeeded",
        payload: {
          result: "passed",
          profileId: "pass",
          testSuiteId: "controlled-compute",
          exitCode: 0,
        },
      },
    });
  });

  it("fails closed for unknown profiles and forbidden request overrides", async () => {
    const unknown = await broker().dispatch(computeCommand("missing"));
    expectFailure(unknown.receiptCandidate, "profile_not_found");

    const override = await broker().dispatch({
      ...computeCommand("pass"),
      args: {
        profileId: "pass",
        command: "rm",
      },
    });
    expectFailure(override.receiptCandidate, "forbidden_request_override");
  });

  it("records failed receipts for non-zero exits and timeouts", async () => {
    const failed = await broker().dispatch(computeCommand("fail"));
    expect(failed.receiptCandidate.status).toBe("failed");
    expect(failed.receiptCandidate.payload).toMatchObject({
      result: "failed",
      exitCode: 7,
      timedOut: false,
    });

    const timedOut = await broker().dispatch(computeCommand("timeout"));
    expectFailure(timedOut.receiptCandidate, "timed_out");
    expect(timedOut.receiptCandidate.payload.timedOut).toBe(true);
  });

  it("bounds and redacts stdout and stderr snippets", async () => {
    const result = await broker({
      maxOutputBytes: 20,
      redactions: ["alpha-secret"],
    }).dispatch(computeCommand("output"));

    expect(result.receiptCandidate.status).toBe("failed");
    expect(
      stringField(result.receiptCandidate.payload, "stdoutSnippet"),
    ).not.toContain("alpha-secret");
    expect(
      stringField(result.receiptCandidate.payload, "stderrSnippet"),
    ).not.toContain("TOKEN=beta");
    expect(result.receiptCandidate.payload.outputTruncated).toBe(true);
    expect(result.receiptCandidate.evidence).toEqual([
      expect.objectContaining({
        kind: "effect_receipt",
        hash: result.receiptCandidate.payloadHash,
        metadata: {
          redaction: "bounded_output",
        },
      }),
    ]);
    expect(result.receiptCandidate.evidence[0]).not.toHaveProperty(
      "sourceEventId",
    );
  });
});

function adapter(
  options: {
    readonly maxOutputBytes?: number;
    readonly redactions?: readonly string[];
  } = {},
) {
  return createControlledComputeAdapter({
    adapterId: "adapter.controlled.compute",
    capabilityId: "controlled.compute",
    toolId: "controlled.compute",
    receiptType,
    clock: () => NOW,
    timeoutMs: 150,
    profiles: [
      {
        profileId: "pass",
        command: process.execPath,
        args: ["-e", "console.log('tests passed')"],
      },
      {
        profileId: "fail",
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
      },
      {
        profileId: "timeout",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1000)"],
        timeoutMs: 30,
      },
      {
        profileId: "output",
        command: process.execPath,
        args: [
          "-e",
          "console.log('alpha-secret '.repeat(20)); console.error('TOKEN=beta '.repeat(20)); process.exit(1);",
        ],
      },
    ],
    ...(options.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.redactions === undefined
      ? {}
      : { redactions: options.redactions }),
  });
}

function broker(
  options: {
    readonly maxOutputBytes?: number;
    readonly redactions?: readonly string[];
  } = {},
): InMemoryEffectBroker {
  return new InMemoryEffectBroker({
    adapters: [adapter(options)],
    capabilities: [capability()],
    allowedAdapterKinds: ["controlled_compute"],
    clock: () => NOW,
  });
}

function capability(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: "controlled.compute",
    profile: "standard",
    sideEffectClass: "compute",
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
        receiptType,
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

function computeCommand(profileId: string): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `cmd_${profileId}`,
    runId: "run_controlled_compute_adapter",
    capabilityId: "controlled.compute",
    toolId: "controlled.compute",
    args: {
      profileId,
    },
    sideEffectClass: "compute",
  };
}

function expectFailure(receipt: ReceiptCandidate, reason: string): void {
  expect(receipt.status).toBe("failed");
  expect(receipt.payload).toMatchObject({
    result: "failed",
    reason,
  });
}

function stringField(
  payload: ReceiptCandidate["payload"],
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new Error(`Expected payload.${field} to be a string.`);
  }
  return value;
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
