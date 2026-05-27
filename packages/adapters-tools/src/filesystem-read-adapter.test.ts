import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CertifiedEffectRequest,
  EffectAdapterResult,
} from "@amca/effect-sdk";
import type { JsonObject, JsonValue } from "@amca/protocol";

import {
  createLocalReadonlyAdapter,
  type FilesystemReadFailureReason,
} from "./filesystem-read-adapter.js";

const observedAt = "2026-05-24T12:00:00.000Z";
const runId = "run_local_readonly_contract";
const capabilityId = "amca.local_readonly.read_file";
const toolId = "local_readonly.read_file";
const receiptType = "local_readonly.file_read";
const observationType = "local_readonly.file_snapshot";

describe("local_readonly filesystem adapter contract", () => {
  it("certifies only read authority with no idempotency requirement", async () => {
    await withFixture((fixture) => {
      expect(fixture.adapter.certification).toMatchObject({
        adapterKind: "local_readonly",
        sideEffectClass: "read",
        idempotency: "not_required",
        declaredReceiptTypes: [receiptType],
        declaredObservationTypes: [observationType],
      });
    });
  });

  it.each([
    ["absolute path", path.resolve("/", "tmp", "outside.txt"), "invalid_path"],
    ["Windows absolute path", "C:\\tmp\\outside.txt", "invalid_path"],
    ["traversal path", "../outside/outside.txt", "invalid_path"],
    ["Windows traversal path", "nested\\..\\inside.txt", "invalid_path"],
    ["encoded traversal literal", "%2e%2e/outside.txt", "not_found"],
    ["dotfile path", ".env", "dotfile_not_allowed"],
    ["nested dotfile path", "nested/.secret", "dotfile_not_allowed"],
    ["directory", "nested", "directory_not_allowed"],
    ["missing file", "missing.txt", "not_found"],
  ] satisfies readonly (readonly [
    string,
    string,
    FilesystemReadFailureReason,
  ])[])("rejects %s reads", async (_label, requestedPath, expectedReason) => {
    await withFixture(async (fixture) => {
      const result = await executeRead(fixture, requestedPath);
      const receiptCandidate = requiredReceiptCandidate(result);

      expect(receiptCandidate.status).toBe("failed");
      expect(reasonOf(receiptCandidate.payload)).toBe(expectedReason);
      expect(result.externalStateObservationCandidate).toBeUndefined();
    });
  });

  it("rejects symlink escape reads", async () => {
    await withFixture(async (fixture) => {
      const result = await executeRead(fixture, "escape-link.txt");
      const receiptCandidate = requiredReceiptCandidate(result);

      expect(receiptCandidate.status).toBe("failed");
      expect(reasonOf(receiptCandidate.payload)).toBe("outside_root");
      expect(result.externalStateObservationCandidate).toBeUndefined();
    });
  });

  it("rejects oversized files", async () => {
    await withFixture(async (fixture) => {
      const result = await executeRead(fixture, "inside.txt", {
        maxBytes: fixture.secretContents.length - 1,
      });
      const receiptCandidate = requiredReceiptCandidate(result);

      expect(receiptCandidate.status).toBe("failed");
      expect(reasonOf(receiptCandidate.payload)).toBe("file_too_large");
      expect(result.externalStateObservationCandidate).toBeUndefined();
    });
  });

  it("returns only content hashes and metadata for successful reads", async () => {
    await withFixture(async (fixture) => {
      const result = await executeRead(fixture, "inside.txt");
      const receiptCandidate = requiredReceiptCandidate(result);

      expect(receiptCandidate.status).toBe("succeeded");
      expect(receiptCandidate.payload).toMatchObject({
        result: "read",
        path: "inside.txt",
        metadata: {
          byteLength: Buffer.byteLength(fixture.secretContents),
          redaction: "content_hash_only",
        },
      });
      expect(stringField(receiptCandidate.payload, "contentHash")).toMatch(
        /^sha256:[a-f0-9]{64}$/u,
      );
      expect(JSON.stringify(result)).not.toContain(fixture.secretContents);
      expect(jsonKeys(receiptCandidate.payload)).not.toEqual(
        expect.arrayContaining(["body", "content", "rawContent", "text"]),
      );
      expect(receiptCandidate.evidence).toEqual([
        expect.objectContaining({
          kind: "effect_receipt",
          admissionStatus: "pending",
          hash: receiptCandidate.payloadHash,
          metadata: {
            redaction: "content_hash_only",
          },
        }),
      ]);
      expect(typeof receiptCandidate.evidence[0]?.pendingAdmissionToken).toBe(
        "string",
      );
      expect(receiptCandidate.evidence[0]).not.toHaveProperty("sourceEventId");
    });
  });

  it("handles binary files as hash-only reads without returning bytes", async () => {
    await withFixture(async (fixture) => {
      const result = await executeRead(fixture, "binary.bin");
      const receiptCandidate = requiredReceiptCandidate(result);
      const observationCandidate = requiredObservationCandidate(result);

      expect(receiptCandidate.status).toBe("succeeded");
      expect(receiptCandidate.payload).toMatchObject({
        result: "read",
        path: "binary.bin",
        metadata: {
          byteLength: fixture.binaryContents.length,
          redaction: "content_hash_only",
        },
      });
      expect(stringField(receiptCandidate.payload, "contentHash")).toMatch(
        /^sha256:[a-f0-9]{64}$/u,
      );
      expect(JSON.stringify(result)).not.toContain(
        fixture.binaryContents.toString("binary"),
      );
      expect(jsonKeys(receiptCandidate.payload)).not.toEqual(
        expect.arrayContaining(["body", "content", "rawContent", "text"]),
      );
      expect(observationCandidate.observedState).toMatchObject({
        path: "binary.bin",
        metadata: {
          byteLength: fixture.binaryContents.length,
          redaction: "content_hash_only",
        },
      });
    });
  });

  it("emits a freshness-bounded external observation only for successful reads", async () => {
    await withFixture(async (fixture) => {
      const success = await executeRead(fixture, "inside.txt");
      const failed = await executeRead(fixture, "missing.txt");

      expect(failed.externalStateObservationCandidate).toBeUndefined();
      expect(success.externalStateObservationCandidate).toMatchObject({
        observationType,
        subjectType: "local_file",
        subjectId: "inside.txt",
        observedAt,
      });

      const observationCandidate = requiredObservationCandidate(success);
      expect(Date.parse(observationCandidate.expiresAt)).toBe(
        Date.parse(observedAt) + 60_000,
      );
      expect(JSON.stringify(observationCandidate)).not.toContain(
        fixture.secretContents,
      );
      expect(observationCandidate.evidence).toEqual([
        expect.objectContaining({
          kind: "external_observation",
          admissionStatus: "pending",
          hash: observationCandidate.payloadHash,
          metadata: {
            redaction: "content_hash_only",
          },
        }),
      ]);
      expect(
        typeof observationCandidate.evidence[0]?.pendingAdmissionToken,
      ).toBe("string");
      expect(observationCandidate.evidence[0]).not.toHaveProperty(
        "sourceEventId",
      );
    });
  });

  it("marks adapter evidence as pending kernel admission, never as admitted evidence", async () => {
    await withFixture(async (fixture) => {
      const result = await executeRead(fixture, "inside.txt");
      const observationCandidate = requiredObservationCandidate(result);
      const receiptCandidate = requiredReceiptCandidate(result);

      expect(receiptCandidate.evidence).toHaveLength(1);
      expect(observationCandidate.evidence).toHaveLength(1);
      for (const evidenceRef of [
        ...receiptCandidate.evidence,
        ...observationCandidate.evidence,
      ]) {
        expect(evidenceRef).toMatchObject({
          admissionStatus: "pending",
        });
        expect(typeof evidenceRef.pendingAdmissionToken).toBe("string");
        expect(evidenceRef).not.toHaveProperty("sourceEventId");
      }
    });
  });
});

interface LocalReadonlyFixture {
  readonly adapterId: string;
  readonly binaryContents: Buffer;
  readonly rootPath: string;
  readonly secretContents: string;
}

async function withFixture(
  callback: (
    fixture: LocalReadonlyFixture & {
      readonly adapter: ReturnType<typeof createLocalReadonlyAdapter>;
    },
  ) => Promise<void> | void,
): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "amca-adapter-readonly-"));
  const rootPath = path.join(tempRoot, "root");
  const outsidePath = path.join(tempRoot, "outside");
  const binaryContents = Buffer.from([0, 1, 2, 3, 255]);
  const secretContents = "phase33-local-readonly-secret\n";

  mkdirSync(rootPath);
  mkdirSync(path.join(rootPath, "nested"));
  mkdirSync(outsidePath);
  writeFileSync(path.join(rootPath, "inside.txt"), secretContents, "utf8");
  writeFileSync(path.join(rootPath, "binary.bin"), binaryContents);
  writeFileSync(path.join(rootPath, ".env"), "SECRET=do-not-read\n", "utf8");
  writeFileSync(path.join(rootPath, "nested", ".secret"), "nested\n", "utf8");
  writeFileSync(path.join(outsidePath, "outside.txt"), "outside\n", "utf8");
  symlinkSync(
    path.join(outsidePath, "outside.txt"),
    path.join(rootPath, "escape-link.txt"),
    "file",
  );

  const fixture = {
    adapter: createLocalReadonlyAdapter({
      adapterId: "adapter.amca.local_readonly.read_file",
      capabilityId,
      toolId,
      rootPath,
      receiptType,
      observationType,
      clock: () => observedAt,
    }),
    adapterId: "adapter.amca.local_readonly.read_file",
    binaryContents,
    rootPath,
    secretContents,
  };

  try {
    await callback(fixture);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

async function executeRead(
  fixture: LocalReadonlyFixture,
  requestedPath: string,
  options: { readonly maxBytes?: number } = {},
): Promise<EffectAdapterResult> {
  const adapter = createLocalReadonlyAdapter({
    adapterId: fixture.adapterId,
    capabilityId,
    toolId,
    rootPath: fixture.rootPath,
    receiptType,
    observationType,
    clock: () => observedAt,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });

  return adapter.execute(requestFor(requestedPath), { now: () => observedAt });
}

function requestFor(requestedPath: string): CertifiedEffectRequest {
  return {
    toolCommand: {
      kind: "tool_command_request",
      commandId: `command_${sanitizeId(requestedPath)}`,
      runId,
      capabilityId,
      toolId,
      args: {
        path: requestedPath,
      },
      sideEffectClass: "read",
    },
    effectRequest: {
      effectId: `effect_${sanitizeId(requestedPath)}`,
      commandId: `command_${sanitizeId(requestedPath)}`,
      runId,
      capabilityId,
      toolId,
      args: {
        path: requestedPath,
      },
      sideEffectClass: "read",
      requestedAt: observedAt,
    },
    capability: {
      schemaVersion: 1,
      capabilityId,
      profile: "standard",
      sideEffectClass: "read",
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
        {
          evidenceKind: "external_observation",
          observationType,
        },
      ],
      supportedClaims: [],
      proofRules: [],
    },
  };
}

function requiredObservationCandidate(
  result: EffectAdapterResult,
): NonNullable<EffectAdapterResult["externalStateObservationCandidate"]> {
  if (result.externalStateObservationCandidate === undefined) {
    throw new Error("Expected local_readonly adapter to emit an observation.");
  }
  return result.externalStateObservationCandidate;
}

function requiredReceiptCandidate(
  result: EffectAdapterResult,
): NonNullable<EffectAdapterResult["receiptCandidate"]> {
  if (result.receiptCandidate === undefined) {
    throw new Error("Expected local_readonly adapter to emit a receipt.");
  }
  return result.receiptCandidate;
}

function reasonOf(payload: JsonObject): FilesystemReadFailureReason {
  const reason = payload.reason;
  if (typeof reason !== "string") {
    throw new Error("Expected failure payload to contain reason.");
  }
  return reason as FilesystemReadFailureReason;
}

function stringField(object: JsonObject, field: string): string {
  const value = object[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return value;
}

function jsonKeys(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => jsonKeys(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...jsonKeys(item),
    ]);
  }
  return [];
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
