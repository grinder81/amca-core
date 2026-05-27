import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CertifiedEffectRequest,
  EffectAdapterResult,
} from "@amca/effect-sdk";
import type { JsonObject, Sha256Hash } from "@amca/protocol";
import { describe, expect, it } from "vitest";

import {
  createShellCommandAdapter,
  ShellCommandAdapterConfigError,
  type ShellCommandReceiptPayload,
} from "./shell-command-adapter.js";

const observedAt = "2026-05-25T12:00:00.000Z";
const runId = "run_phase50_shell_adapter";
const capabilityId = "amca.shell.run_profile";
const toolId = "shell.run_profile";
const receiptType = "shell.command_executed";
const leakedSecret = "phase50-parent-secret-value";
const stdoutSecret = "phase50-stdout-secret";
const stderrSecret = "phase50-stderr-secret";

describe("shell command adapter contract", () => {
  it("executes only allowlisted executable profiles and emits hash-only receipt candidates", async () => {
    const adapter = createShellCommandAdapter({
      adapterId: "adapter.amca.shell.run_profile",
      capabilityId,
      toolId,
      rootDir: process.cwd(),
      profiles: [
        {
          profileId: "safe",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: [
            "-e",
            `process.stdout.write("ok ${stdoutSecret}"); process.stderr.write("err ${stderrSecret}")`,
          ],
        },
      ],
      clock: () => observedAt,
    });

    const result = await adapter.execute(requestFor({ profileId: "safe" }), {
      now: () => observedAt,
    });
    const receiptCandidate = requiredReceiptCandidate(result);
    const payload = shellPayload(receiptCandidate.payload);

    expect(adapter.certification).toMatchObject({
      adapterKind: "controlled_compute",
      sideEffectClass: "compute",
      idempotency: "not_required",
      declaredReceiptTypes: [receiptType],
    });
    expect(receiptCandidate.status).toBe("succeeded");
    expect(payload).toMatchObject({
      result: "succeeded",
      actionVerb: "executed",
      subjectType: "shell_profile",
      subjectId: "safe",
      targetType: "local_process",
      targetId: "safe",
      profileId: "safe",
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputTruncated: false,
      redaction: "output_hash_only",
    });
    expect(payload.stdoutHash).toBe(sha256("ok phase50-stdout-secret"));
    expect(payload.stderrHash).toBe(sha256("err phase50-stderr-secret"));
    expect(JSON.stringify(receiptCandidate)).not.toContain(stdoutSecret);
    expect(JSON.stringify(receiptCandidate)).not.toContain(stderrSecret);
    expect(receiptCandidate.evidence).toEqual([
      expect.objectContaining({
        kind: "effect_receipt",
        admissionStatus: "pending",
        hash: receiptCandidate.payloadHash,
        metadata: {
          redaction: "output_hash_only",
        },
      }),
    ]);
    expect(receiptCandidate.evidence[0]).not.toHaveProperty("sourceEventId");
  });

  it("shell-string-command-blocked", async () => {
    const result = await safeAdapter().execute(
      requestFor({
        profileId: "pass",
        command: `${process.execPath} -e "console.log('bypass')"`,
      }),
      { now: () => observedAt },
    );
    const payload = shellPayload(requiredReceiptCandidate(result).payload);

    expect(requiredReceiptCandidate(result).status).toBe("failed");
    expect(payload).toMatchObject({
      result: "failed",
      profileId: "pass",
      reason: "forbidden_request_field",
      stdoutBytes: 0,
      stderrBytes: 0,
    });
  });

  it("shell-true-blocked", async () => {
    const result = await safeAdapter().execute(
      requestFor({
        profileId: "pass",
        shell: true,
      }),
      { now: () => observedAt },
    );
    const payload = shellPayload(requiredReceiptCandidate(result).payload);

    expect(requiredReceiptCandidate(result).status).toBe("failed");
    expect(payload.reason).toBe("forbidden_request_field");

    expect(() =>
      createShellCommandAdapter({
        adapterId: "adapter.amca.shell.bad_profile",
        capabilityId,
        toolId,
        rootDir: process.cwd(),
        profiles: [
          {
            profileId: "bad",
            profileClass: "read_only_compute",
            executablePath: process.execPath,
            args: [],
            shell: true,
          } as unknown as Parameters<
            typeof createShellCommandAdapter
          >[0]["profiles"][number],
        ],
      }),
    ).toThrow(ShellCommandAdapterConfigError);
  });

  it("shell-adapter-rejects-unknown-dangerous-flag", () => {
    expect(() =>
      createShellCommandAdapter({
        adapterId: "adapter.amca.shell.bad_flag",
        capabilityId,
        toolId,
        rootDir: process.cwd(),
        profiles: [
          {
            profileId: "bad-flag",
            profileClass: "read_only_compute",
            executablePath: process.execPath,
            args: ["--dangerously-allow-write"],
          },
        ],
      }),
    ).toThrow(ShellCommandAdapterConfigError);
  });

  it("rejects profiles without an explicit shell profile classification", () => {
    expect(() =>
      createShellCommandAdapter({
        adapterId: "adapter.amca.shell.undeclared_class",
        capabilityId,
        toolId,
        rootDir: process.cwd(),
        profiles: [
          {
            profileId: "undeclared",
            executablePath: process.execPath,
            args: ["-e", "process.stdout.write('ambiguous')"],
          } as unknown as Parameters<
            typeof createShellCommandAdapter
          >[0]["profiles"][number],
        ],
      }),
    ).toThrow(ShellCommandAdapterConfigError);
  });

  it("shell-adapter-rejects-cwd-symlink-escape", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "amca-shell-root-"));
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), "amca-shell-outside-"),
    );

    try {
      const escapedCwd = path.join(rootDir, "escaped-cwd");
      await symlink(outsideDir, escapedCwd);

      expect(() =>
        createShellCommandAdapter({
          adapterId: "adapter.amca.shell.cwd_escape",
          capabilityId,
          toolId,
          rootDir,
          profiles: [
            {
              profileId: "cwd-escape",
              profileClass: "read_only_compute",
              executablePath: process.execPath,
              args: ["-e", "process.stdout.write('should-not-run')"],
              cwd: escapedCwd,
            },
          ],
        }),
      ).toThrow(ShellCommandAdapterConfigError);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
      await rm(outsideDir, { force: true, recursive: true });
    }
  });

  it("shell-adapter-rejects-interactive-command-profile", () => {
    expect(() =>
      createShellCommandAdapter({
        adapterId: "adapter.amca.shell.interactive",
        capabilityId,
        toolId,
        rootDir: process.cwd(),
        profiles: [
          {
            profileId: "interactive",
            profileClass: "process_control",
            executablePath: process.execPath,
            args: ["-i"],
          },
        ],
      }),
    ).toThrow(ShellCommandAdapterConfigError);

    expect(() =>
      createShellCommandAdapter({
        adapterId: "adapter.amca.shell.interactive_flag",
        capabilityId,
        toolId,
        rootDir: process.cwd(),
        profiles: [
          {
            profileId: "interactive-flag",
            profileClass: "read_only_compute",
            executablePath: process.execPath,
            args: ["-i"],
          },
        ],
      }),
    ).toThrow(ShellCommandAdapterConfigError);
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
      }),
    ).toThrow(ShellCommandAdapterConfigError);
  });

  it("unallowlisted-executable-blocked", async () => {
    const result = await safeAdapter().execute(
      requestFor({ profileId: "missing" }),
      { now: () => observedAt },
    );
    const payload = shellPayload(requiredReceiptCandidate(result).payload);

    expect(requiredReceiptCandidate(result).status).toBe("failed");
    expect(payload.reason).toBe("profile_not_found");
    expect(payload.stdoutHash).toBe(emptySha256());
  });

  it("timeout-quarantines-or-fails-closed", async () => {
    const result = await safeAdapter().execute(
      requestFor({ profileId: "timeout" }),
      { now: () => observedAt },
    );
    const payload = shellPayload(requiredReceiptCandidate(result).payload);

    expect(requiredReceiptCandidate(result).status).toBe("failed");
    expect(payload).toMatchObject({
      result: "failed",
      profileId: "timeout",
      timedOut: true,
      reason: "timed_out",
    });
  });

  it("oversized-output-redacted-and-bounded", async () => {
    const result = await safeAdapter().execute(
      requestFor({ profileId: "large-output" }),
      { now: () => observedAt },
    );
    const receiptCandidate = requiredReceiptCandidate(result);
    const payload = shellPayload(receiptCandidate.payload);

    expect(receiptCandidate.status).toBe("failed");
    expect(payload).toMatchObject({
      result: "failed",
      profileId: "large-output",
      outputTruncated: true,
      reason: "output_limit_exceeded",
      redaction: "output_hash_only",
    });
    expect(payload.stdoutBytes).toBeLessThanOrEqual(16);
    expect(JSON.stringify(receiptCandidate)).not.toContain("XXXXXXXXXX");
  });

  it("env-secret-not-leaked", async () => {
    const priorSecret = process.env.AMCA_PHASE50_PARENT_SECRET;
    process.env.AMCA_PHASE50_PARENT_SECRET = leakedSecret;

    try {
      const result = await safeAdapter().execute(
        requestFor({ profileId: "env-check" }),
        { now: () => observedAt },
      );
      const receiptCandidate = requiredReceiptCandidate(result);
      const payload = shellPayload(receiptCandidate.payload);

      expect(receiptCandidate.status).toBe("succeeded");
      expect(payload.stdoutHash).toBe(sha256("missing\n"));
      expect(JSON.stringify(receiptCandidate)).not.toContain(leakedSecret);
    } finally {
      if (priorSecret === undefined) {
        delete process.env.AMCA_PHASE50_PARENT_SECRET;
      } else {
        process.env.AMCA_PHASE50_PARENT_SECRET = priorSecret;
      }
    }
  });

  it("profile environment secrets fail closed before execution", async () => {
    const adapter = createShellCommandAdapter({
      adapterId: "adapter.amca.shell.run_profile",
      capabilityId,
      toolId,
      rootDir: process.cwd(),
      profiles: [
        {
          profileId: "secret-env",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: ["-e", "process.stdout.write('should-not-run')"],
          env: {
            AMCA_API_TOKEN: "secret-token",
          },
        },
      ],
      clock: () => observedAt,
    });

    const result = await adapter.execute(
      requestFor({ profileId: "secret-env" }),
      {
        now: () => observedAt,
      },
    );
    const payload = shellPayload(requiredReceiptCandidate(result).payload);

    expect(requiredReceiptCandidate(result).status).toBe("failed");
    expect(payload).toMatchObject({
      reason: "forbidden_profile_env",
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    expect(JSON.stringify(result)).not.toContain("should-not-run");
  });

  it("nonzero-exit-failed-receipt-candidate", async () => {
    const result = await safeAdapter().execute(
      requestFor({ profileId: "nonzero" }),
      { now: () => observedAt },
    );
    const payload = shellPayload(requiredReceiptCandidate(result).payload);

    expect(requiredReceiptCandidate(result).status).toBe("failed");
    expect(payload).toMatchObject({
      result: "failed",
      profileId: "nonzero",
      exitCode: 9,
      timedOut: false,
      outputTruncated: false,
    });
    expect(payload.reason).toBeUndefined();
  });
});

function safeAdapter() {
  return createShellCommandAdapter({
    adapterId: "adapter.amca.shell.run_profile",
    capabilityId,
    toolId,
    rootDir: process.cwd(),
    profiles: [
      {
        profileId: "pass",
        profileClass: "read_only_compute",
        executablePath: process.execPath,
        args: ["-e", "process.stdout.write('passed')"],
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
          "console.log(process.env.AMCA_PHASE50_PARENT_SECRET ?? 'missing')",
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
  });
}

function requestFor(args: JsonObject): CertifiedEffectRequest {
  return {
    toolCommand: {
      kind: "tool_command_request",
      commandId: "command_shell_profile",
      runId,
      capabilityId,
      toolId,
      args,
      sideEffectClass: "compute",
    },
    effectRequest: {
      effectId: "effect_shell_profile",
      commandId: "command_shell_profile",
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
    throw new Error("Expected shell adapter to emit a receipt candidate.");
  }
  return result.receiptCandidate;
}

function shellPayload(payload: JsonObject): ShellCommandReceiptPayload {
  return payload as ShellCommandReceiptPayload;
}

function sha256(value: string): Sha256Hash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function emptySha256(): Sha256Hash {
  return sha256("");
}
