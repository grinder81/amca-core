import { describe, expect, it } from "vitest";

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWritePreflightCandidate,
  EffectBrokerError,
  InMemoryEffectBroker,
} from "@amca/effect-broker";
import type { AdapterCertification, EffectAdapter } from "@amca/effect-sdk";
import { hashRunEventPayload } from "@amca/kernel";
import type {
  EvidenceRef,
  PendingEvidenceRef,
  ReceiptCandidate,
  SideEffectClass,
  ToolCommandRequest,
  WriteQuarantineState,
} from "@amca/protocol";

import {
  candidateWith,
  effectEvidenceRef,
  eventTypes,
  expectRunKernelError,
  FRESH_OBSERVED_AT,
  GENERATED_AT,
  historicalActionClaim,
  pullRequestEffectRequest,
  pullRequestPayload,
  pullRequestReceipt,
  startedKernel,
} from "./mission-helpers.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const now = "2026-05-24T12:00:00.000Z";

describe("Mission P4 side-effect safety", () => {
  it("models write-capable effects as requests before receipts even before Effect Broker exists", () => {
    const runId = "mission_side_effect_request_first";
    const receiptEventId = "evt_mission_write_receipt";
    const payload = pullRequestPayload();
    const evidenceRef = effectEvidenceRef(
      "ev_mission_write_receipt",
      hashRunEventPayload(payload),
      {
        sourceEventId: receiptEventId,
      },
    );
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(pullRequestEffectRequest(runId));
    const event = kernel.recordEffectReceipt(
      pullRequestReceipt(runId, {
        evidence: [evidenceRef],
        payload,
      }),
      {
        eventId: receiptEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );

    expect(event.payload.receipt.effectId).toBe("effect_pr_001");
    expect(event.payload.receipt.evidence).toEqual([evidenceRef]);
  });

  it("blocks write receipt admission without an AMCA effect request", () => {
    const runId = "mission_side_effect_no_request";
    const receiptEventId = "evt_mission_write_without_request";
    const payload = pullRequestPayload();
    const kernel = startedKernel(runId);

    expectRunKernelError(
      () =>
        kernel.recordEffectReceipt(
          pullRequestReceipt(runId, {
            evidence: [
              effectEvidenceRef(
                "ev_write_without_request",
                hashRunEventPayload(payload),
                {
                  sourceEventId: receiptEventId,
                },
              ),
            ],
            payload,
          }),
          {
            eventId: receiptEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "effect_request_not_found",
    );
  });

  it("dispatches allowed effects only through the broker and returns receipts", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = brokerCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [missionAdapter(command, calls)],
      capabilities: [missionCapability(command, "test_run")],
      clock: () => now,
    });

    const result = await broker.dispatch(command);

    expect(result.status).toBe("dispatched");
    expect(result.effectRequest.capabilityId).toBe(command.capabilityId);
    expect(result.receiptCandidate.effectId).toBe(
      result.effectRequest.effectId,
    );
    expect(result.receiptCandidate.evidence[0]).not.toHaveProperty(
      "sourceEventId",
    );
    expect(calls).toHaveLength(1);
  });

  it("blocks unknown tools, missing idempotency keys, and critical writes", async () => {
    const compute = brokerCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });

    await expectBrokerError(
      new InMemoryEffectBroker({
        capabilities: [missionCapability(compute, "test_run")],
        clock: () => now,
      }).dispatch(compute),
      "tool_not_registered",
    );

    const write = brokerCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [missionAdapter(write, [], "github.pull_request_created")],
        capabilities: [missionCapability(write, "github.pull_request_created")],
        clock: () => now,
      }).dispatch(write),
      "idempotency_key_required",
    );

    const critical = brokerCommand({
      capabilityId: "ops.critical_write",
      idempotencyKey: "critical-write-001",
      sideEffectClass: "critical_write",
      toolId: "ops.critical_write",
    });
    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [missionAdapter(critical, [], "critical_write_receipt")],
          capabilities: [missionCapability(critical, "critical_write_receipt")],
          clock: () => now,
        }),
      "critical_write_requires_approval",
    );
  });

  it("deduplicates idempotent writes and blocks conflicting key reuse", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-001",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [missionAdapter(command, calls)],
      capabilities: [missionCapability(command, "test_run")],
      clock: () => now,
    });

    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });
    const first = await broker.dispatchWithPreflight(command, {
      preflightDecision: decision,
    });
    const second = await broker.dispatchWithPreflight(command, {
      preflightDecision: decision,
    });

    expect(first.status).toBe("dispatched");
    expect(second.status).toBe("cached");
    expect(calls).toHaveLength(1);

    const conflictingCommand = {
      ...command,
      args: { title: "conflict" },
    };
    const conflictingDecision = broker.preflightWrite(conflictingCommand, {
      decidedAt: now,
      requestedAt: now,
    });

    await expectBrokerError(
      broker.dispatchWithPreflight(conflictingCommand, {
        preflightDecision: conflictingDecision,
      }),
      "duplicate_idempotency_key_conflict",
    );
  });

  it("blocks direct write dispatch without broker-issued preflight", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-direct-blocked",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [missionAdapter(command, calls, "github.pull_request_created")],
      capabilities: [missionCapability(command, "github.pull_request_created")],
      clock: () => now,
    });

    await expectBrokerError(
      broker.dispatch(command),
      "write_preflight_required",
    );
    expect(calls).toHaveLength(0);
  });

  it("write-preflight-allowed-does-not-execute", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-preflight-001",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [missionAdapter(command, calls, "github.pull_request_created")],
      capabilities: [missionCapability(command, "github.pull_request_created")],
      clock: () => now,
    });

    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });

    expect(decision.status).toBe("allowed");
    expect(calls).toHaveLength(0);

    await broker.dispatchWithPreflight(command, {
      preflightDecision: decision,
    });

    expect(calls).toHaveLength(1);
  });

  it("write-preflight-denied-blocks-dispatch", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [missionAdapter(command, calls, "github.pull_request_created")],
      capabilities: [missionCapability(command, "github.pull_request_created")],
      clock: () => now,
    });

    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });

    expect(decision).toMatchObject({
      status: "denied",
      reason: "missing_idempotency_key",
    });
    await expectBrokerError(
      broker.dispatchWithPreflight(command, { preflightDecision: decision }),
      "write_preflight_denied",
    );
    expect(calls).toHaveLength(0);
  });

  it("quarantines adapter errors without creating receipt evidence", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-error-quarantine",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        missionAdapter(command, calls, "github.pull_request_created", {
          adapterKind: "external_write",
          throwOnExecute: true,
        }),
      ],
      allowedAdapterKinds: ["external_write"],
      capabilities: [missionCapability(command, "github.pull_request_created")],
      clock: () => now,
    });
    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });

    await expectBrokerErrorWithQuarantine(
      broker.dispatchWithPreflight(command, { preflightDecision: decision }),
      "adapter_write_quarantined",
    );
    expect(calls).toHaveLength(1);
  });

  it("quarantined-write-result-cannot-support-proof", () => {
    const command = brokerCommand({
      capabilityId: "ops.critical_write",
      idempotencyKey: "mission-critical-preflight-001",
      sideEffectClass: "critical_write",
      toolId: "ops.critical_write",
    });
    const broker = new InMemoryEffectBroker({ clock: () => now });
    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });

    expect(decision.status).toBe("quarantined");
    if (decision.status !== "quarantined") {
      throw new Error("Expected critical write preflight to quarantine.");
    }

    const quarantine = decision.quarantine satisfies WriteQuarantineState;
    expect(quarantine).toMatchObject({
      kind: "write_quarantine_state",
      status: "quarantined",
      reason: "critical_approval_required",
    });
    expect(quarantine).not.toHaveProperty("receiptId");
    expect(quarantine).not.toHaveProperty("payloadHash");
    expect(quarantine).not.toHaveProperty("evidence");
    expect(quarantine).not.toHaveProperty("sourceEventId");
  });

  it("quarantined-write-blocks-release", () => {
    const runId = "mission_write_quarantine_blocks_release";
    const command = brokerCommand({
      capabilityId: "ops.critical_write",
      idempotencyKey: "mission-critical-preflight-002",
      sideEffectClass: "critical_write",
      toolId: "ops.critical_write",
    });
    const broker = new InMemoryEffectBroker({ clock: () => now });
    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });
    const kernel = startedKernel(runId);

    const result = kernel.submitFinalCandidate(
      candidateWith(runId, historicalActionClaim({ evidenceRefs: [] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(decision.status).toBe("quarantined");
    expect(result.decision.status).toBe("blocked");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("write-success-candidate-cannot-support-claim-before-effect-receipt-recorded", async () => {
    const runId = "mission_write_candidate_before_receipt_recorded";
    const calls: ToolCommandRequest[] = [];
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-candidate-pending",
      runId,
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [missionAdapter(command, calls, "github.pull_request_created")],
      capabilities: [missionCapability(command, "github.pull_request_created")],
      clock: () => now,
    });
    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });
    const dispatch = await broker.dispatchWithPreflight(command, {
      preflightDecision: decision,
    });
    const candidateEvidence = dispatch.receiptCandidate.evidence[0];
    if (candidateEvidence === undefined) {
      throw new Error("Expected write receipt candidate evidence.");
    }

    expect(dispatch.status).toBe("dispatched");
    expect(candidateEvidence).toMatchObject({
      admissionStatus: "pending",
      kind: "effect_receipt",
    });
    expect(candidateEvidence).not.toHaveProperty("sourceEventId");
    expect(calls).toHaveLength(1);

    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(dispatch.effectRequest);

    const result = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        historicalActionClaim({
          evidenceRefs: [
            admittedEvidenceRefFromPending(
              candidateEvidence,
              "evt_unrecorded_effect_receipt_candidate",
            ),
          ],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(result.decision.status).toBe("blocked");
    expect(result.mismatchEvents[0]?.payload.mismatch.type).toBe(
      "unverified_receipt",
    );
    expect(eventTypes(kernel)).not.toContain("EffectReceiptRecorded");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("write-success-candidate-with-matching-shape-but-no-ledger-event-blocked", () => {
    const runId = "mission_matching_write_shape_without_ledger_event";
    const receiptEventId = "evt_orphan_write_receipt";
    const payload = pullRequestPayload();
    const evidenceRef = effectEvidenceRef(
      "ev_orphan_write_receipt",
      hashRunEventPayload(payload),
      {
        sourceEventId: receiptEventId,
      },
    );
    const orphanReceipt = pullRequestReceipt(runId, {
      evidence: [evidenceRef],
      payload,
    });
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(pullRequestEffectRequest(runId));

    const result = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        historicalActionClaim({ evidenceRefs: orphanReceipt.evidence }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(orphanReceipt).toMatchObject({
      receiptType: "github.pull_request_created",
      status: "succeeded",
      payload,
      evidence: [evidenceRef],
    });
    expect(result.decision.status).toBe("blocked");
    expect(result.mismatchEvents[0]?.payload.mismatch.type).toBe(
      "unverified_receipt",
    );
    expect(eventTypes(kernel)).not.toContain("EffectReceiptRecorded");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("broker-quarantine-cannot-support-claim", () => {
    const runId = "mission_broker_quarantine_cannot_support_claim";
    const command = brokerCommand({
      capabilityId: "ops.critical_write",
      idempotencyKey: "mission-critical-quarantine-claim",
      runId,
      sideEffectClass: "critical_write",
      toolId: "ops.critical_write",
    });
    const broker = new InMemoryEffectBroker({ clock: () => now });
    const preflightCandidate = createWritePreflightCandidate(command, {
      requestedAt: now,
    });
    const decision = broker.preflightWrite(command, {
      decidedAt: now,
      requestedAt: now,
    });
    const kernel = startedKernel(runId);

    expect(decision.status).toBe("quarantined");
    if (decision.status !== "quarantined") {
      throw new Error("Expected critical write preflight to quarantine.");
    }

    kernel.recordWritePreflightRequested(preflightCandidate);
    kernel.recordWritePreflightDecided(decision);
    kernel.recordWriteQuarantined(decision.quarantine);

    const result = kernel.submitFinalCandidate(
      candidateWith(runId, historicalActionClaim({ evidenceRefs: [] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(decision.quarantine).not.toHaveProperty("receiptId");
    expect(decision.quarantine).not.toHaveProperty("payloadHash");
    expect(decision.quarantine).not.toHaveProperty("evidence");
    expect(result.decision.status).toBe("blocked");
    expect(result.mismatchEvents[0]?.payload.mismatch.type).toBe(
      "missing_evidence",
    );
    expect(eventTypes(kernel)).toContain("WriteQuarantined");
    expect(eventTypes(kernel)).not.toContain("EffectReceiptRecorded");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("blocks write-capable adapters without lifecycle certification", () => {
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-001",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            missionAdapter(command, [], "github.pull_request_created", {
              writeLifecycle: false,
            }),
          ],
          capabilities: [
            missionCapability(command, "github.pull_request_created"),
          ],
          clock: () => now,
        }),
      "adapter_write_lifecycle_missing",
    );
  });

  it("blocks write-capable adapters without idempotency-key lifecycle certification", () => {
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-001",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            missionAdapter(command, [], "github.pull_request_created", {
              writeLifecycle: {
                ...defaultWriteLifecycle(),
                idempotencyKey: "adapter_enforced",
              },
            }),
          ],
          capabilities: [
            missionCapability(command, "github.pull_request_created"),
          ],
          clock: () => now,
        }),
      "adapter_write_lifecycle_invalid",
    );
  });

  it("blocks write-capable adapters that omit proof or release authority bans", () => {
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-001",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            missionAdapter(command, [], "github.pull_request_created", {
              writeLifecycle: {
                ...defaultWriteLifecycle(),
                forbiddenAuthority: ["receipt_admission", "release_authority"],
              },
            }),
          ],
          capabilities: [
            missionCapability(command, "github.pull_request_created"),
          ],
          clock: () => now,
        }),
      "adapter_write_lifecycle_invalid",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            missionAdapter(command, [], "github.pull_request_created", {
              writeLifecycle: {
                ...defaultWriteLifecycle(),
                forbiddenAuthority: ["receipt_admission", "proof_authority"],
              },
            }),
          ],
          capabilities: [
            missionCapability(command, "github.pull_request_created"),
          ],
          clock: () => now,
        }),
      "adapter_write_lifecycle_invalid",
    );
  });

  it("prevents read-only adapter kinds from claiming write capability", () => {
    const command = brokerCommand({
      capabilityId: "github.create_pull_request",
      idempotencyKey: "mission-pr-001",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            missionAdapter(command, [], "github.pull_request_created", {
              adapterKind: "local_readonly",
            }),
          ],
          allowedAdapterKinds: ["local_readonly"],
          capabilities: [
            missionCapability(command, "github.pull_request_created"),
          ],
          clock: () => now,
        }),
      "adapter_certification_invalid",
    );
  });

  it("does not give effect packages release authority or real execution hooks", () => {
    const forbiddenTokens = [
      "FinalReleased",
      "ReleaseDecided",
      "decideRelease",
      "child_process",
      "exec(",
      "execFile(",
      "spawn(",
      "fetch(",
    ];

    for (const sourceFile of sourceFiles(
      path.join(repoRoot, "packages/effect-broker/src"),
    ).concat(sourceFiles(path.join(repoRoot, "packages/effect-sdk/src")))) {
      const source = readFileSync(sourceFile, "utf8");
      for (const token of forbiddenTokens) {
        expect(source, `${sourceFile} must not contain ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});

function brokerCommand(input: {
  readonly capabilityId: string;
  readonly idempotencyKey?: string;
  readonly runId?: string;
  readonly sideEffectClass: SideEffectClass;
  readonly toolId: string;
}): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `cmd_${input.capabilityId.replace(/\./gu, "_")}`,
    runId: input.runId ?? "mission_side_effect_broker",
    capabilityId: input.capabilityId,
    toolId: input.toolId,
    args: { title: "mission" },
    sideEffectClass: input.sideEffectClass,
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
  };
}

function missionAdapter(
  command: ToolCommandRequest,
  calls: ToolCommandRequest[],
  receiptType = "test_run",
  options: {
    readonly adapterKind?: AdapterCertification["adapterKind"];
    readonly throwOnExecute?: boolean;
    readonly writeLifecycle?:
      | AdapterCertification["writeLifecycle"]
      | false
      | undefined;
  } = {},
): EffectAdapter {
  const writeLifecycle =
    options.writeLifecycle === false
      ? undefined
      : (options.writeLifecycle ??
        (isWriteSideEffectClass(command.sideEffectClass)
          ? defaultWriteLifecycle()
          : undefined));

  return {
    adapterId: `mission.${command.toolId}`,
    capabilityId: command.capabilityId,
    toolId: command.toolId,
    certification: {
      certificationVersion: 1,
      adapterId: `mission.${command.toolId}`,
      adapterKind: options.adapterKind ?? "deterministic_fake",
      capabilityId: command.capabilityId,
      toolId: command.toolId,
      sideEffectClass: command.sideEffectClass,
      declaredReceiptTypes: [receiptType],
      idempotency:
        command.sideEffectClass === "read" ||
        command.sideEffectClass === "compute"
          ? "not_required"
          : "required_for_writes",
      ...(writeLifecycle === undefined ? {} : { writeLifecycle }),
      riskProfile: "standard",
    },
    execute: (request) => {
      calls.push(command);
      if (options.throwOnExecute === true) {
        throw new Error("simulated uncertain external write outcome");
      }

      const payload = { result: "passed" };
      const payloadHash = hashRunEventPayload(payload);
      const receiptCandidate: ReceiptCandidate = {
        receiptId: `receipt_${request.effectRequest.effectId}`,
        effectId: request.effectRequest.effectId,
        runId: request.effectRequest.runId,
        capabilityId: request.effectRequest.capabilityId,
        receiptType,
        status: "succeeded",
        payload,
        payloadHash,
        observedAt: now,
        evidence: [
          pendingEvidenceRef({
            evidenceId: `ev_${request.effectRequest.effectId}`,
            kind: "effect_receipt",
            hash: payloadHash,
            observedAt: now,
            sensitivity: "internal",
          }),
        ],
      };

      return { receiptCandidate };
    },
  };
}

function isWriteSideEffectClass(sideEffectClass: SideEffectClass): boolean {
  return (
    sideEffectClass === "idempotent_write" ||
    sideEffectClass === "reversible_write" ||
    sideEffectClass === "irreversible_write" ||
    sideEffectClass === "critical_write"
  );
}

function defaultWriteLifecycle(): NonNullable<
  AdapterCertification["writeLifecycle"]
> {
  return {
    preflight: "required_before_dispatch",
    idempotencyKey: "tool_command_required",
    dispatch: "broker_governed",
    outcome: "receipt_candidate_or_quarantine_required",
    forbiddenAuthority: [
      "receipt_admission",
      "proof_authority",
      "release_authority",
    ],
  };
}

function pendingEvidenceRef(
  input: Omit<PendingEvidenceRef, "admissionStatus" | "pendingAdmissionToken">,
): PendingEvidenceRef {
  return {
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${input.evidenceId}`,
    ...input,
  };
}

function admittedEvidenceRefFromPending(
  pending: PendingEvidenceRef,
  sourceEventId: string,
): EvidenceRef {
  return {
    admissionStatus: "admitted",
    evidenceId: pending.evidenceId,
    kind: pending.kind,
    sourceEventId,
    hash: pending.hash,
    observedAt: pending.observedAt,
    sensitivity: pending.sensitivity,
    ...(pending.artifactUri === undefined
      ? {}
      : { artifactUri: pending.artifactUri }),
    ...(pending.expiresAt === undefined
      ? {}
      : { expiresAt: pending.expiresAt }),
    ...(pending.metadata === undefined ? {} : { metadata: pending.metadata }),
  };
}

function missionCapability(command: ToolCommandRequest, receiptType: string) {
  return {
    schemaVersion: 1,
    capabilityId: command.capabilityId,
    profile: "standard",
    sideEffectClass: command.sideEffectClass,
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
    proofRules: [
      {
        ruleId: `mission.${command.capabilityId}.test_result`,
        version: 1,
        claimType: "test_result",
        predicateKind: "test_result",
        description: "Mission test-result proof descriptor.",
        evidence: [
          {
            requirementId: "mission.effect_receipt",
            evidenceKind: "effect_receipt",
            source: "claim.evidenceRefs",
            minimumCount: 1,
            resolvesTo: "effect_receipt",
          },
        ],
        match: {
          operator: "all",
          clauses: [
            {
              kind: "field_equals",
              left: {
                source: "effect_receipt",
                path: "effectReceipt.receiptType",
              },
              right: {
                source: "claim_predicate",
                path: "claim.predicate.requiredReceiptType",
              },
              presence: "always",
            },
          ],
        },
      },
    ],
  } as const;
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

async function expectBrokerErrorWithQuarantine(
  promise: Promise<unknown>,
  code: EffectBrokerError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "EffectBrokerError",
    code,
    quarantine: {
      kind: "write_quarantine_state",
      status: "quarantined",
      reason: "uncertain_external_effect",
    },
  });
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

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry);
      const entryStat = statSync(entryPath);

      if (entryStat.isDirectory()) {
        return sourceFiles(entryPath);
      }

      return entryStat.isFile() ? [entryPath] : [];
    })
    .sort();
}
