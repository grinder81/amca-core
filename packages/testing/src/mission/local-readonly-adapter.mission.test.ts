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
  PendingEvidenceRef,
  ToolCommandRequest,
} from "@amca/protocol";
import { replayRunEvents } from "@amca/replay";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
const capabilityId = "amca.local_readonly.read_file";
const toolId = "local_readonly.read_file";
const receiptType = "local_readonly.file_read";
const observationType = "local_readonly.file_snapshot";

describe("Mission local readonly adapter conformance", () => {
  it("rejects local_readonly adapters by broker default unless explicitly allowed", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const counted = adapterWithExecutionCount(fixture.adapter);
      expect(
        () =>
          new InMemoryEffectBroker({
            adapters: [counted.adapter],
            capabilities: [fixture.capability],
            clock: () => now,
          }),
      ).toThrow(EffectBrokerError);
      expect(counted.calls()).toBe(0);

      const broker = allowedBroker(fixture);
      await expect(
        broker.dispatch(fixture.command("inside.txt")),
      ).resolves.toMatchObject({
        status: "dispatched",
        receiptCandidate: {
          receiptType,
          status: "succeeded",
        },
      });
    });
  });

  it("blocks broker-only pending local_readonly evidence before kernel admission", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const broker = allowedBroker(fixture);
      const command = fixture.command("inside.txt");
      const dispatch = await broker.dispatch(command);
      const observation = dispatch.externalStateObservationCandidate;
      if (observation === undefined) {
        throw new Error(
          "local_readonly adapter must emit an ExternalStateObservationCandidate for successful reads.",
        );
      }
      const pendingEvidenceRef = observation.evidence[0];
      if (pendingEvidenceRef === undefined) {
        throw new Error(
          "local_readonly adapter observation must carry pending evidence.",
        );
      }

      expect(pendingEvidenceRef.admissionStatus).toBe("pending");
      expect(pendingEvidenceRef).not.toHaveProperty("sourceEventId");

      const unadmittedEvidenceRef = expectedObservationEvidenceRef(
        pendingEvidenceRef,
        command.commandId,
      );

      const harness = new LocalRunHarness({
        runId: fixture.runId,
        clock: () => now,
      });
      harness.startRun({
        occurredAt: STARTED_AT,
        profile: "standard",
      });

      const result = harness.submitFinalCandidate(
        candidateWith(
          fixture.runId,
          currentFileHashClaim(
            unadmittedEvidenceRef,
            stringField(observation.observedState, "contentHash"),
          ),
        ),
        {
          generatedAt: GENERATED_AT,
          occurredAt: GENERATED_AT,
        },
      );

      expect(result.decision.status).toBe("blocked");
      expect(result.finalReleasedEvent).toBeUndefined();
      expect(result.proof.blockingMismatches).toContainEqual(
        expect.objectContaining({
          type: "unsupported_claim",
          blocking: true,
        }),
      );
      expect(eventTypes(harness.kernel)).not.toContain("FinalReleased");
    });
  });

  it("allows opt-in local_readonly reads only inside the configured root", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const broker = allowedBroker(fixture);
      const allowed = await broker.dispatch(fixture.command("inside.txt"));

      expect(allowed.receiptCandidate.status).toBe("succeeded");
      expect(allowed.externalStateObservationCandidate).toMatchObject({
        observationType,
        subjectType: "local_file",
        subjectId: "inside.txt",
      });

      await expectNotSuccessfulEvidence(
        broker.dispatch(fixture.command("../outside.txt")),
      );
      await expectNotSuccessfulEvidence(
        broker.dispatch(fixture.command(fixture.outsideFile)),
      );
      await expectNotSuccessfulEvidence(
        broker.dispatch(fixture.command("escape-link.txt")),
      );
    });
  });

  it("rejects attempts to use local_readonly as a write-class adapter", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const broker = allowedBroker(fixture);
      const writeAttempt: ToolCommandRequest = {
        ...fixture.command("inside.txt"),
        commandId: "command_local_readonly_write_attempt",
        idempotencyKey: "local-readonly-write-attempt",
        sideEffectClass: "idempotent_write",
      };

      await expectBrokerError(
        broker.dispatch(writeAttempt),
        "side_effect_class_mismatch",
      );
    });
  });

  it("does not turn directories or missing files into successful evidence", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const broker = allowedBroker(fixture);

      await expectNotSuccessfulEvidence(
        broker.dispatch(fixture.command("nested")),
      );
      await expectNotSuccessfulEvidence(
        broker.dispatch(fixture.command("missing.txt")),
      );
    });
  });

  it("does not let a failed local_readonly receipt support a current-state claim", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const harness = governedHarness(fixture);
      harness.startRun({
        occurredAt: STARTED_AT,
        profile: "standard",
      });

      const dispatch = await harness.dispatchToolCommand(
        fixture.command("missing.txt"),
      );
      const receiptEvidence = dispatch.recordedReceipt.evidence[0];
      if (receiptEvidence === undefined) {
        throw new Error("Failed local_readonly receipts must still be typed.");
      }

      expect(dispatch.recordedReceipt.status).toBe("failed");
      expect(dispatch.recordedExternalStateObservation).toBeUndefined();

      const result = harness.submitFinalCandidate(
        candidateWith(
          fixture.runId,
          currentFileHashClaim(
            receiptEvidence,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
        ),
        {
          generatedAt: GENERATED_AT,
          occurredAt: GENERATED_AT,
        },
      );

      expect(result.decision.status).toBe("blocked");
      expect(result.finalReleasedEvent).toBeUndefined();
      expect(result.proof.blockingMismatches).toContainEqual(
        expect.objectContaining({
          type: "missing_evidence",
          blocking: true,
        }),
      );
    });
  });

  it("returns hash and metadata in receipts without raw file content", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const broker = allowedBroker(fixture);
      const dispatch = await broker.dispatch(fixture.command("inside.txt"));

      expect(dispatch.receiptCandidate.status).toBe("succeeded");
      expect(
        stringField(dispatch.receiptCandidate.payload, "contentHash"),
      ).toMatch(/^sha256:[a-f0-9]{64}$/u);
      const metadata = objectField(
        dispatch.receiptCandidate.payload,
        "metadata",
      );
      expect(metadata.byteLength).toBe(fixture.fileContents.length);
      expect(
        jsonContains(dispatch.receiptCandidate.payload, fixture.fileContents),
      ).toBe(false);
      expect(jsonKeys(dispatch.receiptCandidate.payload)).not.toEqual(
        expect.arrayContaining(["body", "content", "rawContent", "text"]),
      );
      expect(dispatch.receiptCandidate.evidence).toEqual([
        expect.objectContaining({
          hash: dispatch.receiptCandidate.payloadHash,
          kind: "effect_receipt",
          metadata: {
            redaction: "content_hash_only",
          },
        }),
      ]);
      expect(dispatch.receiptCandidate.evidence[0]).not.toHaveProperty(
        "sourceEventId",
      );
    });
  });

  it("blocks local_readonly current-state claims after observation freshness expires", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const harness = governedHarness(fixture);
      harness.startRun({
        occurredAt: STARTED_AT,
        profile: "standard",
      });

      const dispatch = await harness.dispatchToolCommand(
        fixture.command("inside.txt"),
      );
      const observation = dispatch.recordedExternalStateObservation;
      if (observation === undefined) {
        throw new Error(
          "local_readonly adapter must emit an admitted observation for successful reads.",
        );
      }
      const evidenceRef = observation.evidence[0];
      if (evidenceRef === undefined) {
        throw new Error(
          "local_readonly adapter observation must carry first-class evidence.",
        );
      }

      const result = harness.submitFinalCandidate(
        candidateWith(
          fixture.runId,
          currentFileHashClaim(
            evidenceRef,
            stringField(observation.observedState, "contentHash"),
            {
              freshnessRequirementMs: 60_000,
            },
          ),
        ),
        {
          generatedAt: "2026-05-24T12:01:01.000Z",
          occurredAt: "2026-05-24T12:01:01.000Z",
        },
      );

      expect(result.decision.status).toBe("blocked");
      expect(result.finalReleasedEvent).toBeUndefined();
      expect(result.proof.blockingMismatches).toContainEqual(
        expect.objectContaining({
          type: "stale_external_state",
          blocking: true,
        }),
      );
    });
  });

  it("does not expose proof, release, or admission authority on the adapter object", async () => {
    await withLocalReadonlyFixture((fixture) => {
      const forbiddenAuthorityMethods = [
        "admitObservation",
        "admitReceipt",
        "decideRelease",
        "evaluateProof",
        "recordEffectReceipt",
        "recordExternalStateObservation",
        "release",
        "submitFinalCandidate",
      ];
      const adapterSurface = fixture.adapter as unknown as Record<
        string,
        unknown
      >;

      for (const method of forbiddenAuthorityMethods) {
        expect(
          adapterSurface[method],
          `adapter must not expose ${method}`,
        ).toBe(undefined);
      }
      expect(typeof adapterSurface.execute).toBe("function");
      return Promise.resolve();
    });
  });

  it("replays and re-evaluates from admitted events without redispatching the adapter", async () => {
    await withLocalReadonlyFixture(async (fixture) => {
      const counted = adapterWithExecutionCount(fixture.adapter);
      const harness = new LocalRunHarness({
        runId: fixture.runId,
        clock: () => now,
        brokerOptions: {
          adapters: [counted.adapter],
          capabilities: [fixture.capability],
          allowedAdapterKinds: ["local_readonly"],
          clock: () => now,
        },
      });
      harness.startRun({
        occurredAt: STARTED_AT,
        profile: "standard",
      });

      const dispatch = await harness.dispatchToolCommand(
        fixture.command("inside.txt"),
      );
      const observation = dispatch.recordedExternalStateObservation;
      if (observation === undefined) {
        throw new Error(
          "local_readonly adapter must emit an ExternalStateObservation for successful reads.",
        );
      }
      const contentHash = stringField(observation.observedState, "contentHash");
      const evidenceRef = observation.evidence[0];
      if (evidenceRef === undefined) {
        throw new Error(
          "local_readonly adapter observation must carry first-class evidence.",
        );
      }

      const finalCandidate = candidateWith(
        fixture.runId,
        currentFileHashClaim(evidenceRef, contentHash),
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
      expect(
        replayRunEvents({ events: harness.kernel.events() }),
      ).toMatchObject({
        status: "passed",
        runId: fixture.runId,
        replayedDecision: {
          status: "released",
        },
      });
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
          (type) => type === "ExternalStateObserved",
        ),
      ).toHaveLength(1);
    });
  });
});

interface LocalReadonlyAdapterFactoryInput {
  readonly adapterId?: string;
  readonly rootPath: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly receiptType: string;
  readonly observationType: string;
  readonly clock: () => string;
}

interface LocalReadonlyAdapterModule {
  readonly createLocalReadonlyAdapter: (
    input: LocalReadonlyAdapterFactoryInput,
  ) => EffectAdapter;
}

interface LocalReadonlyFixture {
  readonly adapter: EffectAdapter;
  readonly capability: CapabilityContract;
  readonly fileContents: string;
  readonly outsideFile: string;
  readonly root: string;
  readonly runId: string;
  readonly command: (filePath: string) => ToolCommandRequest;
}

async function withLocalReadonlyFixture(
  callback: (fixture: LocalReadonlyFixture) => Promise<void>,
): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "amca-local-readonly-"));
  const adapterRoot = path.join(tempRoot, "root");
  const outsideRoot = path.join(tempRoot, "outside");
  const outsideFile = path.join(outsideRoot, "outside.txt");
  const fileContents = "AMCA local read fixture\n";

  mkdirSync(adapterRoot);
  mkdirSync(path.join(adapterRoot, "nested"));
  mkdirSync(outsideRoot);
  writeFileSync(path.join(adapterRoot, "inside.txt"), fileContents, "utf8");
  writeFileSync(outsideFile, "outside root\n", "utf8");
  symlinkSync(outsideFile, path.join(adapterRoot, "escape-link.txt"));

  try {
    const module = await loadLocalReadonlyAdapterModule();
    const runId = `mission_local_readonly_${String(Date.now())}`;
    const adapter = module.createLocalReadonlyAdapter({
      adapterId: "adapter.amca.local_readonly.read_file",
      rootPath: adapterRoot,
      capabilityId,
      toolId,
      receiptType,
      observationType,
      clock: () => now,
    });

    await callback({
      adapter,
      capability: localReadonlyCapability(),
      command: (filePath) => localReadonlyCommand(runId, filePath),
      fileContents,
      outsideFile,
      root: adapterRoot,
      runId,
    });
  } finally {
    rmSync(tempRoot, {
      force: true,
      recursive: true,
    });
  }
}

async function loadLocalReadonlyAdapterModule(): Promise<LocalReadonlyAdapterModule> {
  let module: unknown;
  try {
    module = await import(adapterModuleUrl);
  } catch (error) {
    throw new Error(
      `Phase 18 local_readonly adapter conformance requires ${adapterModuleUrl}. Baseline is expected to fail until the governed adapter package is added. ${String(error)}`,
      { cause: error },
    );
  }

  if (
    typeof module !== "object" ||
    module === null ||
    !("createLocalReadonlyAdapter" in module) ||
    typeof module.createLocalReadonlyAdapter !== "function"
  ) {
    throw new Error(
      "packages/adapters-tools must export createLocalReadonlyAdapter(input): EffectAdapter.",
    );
  }

  return module as LocalReadonlyAdapterModule;
}

function allowedBroker(fixture: LocalReadonlyFixture): InMemoryEffectBroker {
  return new InMemoryEffectBroker({
    adapters: [fixture.adapter],
    capabilities: [fixture.capability],
    allowedAdapterKinds: ["local_readonly"],
    clock: () => now,
  });
}

function governedHarness(fixture: LocalReadonlyFixture): LocalRunHarness {
  return new LocalRunHarness({
    runId: fixture.runId,
    clock: () => now,
    brokerOptions: {
      adapters: [fixture.adapter],
      capabilities: [fixture.capability],
      allowedAdapterKinds: ["local_readonly"],
      clock: () => now,
    },
  });
}

async function expectNotSuccessfulEvidence(
  dispatch: Promise<EffectDispatchResult>,
): Promise<void> {
  try {
    const result = await dispatch;
    expect(result.receiptCandidate.status).not.toBe("succeeded");
    expect(result.externalStateObservationCandidate).toBeUndefined();
  } catch (error) {
    expect(error).toBeInstanceOf(EffectBrokerError);
  }
}

async function expectBrokerError(
  promise: Promise<unknown>,
  code: EffectBrokerError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "EffectBrokerError",
    code,
  });
}

function localReadonlyCapability(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId,
    profile: "standard",
    sideEffectClass: "read",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    receiptSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        contentHash: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["path", "contentHash", "metadata"],
      additionalProperties: false,
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
    supportedClaims: [
      {
        claimType: "current_state",
        predicateKind: "current_state",
        observationType,
        supportedOperators: ["equals"],
        maximumFreshnessRequirementMs: 300_000,
      },
    ],
    proofRules: [],
    metadata: {
      authorityBoundary: "governed_local_readonly",
    },
  };
}

function localReadonlyCommand(
  runId: string,
  filePath: string,
): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `command_local_readonly_${sanitizeId(filePath)}`,
    runId,
    capabilityId,
    toolId,
    args: {
      path: filePath,
    },
    sideEffectClass: "read",
  };
}

function currentFileHashClaim(
  evidenceRef: Claim["evidenceRefs"][number],
  contentHash: string,
  options: {
    readonly freshnessRequirementMs?: number;
  } = {},
): Claim {
  return {
    claimId: "claim_local_file_hash_current",
    type: "current_state",
    statement: "Local file content hash matches the observed read.",
    predicate: {
      kind: "current_state",
      subjectType: "local_file",
      subjectId: "inside.txt",
      property: "contentHash",
      operator: "equals",
      expectedValue: contentHash,
      observationType,
      freshnessRequirementMs: options.freshnessRequirementMs ?? 300_000,
    },
    evidenceRefs: [evidenceRef],
    criticality: "medium",
  };
}

function expectedObservationEvidenceRef(
  pendingEvidenceRef: PendingEvidenceRef,
  commandId: string,
): Claim["evidenceRefs"][number] {
  return {
    evidenceId: pendingEvidenceRef.evidenceId,
    kind: pendingEvidenceRef.kind,
    sourceEventId: observationEventIdForCommand(commandId),
    hash: pendingEvidenceRef.hash,
    observedAt: pendingEvidenceRef.observedAt,
    sensitivity: pendingEvidenceRef.sensitivity,
    ...(pendingEvidenceRef.artifactUri === undefined
      ? {}
      : { artifactUri: pendingEvidenceRef.artifactUri }),
    ...(pendingEvidenceRef.expiresAt === undefined
      ? {}
      : { expiresAt: pendingEvidenceRef.expiresAt }),
    ...(pendingEvidenceRef.metadata === undefined
      ? {}
      : { metadata: pendingEvidenceRef.metadata }),
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

function stringField(object: JsonObject, field: string): string {
  const value = object[field];
  if (typeof value !== "string") {
    throw new Error(`Expected observedState.${field} to be a string.`);
  }
  return value;
}

function objectField(object: JsonObject, field: string): JsonObject {
  const value = object[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an object.`);
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

function observationEventIdForCommand(commandId: string): string {
  return `evt_${sanitizeId(commandId)}_external_state_observed`;
}
