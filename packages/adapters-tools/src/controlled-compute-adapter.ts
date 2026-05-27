import { spawn } from "node:child_process";

import { canonicalObjectHash } from "@amca/contracts";
import type {
  EffectAdapter,
  PendingEvidenceRef,
  ReceiptCandidate,
} from "@amca/effect-sdk";
import type { ISODateTimeString, JsonObject } from "@amca/protocol";

const defaultReceiptType = "test_run";
const defaultTestSuiteId = "controlled-compute";
const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 16_384;
const forbiddenRequestKeys = new Set(["args", "command", "cwd", "shell"]);

export type ControlledComputeFailureReason =
  | "execution_error"
  | "forbidden_request_override"
  | "profile_not_found"
  | "timed_out";

export interface ControlledComputeProfile {
  readonly profileId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly testSuiteId?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly maxOutputSnippetBytes?: number | undefined;
  readonly redactions?: readonly string[] | undefined;
}

export interface ControlledComputeAdapterOptions {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly profiles: readonly ControlledComputeProfile[];
  readonly receiptType?: string | undefined;
  readonly testSuiteId?: string | undefined;
  readonly clock?: (() => ISODateTimeString) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly maxOutputSnippetBytes?: number | undefined;
  readonly redactions?: readonly string[] | undefined;
}

export interface ControlledComputeReceiptPayload extends JsonObject {
  readonly result: "failed" | "passed";
  readonly profileId: string;
  readonly testSuiteId: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly stdoutSnippet: string;
  readonly stderrSnippet: string;
  readonly reason?: ControlledComputeFailureReason;
}

export function createControlledComputeAdapter(
  options: ControlledComputeAdapterOptions,
): EffectAdapter {
  const receiptType = options.receiptType ?? defaultReceiptType;
  const clock = options.clock ?? systemClock;
  const profileById = new Map(
    options.profiles.map((profile) => [profile.profileId, profile]),
  );

  return {
    adapterId: options.adapterId,
    capabilityId: options.capabilityId,
    toolId: options.toolId,
    certification: {
      certificationVersion: 1,
      adapterId: options.adapterId,
      adapterKind: "controlled_compute",
      capabilityId: options.capabilityId,
      toolId: options.toolId,
      sideEffectClass: "compute",
      declaredReceiptTypes: [receiptType],
      idempotency: "not_required",
      riskProfile: "standard",
    },
    execute: async (request) => {
      const observedAt = clock();
      const requestProfileId =
        typeof request.effectRequest.args.profileId === "string"
          ? request.effectRequest.args.profileId
          : undefined;
      const profile =
        requestProfileId === undefined
          ? undefined
          : profileById.get(requestProfileId);

      if (profile === undefined) {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: failedPayload({
              profileId: requestProfileId ?? "unknown",
              testSuiteId: options.testSuiteId ?? defaultTestSuiteId,
              reason: "profile_not_found",
            }),
          }),
        };
      }

      if (
        Object.keys(request.effectRequest.args).some((key) =>
          forbiddenRequestKeys.has(key),
        )
      ) {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: failedPayload({
              profileId: profile.profileId,
              testSuiteId:
                profile.testSuiteId ??
                options.testSuiteId ??
                defaultTestSuiteId,
              reason: "forbidden_request_override",
            }),
          }),
        };
      }

      const execution = await executeProfile(profile, {
        maxOutputBytes:
          profile.maxOutputBytes ??
          profile.maxOutputSnippetBytes ??
          options.maxOutputBytes ??
          options.maxOutputSnippetBytes ??
          defaultMaxOutputBytes,
        redactions: [
          ...(options.redactions ?? []),
          ...(profile.redactions ?? []),
        ],
        timeoutMs: profile.timeoutMs ?? options.timeoutMs ?? defaultTimeoutMs,
      });
      const payload: ControlledComputeReceiptPayload = {
        result:
          execution.exitCode === 0 && !execution.timedOut ? "passed" : "failed",
        profileId: profile.profileId,
        testSuiteId:
          profile.testSuiteId ?? options.testSuiteId ?? defaultTestSuiteId,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        outputTruncated: execution.outputTruncated,
        stdoutSnippet: execution.stdout,
        stderrSnippet: execution.stderr,
        ...(execution.timedOut ? { reason: "timed_out" } : {}),
      };

      return {
        receiptCandidate: receiptCandidateFor({
          effectId: request.effectRequest.effectId,
          runId: request.effectRequest.runId,
          capabilityId: request.effectRequest.capabilityId,
          receiptType,
          observedAt,
          payload,
        }),
      };
    },
  };
}

interface ProfileExecutionOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly redactions: readonly string[];
}

interface ProfileExecutionResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function executeProfile(
  profile: ControlledComputeProfile,
  options: ProfileExecutionOptions,
): Promise<ProfileExecutionResult> {
  return new Promise((resolve) => {
    const child = spawn(profile.command, [...profile.args], {
      cwd: profile.cwd,
      env: profile.env ?? {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = cappedOutput(options.maxOutputBytes);
    const stderr = cappedOutput(options.maxOutputBytes);
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        exitCode: null,
        timedOut: false,
        outputTruncated: stdout.truncated() || stderr.truncated(),
        stdout: redact(stdout.text(), options.redactions),
        stderr: redact(stderr.text(), options.redactions),
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        exitCode,
        timedOut,
        outputTruncated: stdout.truncated() || stderr.truncated(),
        stdout: redact(stdout.text(), options.redactions),
        stderr: redact(stderr.text(), options.redactions),
      });
    });
  });
}

function cappedOutput(maxBytes: number): {
  readonly append: (chunk: Buffer) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    append: (chunk) => {
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        return;
      }

      chunks.push(chunk);
      bytes += chunk.byteLength;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

function failedPayload(input: {
  readonly profileId: string;
  readonly testSuiteId: string;
  readonly reason: ControlledComputeFailureReason;
}): ControlledComputeReceiptPayload {
  return {
    result: "failed",
    profileId: input.profileId,
    testSuiteId: input.testSuiteId,
    exitCode: null,
    timedOut: input.reason === "timed_out",
    outputTruncated: false,
    stdoutSnippet: "",
    stderrSnippet: "",
    reason: input.reason,
  };
}

function receiptCandidateFor(input: {
  readonly effectId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly receiptType: string;
  readonly observedAt: ISODateTimeString;
  readonly payload: ControlledComputeReceiptPayload;
}): ReceiptCandidate {
  const payloadHash = canonicalObjectHash(input.payload);
  return {
    receiptId: `receipt_${input.effectId}`,
    effectId: input.effectId,
    runId: input.runId,
    capabilityId: input.capabilityId,
    receiptType: input.receiptType,
    status: input.payload.result === "passed" ? "succeeded" : "failed",
    payload: input.payload,
    payloadHash,
    observedAt: input.observedAt,
    evidence: [
      pendingEvidenceRef({
        evidenceId: `ev_${input.effectId}`,
        kind: "effect_receipt",
        hash: payloadHash,
        observedAt: input.observedAt,
        sensitivity: "internal",
        metadata: {
          redaction: "bounded_output",
        },
      }),
    ],
  };
}

function pendingEvidenceRef(
  input: Omit<PendingEvidenceRef, "admissionStatus" | "pendingAdmissionToken">,
): PendingEvidenceRef {
  return {
    ...input,
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${sanitizeToken(input.evidenceId)}`,
  };
}

function redact(value: string, redactions: readonly string[]): string {
  return redactions.reduce(
    (current, secret) => current.split(secret).join("[REDACTED]"),
    value.replace(
      /\b(secret|token|password|api[_-]?key)=\S+/giu,
      "$1=[REDACTED]",
    ),
  );
}

function systemClock(): ISODateTimeString {
  return new Date().toISOString();
}

function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
