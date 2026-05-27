import { createHash } from "node:crypto";

import {
  createShellCommandAdapter,
  ShellCommandAdapterConfigError,
} from "@amca/adapters-tools";
import type { CapabilityContract } from "@amca/capabilities";
import { EffectBrokerError, InMemoryEffectBroker } from "@amca/effect-broker";
import { InMemoryRunKernel } from "@amca/kernel";
import type {
  Claim,
  EffectReceipt,
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  ReceiptCandidate,
  ToolCommandRequest,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

const observedAt = "2026-05-25T12:00:00.000Z";
const generatedAt = "2026-05-25T12:00:01.000Z";
const capabilityId = "amca.shell.run_profile";
const toolId = "shell.run_profile";
const receiptType = "shell.command_executed";
const secret = "phase50-mission-secret";
const maliciousMarker = "PHASE50_MALICIOUS_COMMAND_RAN";

describe("Mission shell adapter conformance", () => {
  it("requires explicit broker opt-in before bounded local process execution", async () => {
    const fixture = shellFixture();

    expect(
      () =>
        new InMemoryEffectBroker({
          adapters: [fixture.adapter],
          capabilities: [fixture.capability],
          clock: () => observedAt,
        }),
    ).toThrow(EffectBrokerError);

    await expect(
      allowedBroker(fixture).dispatch(fixture.command("pass")),
    ).resolves.toMatchObject({
      status: "dispatched",
      receiptCandidate: {
        status: "succeeded",
        receiptType,
        payload: {
          result: "succeeded",
          profileId: "pass",
          redaction: "output_hash_only",
        },
      },
    });
  });

  it("shell-string-command-blocked", async () => {
    const fixture = shellFixture();
    const result = await allowedBroker(fixture).dispatch(
      fixture.command("pass", {
        command: `${process.execPath} -e "console.log('${maliciousMarker}')"`,
      }),
    );

    expect(result.receiptCandidate.status).toBe("failed");
    expect(result.receiptCandidate.payload).toMatchObject({
      result: "failed",
      profileId: "pass",
      reason: "forbidden_request_field",
    });
    expect(JSON.stringify(result.receiptCandidate.payload)).not.toContain(
      maliciousMarker,
    );
  });

  it("shell-true-blocked", async () => {
    const fixture = shellFixture();
    const result = await allowedBroker(fixture).dispatch(
      fixture.command("pass", {
        shell: true,
      }),
    );

    expect(result.receiptCandidate.status).toBe("failed");
    expect(result.receiptCandidate.payload).toMatchObject({
      result: "failed",
      reason: "forbidden_request_field",
    });
  });

  it("unallowlisted-executable-blocked", async () => {
    const fixture = shellFixture();
    const result = await allowedBroker(fixture).dispatch(
      fixture.command("not-registered"),
    );

    expect(result.receiptCandidate.status).toBe("failed");
    expect(result.receiptCandidate.payload).toMatchObject({
      result: "failed",
      profileId: "not-registered",
      reason: "profile_not_found",
    });
  });

  it("timeout-quarantines-or-fails-closed", async () => {
    const fixture = shellFixture();
    const result = await allowedBroker(fixture).dispatch(
      fixture.command("timeout"),
    );

    expect(result.receiptCandidate.status).toBe("failed");
    expect(result.receiptCandidate.payload).toMatchObject({
      result: "failed",
      profileId: "timeout",
      timedOut: true,
      reason: "timed_out",
    });
  });

  it("oversized-output-redacted-and-bounded", async () => {
    const fixture = shellFixture();
    const result = await allowedBroker(fixture).dispatch(
      fixture.command("large-output"),
    );

    expect(result.receiptCandidate.status).toBe("failed");
    expect(result.receiptCandidate.payload).toMatchObject({
      result: "failed",
      profileId: "large-output",
      outputTruncated: true,
      reason: "output_limit_exceeded",
      redaction: "output_hash_only",
    });
    expect(
      numberField(result.receiptCandidate.payload, "stdoutBytes"),
    ).toBeLessThanOrEqual(16);
    expect(JSON.stringify(result)).not.toContain("XXXXXXXXXXXXXXXX");
  });

  it("env-secret-not-leaked", async () => {
    const priorSecret = process.env.AMCA_PHASE50_MISSION_SECRET;
    process.env.AMCA_PHASE50_MISSION_SECRET = secret;

    try {
      const fixture = shellFixture();
      const result = await allowedBroker(fixture).dispatch(
        fixture.command("env-check"),
      );

      expect(result.receiptCandidate.status).toBe("succeeded");
      expect(result.receiptCandidate.payload).toMatchObject({
        stdoutHash: sha256("missing\n"),
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      if (priorSecret === undefined) {
        delete process.env.AMCA_PHASE50_MISSION_SECRET;
      } else {
        process.env.AMCA_PHASE50_MISSION_SECRET = priorSecret;
      }
    }
  });

  it("nonzero-exit-failed-receipt-candidate", async () => {
    const fixture = shellFixture();
    const result = await allowedBroker(fixture).dispatch(
      fixture.command("nonzero"),
    );

    expect(result.receiptCandidate.status).toBe("failed");
    expect(result.receiptCandidate.payload).toMatchObject({
      result: "failed",
      profileId: "nonzero",
      exitCode: 9,
      timedOut: false,
      outputTruncated: false,
      redaction: "output_hash_only",
    });
  });

  it("shell-adapter-rejects-network-capable-profile-without-network-certification", () => {
    expect(() =>
      createShellCommandAdapter({
        adapterId: "adapter.amca.shell.network_read",
        capabilityId,
        toolId,
        rootDir: process.cwd(),
        profiles: [
          {
            profileId: "network-read",
            profileClass: "network_read",
            executablePath: process.execPath,
            args: ["-e", "process.stdout.write('network')"],
          },
        ],
        clock: () => observedAt,
      }),
    ).toThrow(ShellCommandAdapterConfigError);
  });

  it("shell-adapter-rejects-write-producing-profile-without-write-certification", () => {
    expect(() =>
      createShellCommandAdapter({
        adapterId: "adapter.amca.shell.filesystem_write",
        capabilityId,
        toolId,
        rootDir: process.cwd(),
        profiles: [
          {
            profileId: "filesystem-write",
            profileClass: "filesystem_write",
            executablePath: process.execPath,
            args: ["-e", "process.stdout.write('write')"],
          },
        ],
        clock: () => observedAt,
      }),
    ).toThrow(ShellCommandAdapterConfigError);
  });

  it("adapter-output-cannot-support-proof-before-admission", async () => {
    const fixture = shellFixture();
    const dispatch = await allowedBroker(fixture).dispatch(
      fixture.command("pass"),
    );
    const pendingEvidence = dispatch.receiptCandidate.evidence[0];
    if (pendingEvidence === undefined) {
      throw new Error("Shell receipt candidate must include pending evidence.");
    }

    const kernel = new InMemoryRunKernel({ runId: fixture.runId });
    kernel.startRun({ occurredAt: observedAt });
    kernel.recordEffectRequest(dispatch.effectRequest);

    const blocked = kernel.submitFinalCandidate(
      finalCandidate(
        fixture.runId,
        historicalClaim({
          evidenceRefs: [
            {
              evidenceId: pendingEvidence.evidenceId,
              kind: pendingEvidence.kind,
              sourceEventId: pendingEvidence.pendingAdmissionToken,
              hash: pendingEvidence.hash,
              observedAt: pendingEvidence.observedAt,
              sensitivity: pendingEvidence.sensitivity,
              ...(pendingEvidence.metadata === undefined
                ? {}
                : { metadata: pendingEvidence.metadata }),
            },
          ],
        }),
      ),
      { generatedAt, occurredAt: generatedAt },
    );

    expect(blocked.decision.status).toBe("blocked");
    expect(blocked.proof.blockingMismatches.length).toBeGreaterThan(0);

    const admittedReceiptEventId = "evt_phase50_shell_receipt_admitted";
    const admittedEvidence = admitReceiptEvidence(
      dispatch.receiptCandidate,
      admittedReceiptEventId,
    );
    const admittedReceipt: EffectReceipt = {
      ...dispatch.receiptCandidate,
      evidence: admittedEvidence,
    };
    kernel.recordEffectReceipt(admittedReceipt, {
      eventId: admittedReceiptEventId,
      occurredAt: observedAt,
    });

    const released = kernel.submitFinalCandidate(
      finalCandidate(
        fixture.runId,
        historicalClaim({
          evidenceRefs: [...admittedEvidence],
        }),
      ),
      { generatedAt, occurredAt: generatedAt },
    );

    expect(released.decision.status).toBe("released");
  });
});

interface ShellFixture {
  readonly adapter: ReturnType<typeof createShellCommandAdapter>;
  readonly capability: CapabilityContract;
  readonly runId: string;
  readonly command: (
    profileId: string,
    args?: JsonObject,
  ) => ToolCommandRequest;
}

function shellFixture(): ShellFixture {
  const runId = `mission_phase50_shell_${String(Date.now())}`;
  return {
    adapter: createShellCommandAdapter({
      adapterId: "adapter.amca.shell.run_profile",
      capabilityId,
      toolId,
      rootDir: process.cwd(),
      profiles: [
        {
          profileId: "pass",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: ["-e", "process.stdout.write('pass')"],
        },
        {
          profileId: "timeout",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: ["-e", "setTimeout(() => undefined, 10_000)"],
          timeoutMs: 25,
        },
        {
          profileId: "large-output",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: ["-e", "process.stdout.write('X'.repeat(1024))"],
          maxOutputBytes: 16,
        },
        {
          profileId: "env-check",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: [
            "-e",
            "console.log(process.env.AMCA_PHASE50_MISSION_SECRET ?? 'missing')",
          ],
        },
        {
          profileId: "nonzero",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: ["-e", "process.exit(9)"],
        },
      ],
      clock: () => observedAt,
    }),
    capability: shellCapability(),
    command: (profileId, args = {}) => ({
      kind: "tool_command_request",
      commandId: `command_shell_${sanitizeId(profileId)}`,
      runId,
      capabilityId,
      toolId,
      args: {
        profileId,
        ...args,
      },
      sideEffectClass: "compute",
    }),
    runId,
  };
}

function allowedBroker(fixture: ShellFixture): InMemoryEffectBroker {
  return new InMemoryEffectBroker({
    adapters: [fixture.adapter],
    capabilities: [fixture.capability],
    allowedAdapterKinds: ["controlled_compute"],
    clock: () => observedAt,
  });
}

function shellCapability(): CapabilityContract {
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
        result: { enum: ["succeeded", "failed"] },
        profileId: { type: "string" },
        actionVerb: { const: "executed" },
        subjectType: { const: "shell_profile" },
        targetType: { const: "local_process" },
        exitCode: { type: ["number", "null"] },
        timedOut: { type: "boolean" },
        outputTruncated: { type: "boolean" },
        stdoutHash: { type: "string" },
        stderrHash: { type: "string" },
        redaction: { const: "output_hash_only" },
      },
      required: [
        "result",
        "profileId",
        "actionVerb",
        "subjectType",
        "targetType",
        "exitCode",
        "timedOut",
        "outputTruncated",
        "stdoutHash",
        "stderrHash",
        "redaction",
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
        claimType: "historical_action",
        predicateKind: "historical_action",
        requiredReceiptType: receiptType,
      },
    ],
    proofRules: [],
    metadata: {
      authorityBoundary: "governed_shell_command",
    },
  };
}

function finalCandidate(runId: string, claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${claim.claimId}`,
    runId,
    claims: [claim],
  };
}

function historicalClaim(input: {
  readonly evidenceRefs: readonly EvidenceRef[];
}): Claim {
  return {
    claimId: "claim_shell_profile_executed",
    type: "historical_action",
    statement: "The allowlisted shell profile executed.",
    predicate: {
      kind: "historical_action",
      actionVerb: "executed",
      subjectType: "shell_profile",
      subjectId: "pass",
      targetType: "local_process",
      targetId: "pass",
      capabilityId,
      requiredReceiptType: receiptType,
    },
    evidenceRefs: [...input.evidenceRefs],
    criticality: "medium",
  };
}

function admitReceiptEvidence(
  receiptCandidate: ReceiptCandidate,
  sourceEventId: string,
): EvidenceRef[] {
  return receiptCandidate.evidence.map((evidence) => ({
    evidenceId: evidence.evidenceId,
    kind: evidence.kind,
    sourceEventId,
    hash: evidence.hash,
    observedAt: evidence.observedAt,
    sensitivity: evidence.sensitivity,
    ...(evidence.metadata === undefined ? {} : { metadata: evidence.metadata }),
  }));
}

function numberField(payload: JsonObject, field: string): number {
  const value = payload[field];
  if (typeof value !== "number") {
    throw new Error(`Expected payload.${field} to be a number.`);
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
