import { execPath } from "node:process";

import type {
  CertifiedEffectRequest,
  EffectAdapterResult,
} from "@amca/effect-sdk";
import type { JsonObject } from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { createControlledComputeAdapter } from "./controlled-compute-adapter.js";

const observedAt = "2026-05-24T12:00:00.000Z";
const runId = "run_controlled_compute_contract";
const capabilityId = "amca.controlled_compute.run_profile";
const toolId = "controlled_compute.run_profile";
const receiptType = "test_run";

describe("controlled_compute adapter contract", () => {
  it("certifies compute authority and emits a receipt candidate with pending evidence", async () => {
    const adapter = createControlledComputeAdapter({
      adapterId: "adapter.amca.controlled_compute.run_profile",
      capabilityId,
      toolId,
      profiles: [
        {
          profileId: "unit",
          command: execPath,
          args: [
            "-e",
            "console.log('phase34-ok'); console.error('api_key=supersecret')",
          ],
        },
      ],
      clock: () => observedAt,
    });

    const result = await adapter.execute(requestFor({ profileId: "unit" }), {
      now: () => observedAt,
    });
    const receiptCandidate = requiredReceiptCandidate(result);

    expect(adapter.certification).toMatchObject({
      adapterKind: "controlled_compute",
      sideEffectClass: "compute",
      idempotency: "not_required",
      declaredReceiptTypes: [receiptType],
    });
    expect(receiptCandidate.status).toBe("succeeded");
    expect(receiptCandidate.payload).toMatchObject({
      result: "passed",
      profileId: "unit",
      testSuiteId: "controlled-compute",
      exitCode: 0,
    });
    expect(JSON.stringify(result)).not.toContain("supersecret");
    expect(receiptCandidate.evidence).toEqual([
      expect.objectContaining({
        kind: "effect_receipt",
        admissionStatus: "pending",
        hash: receiptCandidate.payloadHash,
        metadata: {
          redaction: "bounded_output",
        },
      }),
    ]);
    expect(typeof receiptCandidate.evidence[0]?.pendingAdmissionToken).toBe(
      "string",
    );
    expect(receiptCandidate.evidence[0]).not.toHaveProperty("sourceEventId");
  });

  it("preserves restricted profile semantics by rejecting request-level command overrides", async () => {
    const adapter = createControlledComputeAdapter({
      adapterId: "adapter.amca.controlled_compute.run_profile",
      capabilityId,
      toolId,
      profiles: [
        {
          profileId: "unit",
          command: execPath,
          args: ["-e", "console.log('should-not-run')"],
        },
      ],
      clock: () => observedAt,
    });

    const result = await adapter.execute(
      requestFor({ profileId: "unit", command: "echo bypass" }),
      { now: () => observedAt },
    );
    const receiptCandidate = requiredReceiptCandidate(result);

    expect(receiptCandidate.status).toBe("failed");
    expect(receiptCandidate.payload).toMatchObject({
      result: "failed",
      profileId: "unit",
      reason: "forbidden_request_override",
    });
    expect(receiptCandidate.evidence[0]).toMatchObject({
      admissionStatus: "pending",
    });
    expect(typeof receiptCandidate.evidence[0]?.pendingAdmissionToken).toBe(
      "string",
    );
    expect(receiptCandidate.evidence[0]).not.toHaveProperty("sourceEventId");
  });
});

function requestFor(args: JsonObject): CertifiedEffectRequest {
  return {
    toolCommand: {
      kind: "tool_command_request",
      commandId: "command_controlled_compute",
      runId,
      capabilityId,
      toolId,
      args,
      sideEffectClass: "compute",
    },
    effectRequest: {
      effectId: "effect_controlled_compute",
      commandId: "command_controlled_compute",
      runId,
      capabilityId,
      toolId,
      args,
      sideEffectClass: "compute",
      requestedAt: observedAt,
    },
    capability: {
      schemaVersion: 1,
      capabilityId,
      profile: "standard",
      sideEffectClass: "compute",
      inputSchema: {
        type: "object",
      },
      receiptSchema: {
        type: "object",
      },
      evidence: [
        {
          evidenceKind: "effect_receipt",
          receiptType,
        },
      ],
      supportedClaims: [],
      proofRules: [],
    },
  };
}

function requiredReceiptCandidate(
  result: EffectAdapterResult,
): NonNullable<EffectAdapterResult["receiptCandidate"]> {
  if (result.receiptCandidate === undefined) {
    throw new Error(
      "Expected controlled_compute adapter to emit a receipt candidate.",
    );
  }
  return result.receiptCandidate;
}
