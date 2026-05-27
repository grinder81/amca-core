import { canonicalObjectHash } from "@amca/contracts";
import type {
  AdapterCertification,
  AdapterIdempotencyPosture,
  AdapterKind,
  EffectAdapter,
  EffectAdapterResult,
  ExternalStateObservationCandidate,
  ReceiptCandidate,
} from "@amca/effect-sdk";
import type {
  JsonObject,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import {
  createWritePreflightCandidate,
  EffectBrokerError,
  InMemoryEffectBroker,
} from "./index.js";

const NOW = "2026-05-24T12:00:00.000Z";
const writeClasses = new Set<SideEffectClass>([
  "idempotent_write",
  "reversible_write",
  "irreversible_write",
  "critical_write",
]);

describe("InMemoryEffectBroker", () => {
  it("dispatches an allowed compute effect through a registered adapter", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          calls,
          receiptType: "test_run",
          payload: { result: "passed" },
        }),
      ],
      capabilities: [capabilityFor(command, "test_run")],
      clock: () => NOW,
    });

    const result = await broker.dispatch(command);

    expect(result.status).toBe("dispatched");
    expect(result.effectRequest).toMatchObject({
      commandId: command.commandId,
      capabilityId: command.capabilityId,
      toolId: command.toolId,
      sideEffectClass: "compute",
    });
    expect(result.receiptCandidate).toMatchObject({
      effectId: result.effectRequest.effectId,
      runId: command.runId,
      capabilityId: command.capabilityId,
      receiptType: "test_run",
      status: "succeeded",
    });
    expect(result.receiptCandidate.evidence[0]).toMatchObject({
      admissionStatus: "pending",
    });
    expect(
      typeof result.receiptCandidate.evidence[0]?.pendingAdmissionToken,
    ).toBe("string");
    expect(result.receiptCandidate.evidence[0]).not.toHaveProperty(
      "sourceEventId",
    );
    expect(calls).toHaveLength(1);
  });

  it("dispatches an allowed read effect through a registered adapter", async () => {
    const command = toolCommand({
      capabilityId: "repo.read",
      sideEffectClass: "read",
      toolId: "repo.read",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          receiptType: "repo_snapshot",
          payload: { files: 3 },
        }),
      ],
      capabilities: [capabilityFor(command, "repo_snapshot")],
      clock: () => NOW,
    });

    await expect(broker.dispatch(command)).resolves.toMatchObject({
      status: "dispatched",
      receiptCandidate: {
        receiptType: "repo_snapshot",
      },
    });
  });

  it("dispatches a deterministic_in_memory adapter when certification matches", async () => {
    const command = toolCommand({
      capabilityId: "memory.read_snapshot",
      sideEffectClass: "read",
      toolId: "memory.read_snapshot",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          adapterKind: "deterministic_in_memory",
          receiptType: "memory_snapshot",
          payload: { rows: 2 },
        }),
      ],
      capabilities: [capabilityFor(command, "memory_snapshot")],
      clock: () => NOW,
    });

    await expect(broker.dispatch(command)).resolves.toMatchObject({
      status: "dispatched",
      receiptCandidate: {
        receiptType: "memory_snapshot",
      },
    });
  });

  it("dispatches explicitly opted-in production read adapter kinds with idempotent cache behavior", async () => {
    const externalCalls: ToolCommandRequest[] = [];
    const externalCommand = toolCommand({
      capabilityId: "http.observe_status",
      sideEffectClass: "read",
      toolId: "http.observe_status",
      idempotencyKey: "read-cache-001",
    });
    const externalBroker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(externalCommand, {
          adapterKind: "external_read",
          calls: externalCalls,
          receiptType: "http.status_checked",
          payload: {
            result: "read",
            resourceHash:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            redaction: "content_hash_only",
          },
        }),
      ],
      allowedAdapterKinds: ["external_read"],
      capabilities: [capabilityFor(externalCommand, "http.status_checked")],
      clock: () => NOW,
    });

    const first = await externalBroker.dispatch(externalCommand);
    const second = await externalBroker.dispatch(externalCommand);

    expect(first.status).toBe("dispatched");
    expect(second.status).toBe("cached");
    expect(second.receiptCandidate).toEqual(first.receiptCandidate);
    expect(externalCalls).toHaveLength(1);
    await expectBrokerError(
      externalBroker.dispatch({
        ...externalCommand,
        args: { path: "/different" },
      }),
      "duplicate_idempotency_key_conflict",
    );

    const localCommand = toolCommand({
      capabilityId: "local.read_file",
      sideEffectClass: "read",
      toolId: "local.read_file",
    });
    await expect(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(localCommand, {
            adapterKind: "local_readonly",
            receiptType: "local.file_read",
            payload: {
              result: "read",
              contentHash:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              metadata: { redaction: "content_hash_only" },
            },
          }),
        ],
        allowedAdapterKinds: ["local_readonly"],
        capabilities: [capabilityFor(localCommand, "local.file_read")],
        clock: () => NOW,
      }).dispatch(localCommand),
    ).resolves.toMatchObject({
      status: "dispatched",
      receiptCandidate: {
        receiptType: "local.file_read",
      },
    });
  });

  it("certifies a declared external-state observation with a successful receipt", async () => {
    const command = toolCommand({
      capabilityId: "github.observe_pull_request_state",
      sideEffectClass: "read",
      toolId: "github.observe_pull_request_state",
    });
    const observedState = { state: "open" };
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          receiptType: "github.pull_request_state_checked",
          payload: { checked: true },
          observation: observationFor(command, observedState),
        }),
      ],
      capabilities: [
        capabilityFor(command, "github.pull_request_state_checked", "read", {
          observationType: "github.pull_request_state",
        }),
      ],
      clock: () => NOW,
    });

    const result = await broker.dispatch(command);

    expect(result.externalStateObservationCandidate).toMatchObject({
      runId: command.runId,
      observationType: "github.pull_request_state",
      subjectType: "pull_request",
      subjectId: "123",
      observedState,
    });
    expect(result.externalStateObservationCandidate?.evidence[0]).toMatchObject(
      {
        admissionStatus: "pending",
      },
    );
    expect(
      typeof result.externalStateObservationCandidate?.evidence[0]
        ?.pendingAdmissionToken,
    ).toBe("string");
    expect(
      result.externalStateObservationCandidate?.evidence[0],
    ).not.toHaveProperty("sourceEventId");
  });

  it("rejects raw content leaks from production read receipt and observation candidates", async () => {
    const command = toolCommand({
      capabilityId: "http.observe_status",
      sideEffectClass: "read",
      toolId: "http.observe_status",
    });

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            adapterKind: "external_read",
            receiptType: "http.status_checked",
            payload: {
              result: "read",
              content: "raw response body must not escape the adapter",
            },
          }),
        ],
        allowedAdapterKinds: ["external_read"],
        capabilities: [capabilityFor(command, "http.status_checked")],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_invalid",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            adapterKind: "external_read",
            receiptType: "http.status_checked",
            payload: {
              result: "read",
              redaction: "content_hash_only",
            },
            observation: observationFor(command, {
              body: "raw response body must not become observed state",
            }),
          }),
        ],
        allowedAdapterKinds: ["external_read"],
        capabilities: [
          capabilityFor(command, "http.status_checked", "read", {
            observationType: "github.pull_request_state",
          }),
        ],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_observation_invalid",
    );
  });

  it("rejects adapters without valid certification metadata", () => {
    const command = toolCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            {
              ...adapterFor(command),
              certification: undefined,
            } as unknown as EffectAdapter,
          ],
          capabilities: [capabilityFor(command, "test_run")],
          clock: () => NOW,
        }),
      "adapter_certification_missing",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              certification: {
                certificationVersion: 1,
                adapterId: "adapter.other_tool",
                adapterKind: "deterministic_fake",
                capabilityId: command.capabilityId,
                toolId: command.toolId,
                sideEffectClass: "compute",
                declaredReceiptTypes: ["test_run"],
                idempotency: "not_required",
                riskProfile: "standard",
              },
            }),
          ],
          capabilities: [capabilityFor(command, "test_run")],
          clock: () => NOW,
        }),
      "adapter_certification_mismatch",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              certification: {
                ...certificationFor(command),
                runtimeToken: "not allowed",
              } as unknown as AdapterCertification,
            }),
          ],
          capabilities: [capabilityFor(command, "test_run")],
          clock: () => NOW,
        }),
      "adapter_certification_invalid",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              certification: {
                ...certificationFor(command),
                declaredReceiptTypes: "test_run",
              } as unknown as AdapterCertification,
            }),
          ],
          capabilities: [capabilityFor(command, "test_run")],
          clock: () => NOW,
        }),
      "adapter_certification_invalid",
    );
  });

  it("rejects adapters that expose proof, release, or receipt-admission authority fields", () => {
    const command = toolCommand({
      capabilityId: "repo.read",
      sideEffectClass: "read",
      toolId: "repo.read",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            {
              ...adapterFor(command, {
                adapterKind: "external_read",
                receiptType: "repo_snapshot",
              }),
              [["decide", "Release"].join("")]: () => "released",
            },
          ],
          allowedAdapterKinds: ["external_read"],
          capabilities: [capabilityFor(command, "repo_snapshot")],
          clock: () => NOW,
        }),
      "adapter_certification_invalid",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            {
              ...adapterFor(command, {
                adapterKind: "external_read",
                receiptType: "repo_snapshot",
              }),
              recordEffectReceipt: () => undefined,
            } as unknown as EffectAdapter,
          ],
          allowedAdapterKinds: ["external_read"],
          capabilities: [capabilityFor(command, "repo_snapshot")],
          clock: () => NOW,
        }),
      "adapter_certification_invalid",
    );
  });

  it("rejects adapter kinds that are not enabled for the broker profile", () => {
    const command = toolCommand({
      capabilityId: "repo.read",
      sideEffectClass: "read",
      toolId: "repo.read",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              adapterKind: "external_read",
              receiptType: "repo_snapshot",
            }),
          ],
          capabilities: [capabilityFor(command, "repo_snapshot")],
          clock: () => NOW,
        }),
      "adapter_certification_kind_forbidden",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              adapterKind: "local_readonly",
              receiptType: "repo_snapshot",
            }),
          ],
          capabilities: [capabilityFor(command, "repo_snapshot")],
          clock: () => NOW,
        }),
      "adapter_certification_kind_forbidden",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              adapterKind: "controlled_compute",
              receiptType: "repo_snapshot",
            }),
          ],
          capabilities: [capabilityFor(command, "repo_snapshot")],
          clock: () => NOW,
        }),
      "adapter_certification_kind_forbidden",
    );
  });

  it("rejects certification that drifts from command or capability authority", async () => {
    const command = toolCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });

    const sideEffectMismatchBroker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          certifiedSideEffectClass: "read",
          receiptType: "test_run",
        }),
      ],
      capabilities: [capabilityFor(command, "test_run")],
      clock: () => NOW,
    });
    await expectBrokerError(
      sideEffectMismatchBroker.dispatch(command),
      "adapter_certification_mismatch",
    );

    const receiptMismatchBroker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          certifiedReceiptTypes: ["other_receipt"],
          receiptType: "test_run",
        }),
      ],
      capabilities: [capabilityFor(command, "test_run")],
      clock: () => NOW,
    });
    await expectBrokerError(
      receiptMismatchBroker.dispatch(command),
      "adapter_certification_undeclared_receipt",
    );

    const observationCommand = toolCommand({
      capabilityId: "github.observe_pull_request_state",
      sideEffectClass: "read",
      toolId: "github.observe_pull_request_state",
    });
    const observationBroker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(observationCommand, {
          certifiedObservationTypes: ["github.other_state"],
          receiptType: "github.pull_request_state_checked",
        }),
      ],
      capabilities: [
        capabilityFor(
          observationCommand,
          "github.pull_request_state_checked",
          "read",
          { observationType: "github.pull_request_state" },
        ),
      ],
      clock: () => NOW,
    });
    await expectBrokerError(
      observationBroker.dispatch(observationCommand),
      "adapter_certification_undeclared_observation",
    );
  });

  it("rejects observations with failed receipts, undeclared types, bad hashes, bad kinds, and wrong run IDs", async () => {
    const command = toolCommand({
      capabilityId: "github.observe_pull_request_state",
      sideEffectClass: "read",
      toolId: "github.observe_pull_request_state",
    });
    const capability = capabilityFor(
      command,
      "github.pull_request_state_checked",
      "read",
      {
        observationType: "github.pull_request_state",
      },
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            receiptType: "github.pull_request_state_checked",
            status: "failed",
            observation: observationFor(command, { state: "open" }),
          }),
        ],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_observation_receipt_failed",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            receiptType: "github.pull_request_state_checked",
            observation: observationFor(command, { state: "open" }),
          }),
        ],
        capabilities: [
          capabilityFor(command, "github.pull_request_state_checked", "read"),
        ],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_certification_undeclared_observation",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            receiptType: "github.pull_request_state_checked",
            observation: observationFor(
              command,
              { state: "open" },
              {
                badPayloadHash: true,
              },
            ),
          }),
        ],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_observation_invalid",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            receiptType: "github.pull_request_state_checked",
            observation: observationFor(
              command,
              { state: "open" },
              {
                evidenceKind: "effect_receipt",
              },
            ),
          }),
        ],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_observation_invalid",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            receiptType: "github.pull_request_state_checked",
            observation: observationFor(
              command,
              { state: "open" },
              {
                runId: "run_wrong",
              },
            ),
          }),
        ],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_observation_invalid",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            receiptType: "github.pull_request_state_checked",
            observation: observationFor(
              command,
              { state: "open" },
              {
                includeAdmittedSourceEventId: true,
              },
            ),
          }),
        ],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_observation_invalid",
    );
  });

  it("blocks unknown capabilities and unregistered tools", async () => {
    const command = toolCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [adapterFor(command)],
        clock: () => NOW,
      }).dispatch(command),
      "capability_not_registered",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        capabilities: [capabilityFor(command, "test_run")],
        clock: () => NOW,
      }).dispatch(command),
      "tool_not_registered",
    );
  });

  it("blocks side-effect class mismatch before adapter execution", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [adapterFor(command, { calls })],
      capabilities: [capabilityFor(command, "test_run", "read")],
      clock: () => NOW,
    });

    await expectBrokerError(
      broker.dispatch(command),
      "side_effect_class_mismatch",
    );
    expect(calls).toHaveLength(0);
  });

  it("requires idempotency keys for write classes", async () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, { receiptType: "github.pull_request_created" }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    await expectBrokerError(
      broker.dispatch(command),
      "idempotency_key_required",
    );
  });

  it("write-preflight-allowed-does-not-execute", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-preflight-123",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          calls,
          receiptType: "github.pull_request_created",
        }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    const candidate = createWritePreflightCandidate(command, {
      requestedAt: NOW,
    });
    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    expect(candidate).toMatchObject({
      kind: "write_preflight_candidate",
      argsHash: canonicalObjectHash(command.args),
      sideEffectClass: "idempotent_write",
    });
    expect(decision).toMatchObject({
      kind: "write_preflight_decision",
      status: "allowed",
      idempotencyKey: command.idempotencyKey,
    });
    expect(calls).toHaveLength(0);

    await expect(
      broker.dispatchWithPreflight(command, { preflightDecision: decision }),
    ).resolves.toMatchObject({
      status: "dispatched",
      receiptCandidate: {
        receiptType: "github.pull_request_created",
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("blocks direct write dispatch without persisted preflight", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-direct-blocked",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          calls,
          receiptType: "github.pull_request_created",
        }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    await expectBrokerError(
      broker.dispatch(command),
      "write_preflight_required",
    );
    expect(calls).toHaveLength(0);
  });

  it("dispatches an explicitly enabled external_write adapter only through persisted preflight", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-external-write-001",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          adapterKind: "external_write",
          calls,
          receiptType: "github.pull_request_created",
        }),
      ],
      allowedAdapterKinds: ["external_write"],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    await expect(broker.dispatch(command)).rejects.toMatchObject({
      code: "write_preflight_required",
    });
    await expect(
      broker.dispatchWithPreflight(command, { preflightDecision: decision }),
    ).resolves.toMatchObject({
      status: "dispatched",
      receiptCandidate: {
        receiptType: "github.pull_request_created",
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("blocks forged, stale, or mismatched write preflight decisions before dispatch", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-preflight-mismatch",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          calls,
          receiptType: "github.pull_request_created",
        }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });
    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    await expectBrokerError(
      broker.dispatchWithPreflight(
        {
          ...command,
          args: { title: "mismatched after preflight" },
        },
        { preflightDecision: decision },
      ),
      "write_preflight_mismatch",
    );
    await expectBrokerError(
      broker.dispatchWithPreflight(command, {
        preflightDecision: {
          ...decision,
          preflightId: "preflight_forged",
        },
      }),
      "write_preflight_mismatch",
    );
    expect(calls).toHaveLength(0);
  });

  it("quarantines adapter errors and unknown write outcomes without issuing receipt support", async () => {
    const errorCalls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-error-quarantine",
    });
    const errorBroker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          adapterKind: "external_write",
          calls: errorCalls,
          receiptType: "github.pull_request_created",
          throwOnExecute: true,
        }),
      ],
      allowedAdapterKinds: ["external_write"],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });
    const errorDecision = errorBroker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    await expectBrokerErrorWithQuarantine(
      errorBroker.dispatchWithPreflight(command, {
        preflightDecision: errorDecision,
      }),
      "adapter_write_quarantined",
    );
    await expectBrokerErrorWithQuarantine(
      errorBroker.dispatchWithPreflight(command, {
        preflightDecision: errorDecision,
      }),
      "adapter_write_quarantined",
    );
    expect(errorCalls).toHaveLength(1);

    const unknownCommand = toolCommand({
      capabilityId: "github.update_issue",
      sideEffectClass: "idempotent_write",
      toolId: "github.update_issue",
      idempotencyKey: "update-issue-unknown-quarantine",
    });
    const unknownBroker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(unknownCommand, {
          adapterKind: "external_write",
          receiptType: "github.issue_updated",
          status: "unknown",
        }),
      ],
      allowedAdapterKinds: ["external_write"],
      capabilities: [capabilityFor(unknownCommand, "github.issue_updated")],
      clock: () => NOW,
    });
    const unknownDecision = unknownBroker.preflightWrite(unknownCommand, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    await expectBrokerErrorWithQuarantine(
      unknownBroker.dispatchWithPreflight(unknownCommand, {
        preflightDecision: unknownDecision,
      }),
      "adapter_write_quarantined",
    );
  });

  it("write-preflight-denied-blocks-dispatch", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          calls,
          receiptType: "github.pull_request_created",
        }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
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

  it("write-preflight-missing-idempotency-blocked", () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, { receiptType: "github.pull_request_created" }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    expect(broker.preflightWrite(command, { decidedAt: NOW })).toMatchObject({
      status: "denied",
      reason: "missing_idempotency_key",
    });
  });

  it("quarantines critical write preflight before dispatch authority exists", async () => {
    const command = toolCommand({
      capabilityId: "ops.critical_write",
      sideEffectClass: "critical_write",
      toolId: "ops.critical_write",
      idempotencyKey: "critical-001",
    });
    const broker = new InMemoryEffectBroker({ clock: () => NOW });

    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    expect(decision).toMatchObject({
      status: "quarantined",
      quarantine: {
        status: "quarantined",
        reason: "critical_approval_required",
      },
    });
    await expectBrokerError(
      broker.dispatchWithPreflight(command, { preflightDecision: decision }),
      "write_preflight_quarantined",
    );
  });

  it("broker-quarantine-cannot-support-claim", async () => {
    const command = toolCommand({
      capabilityId: "ops.critical_write",
      sideEffectClass: "critical_write",
      toolId: "ops.critical_write",
      idempotencyKey: "critical-quarantine-claim-001",
    });
    const broker = new InMemoryEffectBroker({ clock: () => NOW });

    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    expect(decision.status).toBe("quarantined");
    if (decision.status !== "quarantined") {
      throw new Error("Expected critical write preflight to quarantine.");
    }

    expect(decision.quarantine).toMatchObject({
      kind: "write_quarantine_state",
      status: "quarantined",
      reason: "critical_approval_required",
    });
    expect(decision.quarantine).not.toHaveProperty("receiptId");
    expect(decision.quarantine).not.toHaveProperty("payloadHash");
    expect(decision.quarantine).not.toHaveProperty("evidence");
    expect(decision.quarantine).not.toHaveProperty("sourceEventId");
    await expectBrokerError(
      broker.dispatchWithPreflight(command, { preflightDecision: decision }),
      "write_preflight_quarantined",
    );
  });

  it("blocks critical writes until approval authority exists", () => {
    const command = toolCommand({
      capabilityId: "ops.critical_write",
      sideEffectClass: "critical_write",
      toolId: "ops.critical_write",
      idempotencyKey: "critical-001",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, { receiptType: "critical_write_receipt" }),
          ],
          capabilities: [capabilityFor(command, "critical_write_receipt")],
          clock: () => NOW,
        }),
      "critical_write_requires_approval",
    );
  });

  it("requires write adapters to declare idempotency posture", () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              idempotency: "not_required",
              receiptType: "github.pull_request_created",
            }),
          ],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_write_lifecycle_invalid",
    );
  });

  it("blocks write-capable adapters without preflight certification", () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              receiptType: "github.pull_request_created",
              writeLifecycle: false,
            }),
          ],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_write_lifecycle_missing",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              receiptType: "github.pull_request_created",
              writeLifecycle: {
                ...defaultWriteLifecycle(),
                preflight: "not_required" as never,
              },
            }),
          ],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_write_lifecycle_invalid",
    );
  });

  it("blocks write-capable adapters without idempotency-key lifecycle certification", () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              receiptType: "github.pull_request_created",
              writeLifecycle: {
                ...defaultWriteLifecycle(),
                idempotencyKey: "adapter_enforced",
              },
            }),
          ],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_write_lifecycle_invalid",
    );
  });

  it("blocks write-capable adapters that claim proof or release authority", () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              receiptType: "github.pull_request_created",
              writeLifecycle: {
                ...defaultWriteLifecycle(),
                forbiddenAuthority: ["receipt_admission", "release_authority"],
              },
            }),
          ],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_write_lifecycle_invalid",
    );

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              receiptType: "github.pull_request_created",
              writeLifecycle: {
                ...defaultWriteLifecycle(),
                forbiddenAuthority: ["receipt_admission", "proof_authority"],
              },
            }),
          ],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_write_lifecycle_invalid",
    );
  });

  it("keeps uncertified write dispatch unavailable even when external_write kind is enabled", () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              adapterKind: "external_write",
              calls,
              receiptType: "github.pull_request_created",
              writeLifecycle: false,
            }),
          ],
          allowedAdapterKinds: ["external_write"],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_write_lifecycle_missing",
    );
    expect(calls).toHaveLength(0);
  });

  it("prevents read-only adapter kinds from claiming write capability", () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });

    expectBrokerErrorSync(
      () =>
        new InMemoryEffectBroker({
          adapters: [
            adapterFor(command, {
              adapterKind: "local_readonly",
              receiptType: "github.pull_request_created",
            }),
          ],
          allowedAdapterKinds: ["local_readonly"],
          capabilities: [capabilityFor(command, "github.pull_request_created")],
          clock: () => NOW,
        }),
      "adapter_certification_invalid",
    );
  });

  it("broker-duplicate-idempotency-does-not-duplicate-write", async () => {
    const calls: ToolCommandRequest[] = [];
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          calls,
          receiptType: "github.pull_request_created",
          payload: { actionVerb: "created", targetId: "123" },
        }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });
    const first = await broker.dispatchWithPreflight(command, {
      preflightDecision: decision,
    });
    const second = await broker.dispatchWithPreflight(command, {
      preflightDecision: decision,
    });

    expect(first.status).toBe("dispatched");
    expect(second.status).toBe("cached");
    expect(second.receiptCandidate).toEqual(first.receiptCandidate);
    expect(calls).toHaveLength(1);
  });

  it("blocks idempotency key reuse with different effect args", async () => {
    const command = toolCommand({
      capabilityId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      toolId: "github.create_pull_request",
      idempotencyKey: "create-pr-123",
    });
    const broker = new InMemoryEffectBroker({
      adapters: [
        adapterFor(command, {
          receiptType: "github.pull_request_created",
          payload: { actionVerb: "created", targetId: "123" },
        }),
      ],
      capabilities: [capabilityFor(command, "github.pull_request_created")],
      clock: () => NOW,
    });

    const decision = broker.preflightWrite(command, {
      decidedAt: NOW,
      requestedAt: NOW,
    });
    await broker.dispatchWithPreflight(command, {
      preflightDecision: decision,
    });

    const conflictingCommand = {
      ...command,
      args: { title: "different" },
    };
    const conflictingDecision = broker.preflightWrite(conflictingCommand, {
      decidedAt: NOW,
      requestedAt: NOW,
    });

    await expectBrokerError(
      broker.dispatchWithPreflight(conflictingCommand, {
        preflightDecision: conflictingDecision,
      }),
      "duplicate_idempotency_key_conflict",
    );
  });

  it("blocks missing, mismatched, unknown, and hash-invalid receipts", async () => {
    const command = toolCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });
    const capability = capabilityFor(command, "test_run");

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [adapterFor(command, { omitReceipt: true })],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_missing",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [adapterFor(command, { returnLegacyReceiptField: true })],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_invalid",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [adapterFor(command, { receiptRunId: "run_wrong" })],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "receipt_effect_mismatch",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [adapterFor(command, { status: "unknown" })],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_unknown",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [adapterFor(command, { badPayloadHash: true })],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_invalid",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [adapterFor(command, { includeAdmittedSourceEventId: true })],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_invalid",
    );

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            certifiedReceiptTypes: ["test_run"],
            receiptType: "wrong_receipt_type",
          }),
        ],
        capabilities: [capability],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_invalid",
    );
  });

  it("rejects receipts and observations not declared by adapter certification", async () => {
    const command = toolCommand({
      capabilityId: "shell.run_tests",
      sideEffectClass: "compute",
      toolId: "shell.run_tests",
    });

    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(command, {
            certifiedReceiptTypes: ["test_run"],
            receiptType: "other_receipt",
          }),
        ],
        capabilities: [capabilityFor(command, "test_run")],
        clock: () => NOW,
      }).dispatch(command),
      "adapter_receipt_invalid",
    );

    const observationCommand = toolCommand({
      capabilityId: "github.observe_pull_request_state",
      sideEffectClass: "read",
      toolId: "github.observe_pull_request_state",
    });
    await expectBrokerError(
      new InMemoryEffectBroker({
        adapters: [
          adapterFor(observationCommand, {
            certifiedObservationTypes: ["github.pull_request_state"],
            receiptType: "github.pull_request_state_checked",
            observation: observationFor(
              observationCommand,
              { state: "open" },
              {
                observationType: "github.other_state",
              },
            ),
          }),
        ],
        capabilities: [
          capabilityFor(
            observationCommand,
            "github.pull_request_state_checked",
            "read",
            {
              observationTypes: [
                "github.pull_request_state",
                "github.other_state",
              ],
            },
          ),
        ],
        clock: () => NOW,
      }).dispatch(observationCommand),
      "adapter_observation_undeclared",
    );
  });
});

function toolCommand(input: {
  readonly capabilityId: string;
  readonly sideEffectClass: SideEffectClass;
  readonly toolId: string;
  readonly idempotencyKey?: string;
}): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `cmd_${input.capabilityId.replace(/\./gu, "_")}`,
    runId: "run_effect_broker_test",
    capabilityId: input.capabilityId,
    toolId: input.toolId,
    args: { title: "phase 13" },
    sideEffectClass: input.sideEffectClass,
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
  };
}

function adapterFor(
  command: ToolCommandRequest,
  options: {
    readonly adapterKind?: AdapterKind;
    readonly badPayloadHash?: boolean;
    readonly calls?: ToolCommandRequest[];
    readonly certification?: AdapterCertification;
    readonly certifiedObservationTypes?: readonly string[];
    readonly certifiedReceiptTypes?: readonly string[];
    readonly certifiedSideEffectClass?: SideEffectClass;
    readonly includeAdmittedSourceEventId?: boolean;
    readonly idempotency?: AdapterIdempotencyPosture;
    readonly omitReceipt?: boolean;
    readonly payload?: JsonObject;
    readonly receiptRunId?: string;
    readonly receiptType?: string;
    readonly returnLegacyReceiptField?: boolean;
    readonly status?: ReceiptCandidate["status"];
    readonly throwOnExecute?: boolean;
    readonly observation?: ExternalStateObservationCandidate;
    readonly writeLifecycle?:
      | AdapterCertification["writeLifecycle"]
      | false
      | undefined;
  } = {},
): EffectAdapter {
  return {
    adapterId: `adapter.${command.toolId}`,
    capabilityId: command.capabilityId,
    toolId: command.toolId,
    certification:
      options.certification ??
      certificationFor(command, {
        ...(options.adapterKind === undefined
          ? {}
          : { adapterKind: options.adapterKind }),
        ...(options.certifiedObservationTypes === undefined &&
        options.observation === undefined
          ? {}
          : {
              declaredObservationTypes: options.certifiedObservationTypes ?? [
                options.observation?.observationType ?? "",
              ],
            }),
        declaredReceiptTypes: options.certifiedReceiptTypes ?? [
          options.receiptType ?? "test_run",
        ],
        ...(options.idempotency === undefined
          ? {}
          : { idempotency: options.idempotency }),
        ...(options.certifiedSideEffectClass === undefined
          ? {}
          : { sideEffectClass: options.certifiedSideEffectClass }),
        ...(options.writeLifecycle === undefined
          ? {}
          : { writeLifecycle: options.writeLifecycle }),
      }),
    execute: (request) => {
      options.calls?.push(command);
      if (options.throwOnExecute === true) {
        throw new Error("simulated uncertain external write outcome");
      }

      if (options.omitReceipt === true) {
        return {};
      }

      const payload = options.payload ?? { result: "passed" };
      const payloadHash = options.badPayloadHash
        ? "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        : canonicalObjectHash(payload);
      const receiptCandidate: ReceiptCandidate = {
        receiptId: `receipt_${request.effectRequest.effectId}`,
        effectId: request.effectRequest.effectId,
        runId: options.receiptRunId ?? request.effectRequest.runId,
        capabilityId: request.effectRequest.capabilityId,
        receiptType: options.receiptType ?? "test_run",
        status: options.status ?? "succeeded",
        payload,
        payloadHash,
        observedAt: NOW,
        evidence: [
          {
            evidenceId: `ev_${request.effectRequest.effectId}`,
            kind: "effect_receipt",
            admissionStatus: "pending",
            pendingAdmissionToken: `pending_${request.effectRequest.effectId}`,
            hash: payloadHash,
            observedAt: NOW,
            sensitivity: "internal",
            ...(options.includeAdmittedSourceEventId === true
              ? { sourceEventId: "evt_future_effect_receipt_recorded" }
              : {}),
          },
        ],
      };

      if (options.returnLegacyReceiptField === true) {
        return {
          receipt: receiptCandidate,
        } as unknown as EffectAdapterResult;
      }

      return {
        receiptCandidate,
        ...(options.observation === undefined
          ? {}
          : { externalStateObservationCandidate: options.observation }),
      };
    },
  };
}

function capabilityFor(
  command: ToolCommandRequest,
  receiptType: string,
  sideEffectClass: SideEffectClass = command.sideEffectClass,
  options: {
    readonly observationType?: string;
    readonly observationTypes?: readonly string[];
  } = {},
) {
  const observationTypes =
    options.observationTypes ??
    (options.observationType === undefined ? [] : [options.observationType]);

  return {
    schemaVersion: 1,
    capabilityId: command.capabilityId,
    profile: "standard",
    sideEffectClass,
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
      ...observationTypes.map(
        (observationType) =>
          ({
            evidenceKind: "external_observation",
            observationType,
          }) as const,
      ),
    ],
    supportedClaims: [
      {
        claimType: "test_result",
        predicateKind: "test_result",
        requiredReceiptType: "test_run",
      },
      ...observationTypes.map(
        (observationType) =>
          ({
            claimType: "current_state",
            predicateKind: "current_state",
            observationType,
          }) as const,
      ),
    ],
    proofRules: [testResultRule()],
  } as const;
}

function observationFor(
  command: ToolCommandRequest,
  observedState: JsonObject,
  options: {
    readonly badPayloadHash?: boolean;
    readonly evidenceKind?: "effect_receipt" | "external_observation";
    readonly includeAdmittedSourceEventId?: boolean;
    readonly observationType?: string;
    readonly runId?: string;
  } = {},
): ExternalStateObservationCandidate {
  const payloadHash = options.badPayloadHash
    ? "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    : canonicalObjectHash(observedState);

  return {
    observationId: `obs_${command.commandId}`,
    runId: options.runId ?? command.runId,
    observationType: options.observationType ?? "github.pull_request_state",
    subjectType: "pull_request",
    subjectId: "123",
    observedState,
    observedAt: NOW,
    expiresAt: "2026-05-24T12:01:00.000Z",
    payloadHash,
    evidence: [
      {
        evidenceId: `ev_obs_${command.commandId}`,
        kind: options.evidenceKind ?? "external_observation",
        admissionStatus: "pending",
        pendingAdmissionToken: `pending_obs_${command.commandId}`,
        hash: payloadHash,
        observedAt: NOW,
        sensitivity: "internal",
        ...(options.includeAdmittedSourceEventId === true
          ? { sourceEventId: "evt_future_observation_recorded" }
          : {}),
      },
    ],
  };
}

function certificationFor(
  command: ToolCommandRequest,
  options: {
    readonly adapterKind?: AdapterKind;
    readonly declaredObservationTypes?: readonly string[];
    readonly declaredReceiptTypes?: readonly string[];
    readonly idempotency?: AdapterIdempotencyPosture;
    readonly sideEffectClass?: SideEffectClass;
    readonly writeLifecycle?:
      | AdapterCertification["writeLifecycle"]
      | false
      | undefined;
  } = {},
): AdapterCertification {
  const sideEffectClass = options.sideEffectClass ?? command.sideEffectClass;
  const writeLifecycle =
    options.writeLifecycle === false
      ? undefined
      : (options.writeLifecycle ??
        (writeClasses.has(sideEffectClass)
          ? defaultWriteLifecycle()
          : undefined));

  return {
    certificationVersion: 1,
    adapterId: `adapter.${command.toolId}`,
    adapterKind: options.adapterKind ?? "deterministic_fake",
    capabilityId: command.capabilityId,
    toolId: command.toolId,
    sideEffectClass,
    declaredReceiptTypes: options.declaredReceiptTypes ?? ["test_run"],
    ...(options.declaredObservationTypes === undefined
      ? {}
      : { declaredObservationTypes: options.declaredObservationTypes }),
    idempotency:
      options.idempotency ??
      (writeClasses.has(sideEffectClass)
        ? "required_for_writes"
        : "not_required"),
    ...(writeLifecycle === undefined ? {} : { writeLifecycle }),
    riskProfile: "standard",
  };
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

function testResultRule() {
  return {
    ruleId: "phase13.test_result",
    version: 1,
    claimType: "test_result",
    predicateKind: "test_result",
    description: "Phase 13 test-result proof descriptor.",
    evidence: [
      {
        requirementId: "phase13.effect_receipt",
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
