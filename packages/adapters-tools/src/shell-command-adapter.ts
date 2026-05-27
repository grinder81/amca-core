import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { canonicalObjectHash } from "@amca/contracts";
import type {
  AdapterKind,
  EffectAdapter,
  PendingEvidenceRef,
  ReceiptCandidate,
} from "@amca/effect-sdk";
import type {
  EvidenceSensitivity,
  ISODateTimeString,
  JsonObject,
  Sha256Hash,
  SideEffectClass,
} from "@amca/protocol";

const defaultReceiptType = "shell.command_executed";
const defaultAdapterKind: AdapterKind = "controlled_compute";
const defaultSideEffectClass: SideEffectClass = "compute";
const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 65_536;
const defaultSensitivity: EvidenceSensitivity = "internal";
const forbiddenRequestKeys = new Set([
  "args",
  "command",
  "cwd",
  "env",
  "executable",
  "executablePath",
  "script",
  "shell",
  "stdio",
]);
const allowedRequestKeys = new Set(["profileId"]);
const secretLikeKeyPattern =
  /(api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)/iu;
const secretLikeValuePattern =
  /(bearer\s+[A-Za-z0-9._-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const profileKeys = new Set([
  "args",
  "cwd",
  "env",
  "executablePath",
  "maxOutputBytes",
  "profileClass",
  "profileId",
  "timeoutMs",
]);
const shellProfileClasses = new Set<ShellCommandProfileClass>([
  "dangerous",
  "filesystem_read",
  "filesystem_write",
  "network_read",
  "network_write",
  "process_control",
  "read_only_compute",
]);
const writeSideEffectClasses = new Set<SideEffectClass>([
  "idempotent_write",
  "irreversible_write",
  "reversible_write",
]);
const supportedShellAdapterKinds = new Set<AdapterKind>([
  "controlled_compute",
  "external_read",
  "external_write",
  "local_readonly",
]);
const interactiveArgFlags = new Set([
  "-i",
  "--interactive",
  "--login",
  "--pty",
  "--stdin",
  "--tty",
]);

export type ShellCommandFailureReason =
  | "cwd_outside_root"
  | "execution_error"
  | "forbidden_profile_env"
  | "forbidden_request_field"
  | "invalid_profile"
  | "output_limit_exceeded"
  | "profile_not_found"
  | "timed_out";

export type ShellCommandProfileClass =
  | "read_only_compute"
  | "filesystem_read"
  | "filesystem_write"
  | "network_read"
  | "network_write"
  | "process_control"
  | "dangerous";

export interface ShellCommandProfile {
  readonly profileId: string;
  readonly profileClass: ShellCommandProfileClass;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface ShellCommandAdapterOptions {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly rootDir: string;
  readonly profiles: readonly ShellCommandProfile[];
  readonly adapterKind?: AdapterKind | undefined;
  readonly sideEffectClass?: SideEffectClass | undefined;
  readonly receiptType?: string | undefined;
  readonly clock?: (() => ISODateTimeString) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly sensitivity?: EvidenceSensitivity | undefined;
}

export interface ShellCommandReceiptPayload extends JsonObject {
  readonly result: "failed" | "succeeded";
  readonly actionVerb: "executed";
  readonly subjectType: "shell_profile";
  readonly subjectId: string;
  readonly targetType: "local_process";
  readonly targetId: string;
  readonly profileId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly stdoutHash: Sha256Hash;
  readonly stderrHash: Sha256Hash;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly redaction: "output_hash_only";
  readonly reason?: ShellCommandFailureReason;
}

export class ShellCommandAdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellCommandAdapterConfigError";
  }
}

export function createShellCommandAdapter(
  options: ShellCommandAdapterOptions,
): EffectAdapter {
  const receiptType = options.receiptType ?? defaultReceiptType;
  const clock = options.clock ?? systemClock;
  const sensitivity = options.sensitivity ?? defaultSensitivity;
  const rootRealPath = validateRootDir(options.rootDir);
  const adapterKind = options.adapterKind ?? defaultAdapterKind;
  const sideEffectClass = options.sideEffectClass ?? defaultSideEffectClass;
  validateShellCertification({
    adapterKind,
    adapterId: options.adapterId,
    sideEffectClass,
  });
  const profiles = new Map<string, ValidatedShellCommandProfile>();

  for (const rawProfile of options.profiles) {
    const profile = validateProfile(rawProfile, {
      adapterKind,
      rootRealPath,
      sideEffectClass,
    });
    if (profiles.has(profile.profileId)) {
      throw new ShellCommandAdapterConfigError(
        `Shell command profile ${profile.profileId} is duplicated.`,
      );
    }
    profiles.set(profile.profileId, profile);
  }

  return {
    adapterId: options.adapterId,
    capabilityId: options.capabilityId,
    toolId: options.toolId,
    certification: {
      certificationVersion: 1,
      adapterId: options.adapterId,
      adapterKind,
      capabilityId: options.capabilityId,
      toolId: options.toolId,
      sideEffectClass,
      declaredReceiptTypes: [receiptType],
      idempotency: writeSideEffectClasses.has(sideEffectClass)
        ? "required_for_writes"
        : "not_required",
      ...(writeSideEffectClasses.has(sideEffectClass)
        ? {
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
          }
        : {}),
      riskProfile: writeSideEffectClasses.has(sideEffectClass)
        ? "critical"
        : "standard",
    },
    execute: async (request) => {
      const observedAt = clock();
      const parsedInput = parseRequestArgs(request.effectRequest.args);
      if (parsedInput.status === "failed") {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: failedPayload({
              profileId: parsedInput.profileId,
              reason: parsedInput.reason,
            }),
            sensitivity,
          }),
        };
      }

      const profile = profiles.get(parsedInput.profileId);
      if (profile === undefined) {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: failedPayload({
              profileId: parsedInput.profileId,
              reason: "profile_not_found",
            }),
            sensitivity,
          }),
        };
      }

      const envResult = sanitizedProfileEnv(profile.env);
      if (envResult.status === "failed") {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: failedPayload({
              profileId: profile.profileId,
              reason: envResult.reason,
            }),
            sensitivity,
          }),
        };
      }

      if (!isWithinRoot(rootRealPath, profile.cwd)) {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: failedPayload({
              profileId: profile.profileId,
              reason: "cwd_outside_root",
            }),
            sensitivity,
          }),
        };
      }

      const execution = await executeProfile(profile, {
        env: envResult.env,
        maxOutputBytes:
          profile.maxOutputBytes ??
          options.maxOutputBytes ??
          defaultMaxOutputBytes,
        timeoutMs: profile.timeoutMs ?? options.timeoutMs ?? defaultTimeoutMs,
      });
      const succeeded =
        execution.exitCode === 0 &&
        execution.signal === null &&
        !execution.timedOut &&
        !execution.outputTruncated &&
        !execution.executionError;
      const reason: ShellCommandFailureReason | undefined = succeeded
        ? undefined
        : execution.reason;

      return {
        receiptCandidate: receiptCandidateFor({
          effectId: request.effectRequest.effectId,
          runId: request.effectRequest.runId,
          capabilityId: request.effectRequest.capabilityId,
          receiptType,
          observedAt,
          payload: {
            result: succeeded ? "succeeded" : "failed",
            actionVerb: "executed",
            subjectType: "shell_profile",
            subjectId: profile.profileId,
            targetType: "local_process",
            targetId: profile.profileId,
            profileId: profile.profileId,
            exitCode: execution.exitCode,
            signal: execution.signal,
            timedOut: execution.timedOut,
            outputTruncated: execution.outputTruncated,
            stdoutHash: execution.stdoutHash,
            stderrHash: execution.stderrHash,
            stdoutBytes: execution.stdoutBytes,
            stderrBytes: execution.stderrBytes,
            redaction: "output_hash_only",
            ...(reason === undefined ? {} : { reason }),
          },
          sensitivity,
        }),
      };
    },
  };
}

interface ValidatedShellCommandProfile {
  readonly profileId: string;
  readonly profileClass: ShellCommandProfileClass;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

type ParsedRequestArgs =
  | {
      readonly status: "ok";
      readonly profileId: string;
    }
  | {
      readonly status: "failed";
      readonly profileId: string;
      readonly reason: ShellCommandFailureReason;
    };

interface ExecutionOptions {
  readonly env: Record<string, string>;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

interface ExecutionResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly executionError: boolean;
  readonly reason?: ShellCommandFailureReason | undefined;
  readonly stdoutHash: Sha256Hash;
  readonly stderrHash: Sha256Hash;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

interface ProfileValidationContext {
  readonly adapterKind: AdapterKind;
  readonly rootRealPath: string;
  readonly sideEffectClass: SideEffectClass;
}

function validateProfile(
  rawProfile: ShellCommandProfile,
  context: ProfileValidationContext,
): ValidatedShellCommandProfile {
  const profile = rawProfile as ShellCommandProfile & {
    readonly shell?: unknown;
  };

  assertProfileString(profile.profileId, "profileId");
  assertProfileString(profile.executablePath, "executablePath");

  if (profile.shell !== undefined) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profile.profileId} must not declare shell.`,
    );
  }

  assertOnlyProfileKeys(
    profile as unknown as Record<string, unknown>,
    profile.profileId,
  );
  const profileClass = validateProfileClass(
    profile.profileClass,
    profile.profileId,
  );
  assertProfileClassMatchesCertification(profile.profileId, profileClass, {
    adapterKind: context.adapterKind,
    sideEffectClass: context.sideEffectClass,
  });

  if (!isAbsoluteExecutablePath(profile.executablePath)) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profile.profileId} executablePath must be absolute.`,
    );
  }

  if (!Array.isArray(profile.args)) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profile.profileId} args must be an array.`,
    );
  }

  const profileArgs: string[] = [];
  for (const [index, arg] of profile.args.entries()) {
    assertProfileString(arg, `args[${String(index)}]`);
    assertAllowedProfileArg(profile.profileId, arg);
    profileArgs.push(arg);
  }

  const cwd =
    profile.cwd === undefined
      ? context.rootRealPath
      : validateProfileCwd(
          profile.cwd,
          profile.profileId,
          context.rootRealPath,
        );

  assertPositiveInteger(profile.timeoutMs, "timeoutMs", profile.profileId);
  assertPositiveInteger(
    profile.maxOutputBytes,
    "maxOutputBytes",
    profile.profileId,
  );

  return {
    profileId: profile.profileId,
    profileClass,
    executablePath: profile.executablePath,
    args: profileArgs,
    cwd,
    ...(profile.env === undefined ? {} : { env: profile.env }),
    ...(profile.timeoutMs === undefined
      ? {}
      : { timeoutMs: profile.timeoutMs }),
    ...(profile.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: profile.maxOutputBytes }),
  };
}

function validateRootDir(rootDir: string): string {
  assertRootString(rootDir);
  if (!isAbsoluteExecutablePath(rootDir)) {
    throw new ShellCommandAdapterConfigError(
      "Shell command adapter rootDir must be absolute.",
    );
  }

  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(rootDir);
  } catch {
    throw new ShellCommandAdapterConfigError(
      "Shell command adapter rootDir must resolve to an existing directory.",
    );
  }

  try {
    if (!statSync(rootRealPath).isDirectory()) {
      throw new ShellCommandAdapterConfigError(
        "Shell command adapter rootDir must resolve to a directory.",
      );
    }
  } catch (error) {
    if (error instanceof ShellCommandAdapterConfigError) {
      throw error;
    }

    throw new ShellCommandAdapterConfigError(
      "Shell command adapter rootDir must resolve to a directory.",
    );
  }

  return rootRealPath;
}

function validateShellCertification(input: {
  readonly adapterId: string;
  readonly adapterKind: AdapterKind;
  readonly sideEffectClass: SideEffectClass;
}): void {
  if (!supportedShellAdapterKinds.has(input.adapterKind)) {
    throw new ShellCommandAdapterConfigError(
      `Shell command adapter ${input.adapterId} cannot certify adapter kind ${input.adapterKind}.`,
    );
  }

  const allowed =
    (input.adapterKind === "controlled_compute" &&
      input.sideEffectClass === "compute") ||
    (input.adapterKind === "local_readonly" &&
      input.sideEffectClass === "read") ||
    (input.adapterKind === "external_read" &&
      input.sideEffectClass === "read") ||
    (input.adapterKind === "external_write" &&
      writeSideEffectClasses.has(input.sideEffectClass));

  if (!allowed) {
    throw new ShellCommandAdapterConfigError(
      `Shell command adapter ${input.adapterId} certification ${input.adapterKind}/${input.sideEffectClass} is not supported.`,
    );
  }
}

function validateProfileClass(
  value: unknown,
  profileId: string,
): ShellCommandProfileClass {
  if (
    typeof value !== "string" ||
    !shellProfileClasses.has(value as ShellCommandProfileClass)
  ) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} must declare a supported profileClass.`,
    );
  }

  return value as ShellCommandProfileClass;
}

function assertProfileClassMatchesCertification(
  profileId: string,
  profileClass: ShellCommandProfileClass,
  certification: Pick<
    ProfileValidationContext,
    "adapterKind" | "sideEffectClass"
  >,
): void {
  if (profileClass === "dangerous" || profileClass === "process_control") {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} class ${profileClass} is not allowed.`,
    );
  }

  const certified =
    (profileClass === "read_only_compute" &&
      certification.adapterKind === "controlled_compute" &&
      certification.sideEffectClass === "compute") ||
    (profileClass === "filesystem_read" &&
      certification.adapterKind === "local_readonly" &&
      certification.sideEffectClass === "read") ||
    (profileClass === "network_read" &&
      certification.adapterKind === "external_read" &&
      certification.sideEffectClass === "read") ||
    ((profileClass === "filesystem_write" ||
      profileClass === "network_write") &&
      certification.adapterKind === "external_write" &&
      writeSideEffectClasses.has(certification.sideEffectClass));

  if (!certified) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} class ${profileClass} is not certified by adapter ${certification.adapterKind}/${certification.sideEffectClass}.`,
    );
  }
}

function assertOnlyProfileKeys(
  profile: Record<string, unknown>,
  profileId: string,
): void {
  const unknownKey = Object.keys(profile).find((key) => !profileKeys.has(key));
  if (unknownKey !== undefined) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} contains unknown field ${unknownKey}.`,
    );
  }
}

function assertAllowedProfileArg(profileId: string, arg: string): void {
  const normalized = arg.toLowerCase();
  if (
    interactiveArgFlags.has(normalized) ||
    normalized.startsWith("--interactive=") ||
    normalized.startsWith("--inspect") ||
    normalized.startsWith("--debug") ||
    normalized === "--require" ||
    normalized.startsWith("--require=") ||
    normalized === "-r" ||
    normalized === "--loader" ||
    normalized.startsWith("--loader=") ||
    normalized === "--import" ||
    normalized.startsWith("--import=") ||
    normalized === "--watch" ||
    normalized.startsWith("--watch=") ||
    /^--(?:danger|dangerous|unsafe|allow|enable).*(?:child|exec|network|permission|process|shell|socket|write)/u.test(
      normalized,
    ) ||
    /^--(?:bind|daemon|listen|server)(?:=|$)/u.test(normalized)
  ) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} args contain a dangerous or interactive flag.`,
    );
  }
}

function validateProfileCwd(
  cwd: string,
  profileId: string,
  rootRealPath: string,
): string {
  assertProfileString(cwd, "cwd");
  if (!isAbsoluteExecutablePath(cwd)) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} cwd must be absolute when provided.`,
    );
  }

  const normalizedCwd = path.resolve(cwd);
  if (!isWithinRoot(rootRealPath, normalizedCwd)) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} cwd must stay within the adapter root.`,
    );
  }

  let cwdRealPath: string;
  try {
    cwdRealPath = realpathSync(normalizedCwd);
  } catch {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} cwd must resolve to an existing directory.`,
    );
  }

  try {
    if (!statSync(cwdRealPath).isDirectory()) {
      throw new ShellCommandAdapterConfigError(
        `Shell command profile ${profileId} cwd must resolve to a directory.`,
      );
    }
  } catch (error) {
    if (error instanceof ShellCommandAdapterConfigError) {
      throw error;
    }

    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} cwd must resolve to a directory.`,
    );
  }

  if (!isWithinRoot(rootRealPath, cwdRealPath)) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} cwd must not escape the adapter root through symlinks.`,
    );
  }

  return cwdRealPath;
}

function parseRequestArgs(args: JsonObject): ParsedRequestArgs {
  const keys = Object.keys(args);
  const forbiddenKey = keys.find((key) => forbiddenRequestKeys.has(key));
  if (forbiddenKey !== undefined) {
    return {
      status: "failed",
      profileId: profileIdFromArgs(args),
      reason: "forbidden_request_field",
    };
  }

  if (keys.some((key) => !allowedRequestKeys.has(key))) {
    return {
      status: "failed",
      profileId: profileIdFromArgs(args),
      reason: "forbidden_request_field",
    };
  }

  if (typeof args.profileId !== "string" || args.profileId.trim() === "") {
    return {
      status: "failed",
      profileId: "unknown",
      reason: "invalid_profile",
    };
  }

  return {
    status: "ok",
    profileId: args.profileId,
  };
}

function profileIdFromArgs(args: JsonObject): string {
  return typeof args.profileId === "string" && args.profileId.trim() !== ""
    ? args.profileId
    : "unknown";
}

function sanitizedProfileEnv(
  env: Readonly<Record<string, string>> | undefined,
):
  | {
      readonly status: "ok";
      readonly env: Record<string, string>;
    }
  | {
      readonly status: "failed";
      readonly reason: "forbidden_profile_env";
    } {
  if (env === undefined) {
    return {
      status: "ok",
      env: {},
    };
  }

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value !== "string" ||
      key.trim() === "" ||
      key.includes("=") ||
      key.includes("\0") ||
      secretLikeKeyPattern.test(key) ||
      secretLikeValuePattern.test(value) ||
      value.includes("\0")
    ) {
      return {
        status: "failed",
        reason: "forbidden_profile_env",
      };
    }

    sanitized[key] = value;
  }

  return {
    status: "ok",
    env: sanitized,
  };
}

function executeProfile(
  profile: ValidatedShellCommandProfile,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const stdout = boundedOutput(options.maxOutputBytes);
    const stderr = boundedOutput(options.maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;

    const child = spawn(profile.executablePath, [...profile.args], {
      cwd: profile.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const maybeKillForOutputLimit = (): void => {
      if (outputLimitExceeded) {
        return;
      }

      if (stdout.truncated() || stderr.truncated()) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      maybeKillForOutputLimit();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      maybeKillForOutputLimit();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        outputTruncated: stdout.truncated() || stderr.truncated(),
        executionError: true,
        reason: "execution_error",
        stdoutHash: stdout.hash(),
        stderrHash: stderr.hash(),
        stdoutBytes: stdout.bytes(),
        stderrBytes: stderr.bytes(),
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      const outputTruncated = stdout.truncated() || stderr.truncated();
      resolve({
        exitCode,
        signal,
        timedOut,
        outputTruncated,
        executionError: false,
        ...(timedOut
          ? { reason: "timed_out" }
          : outputTruncated
            ? { reason: "output_limit_exceeded" }
            : {}),
        stdoutHash: stdout.hash(),
        stderrHash: stderr.hash(),
        stdoutBytes: stdout.bytes(),
        stderrBytes: stderr.bytes(),
      });
    });
  });
}

function boundedOutput(maxBytes: number): {
  readonly append: (chunk: Buffer) => void;
  readonly bytes: () => number;
  readonly hash: () => Sha256Hash;
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
    bytes: () => bytes,
    hash: () => sha256(Buffer.concat(chunks)),
    truncated: () => truncated,
  };
}

function failedPayload(input: {
  readonly profileId: string;
  readonly reason: ShellCommandFailureReason;
}): ShellCommandReceiptPayload {
  return {
    result: "failed",
    actionVerb: "executed",
    subjectType: "shell_profile",
    subjectId: input.profileId,
    targetType: "local_process",
    targetId: input.profileId,
    profileId: input.profileId,
    exitCode: null,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdoutHash: emptySha256(),
    stderrHash: emptySha256(),
    stdoutBytes: 0,
    stderrBytes: 0,
    redaction: "output_hash_only",
    reason: input.reason,
  };
}

function receiptCandidateFor(input: {
  readonly effectId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly receiptType: string;
  readonly observedAt: ISODateTimeString;
  readonly payload: ShellCommandReceiptPayload;
  readonly sensitivity: EvidenceSensitivity;
}): ReceiptCandidate {
  const payloadHash = canonicalObjectHash(input.payload);
  return {
    receiptId: `receipt_${sanitizeId(input.effectId)}`,
    effectId: input.effectId,
    runId: input.runId,
    capabilityId: input.capabilityId,
    receiptType: input.receiptType,
    status: input.payload.result === "succeeded" ? "succeeded" : "failed",
    payload: input.payload,
    payloadHash,
    observedAt: input.observedAt,
    evidence: [
      pendingEvidenceRef({
        evidenceId: `ev_${sanitizeId(input.effectId)}`,
        kind: "effect_receipt",
        hash: payloadHash,
        observedAt: input.observedAt,
        sensitivity: input.sensitivity,
        metadata: {
          redaction: "output_hash_only",
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
    pendingAdmissionToken: `pending_${sanitizeId(input.evidenceId)}`,
  };
}

function assertProfileString(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0")
  ) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${fieldName} must be a non-empty string without NUL bytes.`,
    );
  }
}

function assertRootString(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0")
  ) {
    throw new ShellCommandAdapterConfigError(
      "Shell command adapter rootDir must be a non-empty string without NUL bytes.",
    );
  }
}

function assertPositiveInteger(
  value: number | undefined,
  fieldName: string,
  profileId: string,
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new ShellCommandAdapterConfigError(
      `Shell command profile ${profileId} ${fieldName} must be a positive integer.`,
    );
  }
}

function isAbsoluteExecutablePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function sha256(buffer: Buffer): Sha256Hash {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function emptySha256(): Sha256Hash {
  return sha256(Buffer.alloc(0));
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function systemClock(): ISODateTimeString {
  return new Date().toISOString();
}
