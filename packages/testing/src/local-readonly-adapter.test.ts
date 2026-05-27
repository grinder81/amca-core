import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CapabilityContract } from "@amca/capabilities";
import { createFilesystemReadAdapter } from "@amca/adapters-tools";
import { EffectBrokerError, InMemoryEffectBroker } from "@amca/effect-broker";
import type { ReceiptCandidate, ToolCommandRequest } from "@amca/protocol";
import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-05-25T12:00:00.000Z";
const receiptType = "filesystem.file_read";
const tempRoots: string[] = [];

describe("createFilesystemReadAdapter", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) =>
        rm(tempRoot, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("is rejected by broker defaults unless local_readonly is explicitly allowed", async () => {
    const rootDir = await tempRoot();
    await writeFile(path.join(rootDir, "safe.txt"), "hello");
    const command = readCommand("safe.txt");

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [adapter(rootDir)],
          capabilities: [capability()],
          clock: () => NOW,
        }),
      "adapter_certification_kind_forbidden",
    );

    const readBroker = broker(rootDir);
    await expect(readBroker.dispatch(command)).resolves.toMatchObject({
      receiptCandidate: {
        receiptType,
        status: "succeeded",
      },
    });
  });

  it("reads only metadata and hashes for files inside the configured root", async () => {
    const rootDir = await tempRoot();
    await mkdir(path.join(rootDir, "nested"));
    await writeFile(path.join(rootDir, "nested", "safe.txt"), "hello amca");

    const result = await broker(rootDir).dispatch(
      readCommand("nested/safe.txt"),
    );

    expect(result.receiptCandidate.status).toBe("succeeded");
    expect(result.receiptCandidate.payload).toEqual({
      result: "read",
      path: path.join("nested", "safe.txt"),
      contentHash: sha256("hello amca"),
      metadata: {
        byteLength: 10,
        redaction: "content_hash_only",
      },
    });
    expect(JSON.stringify(result.receiptCandidate.payload)).not.toContain(
      "hello amca",
    );
    expect(result.receiptCandidate.evidence).toEqual([
      expect.objectContaining({
        kind: "effect_receipt",
        hash: result.receiptCandidate.payloadHash,
        metadata: {
          redaction: "content_hash_only",
        },
        sensitivity: "internal",
      }),
    ]);
    expect(result.receiptCandidate.evidence[0]).not.toHaveProperty(
      "sourceEventId",
    );
  });

  it("fails closed for traversal, absolute paths, missing files, directories, and oversized files", async () => {
    const rootDir = await tempRoot();
    await mkdir(path.join(rootDir, "dir"));
    await writeFile(path.join(rootDir, "small.txt"), "ok");
    await writeFile(path.join(rootDir, "large.txt"), "too large");

    await expectFailedRead(rootDir, "../outside.txt", "invalid_path");
    await expectFailedRead(
      rootDir,
      path.join(rootDir, "small.txt"),
      "invalid_path",
    );
    await expectFailedRead(rootDir, "missing.txt", "not_found");
    await expectFailedRead(rootDir, "dir", "directory_not_allowed");

    const oversized = await broker(rootDir, { maxBytes: 3 }).dispatch(
      readCommand("large.txt"),
    );
    expectFailure(oversized.receiptCandidate, "file_too_large");
  });

  it("blocks symlink escape from the configured root", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    await writeFile(path.join(outsideDir, "secret.txt"), "do not leak");
    await symlink(
      path.join(outsideDir, "secret.txt"),
      path.join(rootDir, "link"),
    );

    const result = await broker(rootDir).dispatch(readCommand("link"));

    expectFailure(result.receiptCandidate, "outside_root");
    expect(JSON.stringify(result.receiptCandidate.payload)).not.toContain(
      "do not leak",
    );
  });
});

function adapter(
  rootDir: string,
  options: { readonly maxBytes?: number } = {},
) {
  return createFilesystemReadAdapter({
    adapterId: "adapter.filesystem.read",
    capabilityId: "filesystem.read",
    toolId: "filesystem.read",
    rootDir,
    receiptType,
    clock: () => NOW,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
}

function broker(
  rootDir: string,
  options: { readonly maxBytes?: number } = {},
): InMemoryEffectBroker {
  return new InMemoryEffectBroker({
    adapters: [adapter(rootDir, options)],
    capabilities: [capability()],
    allowedAdapterKinds: ["local_readonly"],
    clock: () => NOW,
  });
}

function capability(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: "filesystem.read",
    profile: "standard",
    sideEffectClass: "read",
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
    supportedClaims: [],
    proofRules: [],
  };
}

function readCommand(requestedPath: string): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `cmd_${requestedPath.replace(/[^A-Za-z0-9_-]/gu, "_")}`,
    runId: "run_filesystem_read_adapter",
    capabilityId: "filesystem.read",
    toolId: "filesystem.read",
    args: {
      path: requestedPath,
    },
    sideEffectClass: "read",
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "amca-readonly-"));
  tempRoots.push(root);
  return root;
}

async function expectFailedRead(
  rootDir: string,
  requestedPath: string,
  reason: string,
): Promise<void> {
  const result = await broker(rootDir).dispatch(readCommand(requestedPath));
  expectFailure(result.receiptCandidate, reason);
}

function expectFailure(receipt: ReceiptCandidate, reason: string): void {
  expect(receipt.status).toBe("failed");
  expect(receipt.payload).toMatchObject({
    result: "failed",
    reason,
  });
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
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
