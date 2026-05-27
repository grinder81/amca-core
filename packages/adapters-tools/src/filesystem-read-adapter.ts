import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalObjectHash } from "@amca/contracts";
import type {
  EffectAdapter,
  ExternalStateObservationCandidate,
  PendingEvidenceRef,
  ReceiptCandidate,
} from "@amca/effect-sdk";
import type { ISODateTimeString, JsonObject, Sha256Hash } from "@amca/protocol";

const defaultReceiptType = "filesystem.file_read";
const defaultMaxBytes = 1024 * 1024;

export type FilesystemReadFailureReason =
  | "directory_not_allowed"
  | "dotfile_not_allowed"
  | "file_too_large"
  | "invalid_path"
  | "not_found"
  | "outside_root"
  | "read_error";

export interface FilesystemReadSuccessPayload extends JsonObject {
  readonly result: "read";
  readonly path: string;
  readonly contentHash: Sha256Hash;
  readonly metadata: {
    readonly byteLength: number;
    readonly redaction: "content_hash_only";
  };
}

export interface FilesystemReadFailurePayload extends JsonObject {
  readonly result: "failed";
  readonly reason: FilesystemReadFailureReason;
  readonly path?: string;
}

export type FilesystemReadReceiptPayload =
  | FilesystemReadFailurePayload
  | FilesystemReadSuccessPayload;

export interface FilesystemReadAdapterOptions {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly rootDir: string;
  readonly observationType?: string | undefined;
  readonly receiptType?: string | undefined;
  readonly maxBytes?: number | undefined;
  readonly allowDotfiles?: boolean | undefined;
  readonly clock?: (() => ISODateTimeString) | undefined;
}

export interface LocalReadonlyAdapterOptions extends Omit<
  FilesystemReadAdapterOptions,
  "rootDir"
> {
  readonly rootPath: string;
}

export function createLocalReadonlyAdapter(
  options: LocalReadonlyAdapterOptions,
): EffectAdapter {
  return createFilesystemReadAdapter({
    ...options,
    rootDir: options.rootPath,
  });
}

export function createFilesystemReadAdapter(
  options: FilesystemReadAdapterOptions,
): EffectAdapter {
  const receiptType = options.receiptType ?? defaultReceiptType;
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const clock = options.clock ?? systemClock;

  return {
    adapterId: options.adapterId,
    capabilityId: options.capabilityId,
    toolId: options.toolId,
    certification: {
      certificationVersion: 1,
      adapterId: options.adapterId,
      adapterKind: "local_readonly",
      capabilityId: options.capabilityId,
      toolId: options.toolId,
      sideEffectClass: "read",
      declaredReceiptTypes: [receiptType],
      ...(options.observationType === undefined
        ? {}
        : { declaredObservationTypes: [options.observationType] }),
      idempotency: "not_required",
      riskProfile: "standard",
    },
    execute: async (request) => {
      const observedAt = clock();
      const args = request.effectRequest.args;
      const requestedPath =
        typeof args.path === "string" ? args.path : undefined;

      if (
        requestedPath === undefined ||
        requestedPath.trim().length === 0 ||
        isInvalidRequestedPath(requestedPath)
      ) {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: {
              result: "failed",
              reason: "invalid_path",
            },
          }),
        };
      }

      const normalizedRequestedPath = requestedPath.trim();
      if (
        options.allowDotfiles !== true &&
        hasDotfileSegment(normalizedRequestedPath)
      ) {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "dotfile_not_allowed",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      let rootRealPath: string;
      try {
        rootRealPath = await realpath(options.rootDir);
      } catch {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "read_error",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      const candidatePath = path.resolve(rootRealPath, normalizedRequestedPath);
      if (!isWithinRoot(rootRealPath, candidatePath)) {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "outside_root",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      let targetRealPath: string;
      try {
        targetRealPath = await realpath(candidatePath);
      } catch {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "not_found",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      if (!isWithinRoot(rootRealPath, targetRealPath)) {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "outside_root",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      let targetStat;
      try {
        targetStat = await stat(targetRealPath);
      } catch {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "read_error",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      if (!targetStat.isFile()) {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "directory_not_allowed",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      if (targetStat.size > maxBytes) {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "file_too_large",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      let contents: Buffer;
      try {
        contents = await readFile(targetRealPath);
      } catch {
        return {
          receiptCandidate: failureReceiptCandidate({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            reason: "read_error",
            requestedPath: normalizedRequestedPath,
          }),
        };
      }

      const relativePath = path.relative(rootRealPath, targetRealPath);
      const contentHash = sha256(contents);
      const payload: FilesystemReadSuccessPayload = {
        result: "read",
        path: relativePath,
        contentHash,
        metadata: {
          byteLength: contents.byteLength,
          redaction: "content_hash_only",
        },
      };
      const receiptCandidate = receiptCandidateFor({
        effectId: request.effectRequest.effectId,
        runId: request.effectRequest.runId,
        capabilityId: request.effectRequest.capabilityId,
        receiptType,
        observedAt,
        payload,
      });

      return {
        receiptCandidate,
        ...(options.observationType === undefined
          ? {}
          : {
              externalStateObservationCandidate: observationCandidateFor({
                commandId: request.toolCommand.commandId,
                observationType: options.observationType,
                observedAt,
                payload,
                relativePath,
                runId: request.effectRequest.runId,
              }),
            }),
      };
    },
  };
}

function failureReceiptCandidate(input: {
  readonly effectId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly receiptType: string;
  readonly observedAt: ISODateTimeString;
  readonly reason: FilesystemReadFailureReason;
  readonly requestedPath: string;
}): ReceiptCandidate {
  return receiptCandidateFor({
    effectId: input.effectId,
    runId: input.runId,
    capabilityId: input.capabilityId,
    receiptType: input.receiptType,
    observedAt: input.observedAt,
    payload: {
      result: "failed",
      reason: input.reason,
      path: input.requestedPath,
    },
  });
}

function receiptCandidateFor(input: {
  readonly effectId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly receiptType: string;
  readonly observedAt: ISODateTimeString;
  readonly payload: FilesystemReadReceiptPayload;
}): ReceiptCandidate {
  const payloadHash = canonicalObjectHash(input.payload);
  return {
    receiptId: `receipt_${input.effectId}`,
    effectId: input.effectId,
    runId: input.runId,
    capabilityId: input.capabilityId,
    receiptType: input.receiptType,
    status: input.payload.result === "read" ? "succeeded" : "failed",
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
          redaction: "content_hash_only",
        },
      }),
    ],
  };
}

function observationCandidateFor(input: {
  readonly commandId: string;
  readonly observationType: string;
  readonly observedAt: ISODateTimeString;
  readonly payload: FilesystemReadSuccessPayload;
  readonly relativePath: string;
  readonly runId: string;
}): ExternalStateObservationCandidate {
  const observedState = {
    path: input.relativePath,
    contentHash: input.payload.contentHash,
    metadata: input.payload.metadata,
  };
  const payloadHash = canonicalObjectHash(observedState);

  return {
    observationId: `obs_${sanitizeId(input.commandId)}`,
    runId: input.runId,
    observationType: input.observationType,
    subjectType: "local_file",
    subjectId: input.relativePath,
    observedState,
    observedAt: input.observedAt,
    expiresAt: oneMinuteAfter(input.observedAt),
    payloadHash,
    evidence: [
      pendingEvidenceRef({
        evidenceId: `ev_obs_${sanitizeId(input.commandId)}`,
        kind: "external_observation",
        hash: payloadHash,
        observedAt: input.observedAt,
        sensitivity: "internal",
        metadata: {
          redaction: "content_hash_only",
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

function isWithinRoot(rootRealPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootRealPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function isInvalidRequestedPath(requestedPath: string): boolean {
  const trimmedPath = requestedPath.trim();
  return (
    trimmedPath.includes("\0") ||
    path.isAbsolute(trimmedPath) ||
    path.win32.isAbsolute(trimmedPath) ||
    /^[A-Za-z]:/u.test(trimmedPath) ||
    trimmedPath.split(/[\\/]+/u).includes("..")
  );
}

function hasDotfileSegment(requestedPath: string): boolean {
  return requestedPath
    .split(/[\\/]+/u)
    .some((segment) => segment.length > 1 && segment.startsWith("."));
}

function sha256(buffer: Buffer): Sha256Hash {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function systemClock(): ISODateTimeString {
  return new Date().toISOString();
}

function oneMinuteAfter(value: ISODateTimeString): ISODateTimeString {
  return new Date(Date.parse(value) + 60_000).toISOString();
}
