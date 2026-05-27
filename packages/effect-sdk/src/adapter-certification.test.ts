import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AdapterCertification,
  AdapterKind,
  EffectAdapter,
  EffectAdapterResult,
  PendingEvidenceRef,
  ReceiptCandidate,
} from "./index.js";

describe("adapter certification types", () => {
  it("models adapter authority metadata as strict data", () => {
    const certification = {
      certificationVersion: 1,
      adapterId: "adapter.shell.run_tests",
      adapterKind: "deterministic_fake",
      capabilityId: "shell.run_tests",
      toolId: "shell.run_tests",
      sideEffectClass: "compute",
      declaredReceiptTypes: ["test_run"],
      idempotency: "not_required",
      riskProfile: "standard",
    } as const satisfies AdapterCertification;

    expect(certification.adapterKind).toBe("deterministic_fake");
    expectTypeOf(certification).toExtend<AdapterCertification>();
  });

  it("requires write lifecycle certification to be explicit data", () => {
    const certification = {
      certificationVersion: 1,
      adapterId: "adapter.github.create_pull_request",
      adapterKind: "external_write",
      capabilityId: "github.create_pull_request",
      toolId: "github.create_pull_request",
      sideEffectClass: "idempotent_write",
      declaredReceiptTypes: ["github.pull_request_created"],
      idempotency: "required_for_writes",
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
      riskProfile: "standard",
    } as const satisfies AdapterCertification;

    expect(certification.writeLifecycle.outcome).toBe(
      "receipt_candidate_or_quarantine_required",
    );
    expectTypeOf(certification).toExtend<AdapterCertification>();
  });

  it("requires adapters to carry certification metadata", () => {
    expectTypeOf<EffectAdapter>().toHaveProperty("certification");
  });

  it("models adapter output as pre-admission receipt candidates", () => {
    const pendingEvidenceRef = {
      evidenceId: "ev_adapter_pending",
      kind: "effect_receipt",
      admissionStatus: "pending",
      pendingAdmissionToken: "pending_adapter_pending",
      hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      observedAt: "2026-05-24T12:00:00.000Z",
      sensitivity: "internal",
    } as const satisfies PendingEvidenceRef;
    const receiptCandidate = {
      receiptId: "receipt_adapter_pending",
      effectId: "effect_adapter_pending",
      runId: "run_adapter_pending",
      capabilityId: "shell.run_tests",
      receiptType: "test_run",
      status: "succeeded",
      payload: {
        result: "passed",
      },
      payloadHash:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      evidence: [pendingEvidenceRef],
      observedAt: "2026-05-24T12:00:00.000Z",
    } as const satisfies ReceiptCandidate;
    const result = {
      receiptCandidate,
    } as const satisfies EffectAdapterResult;

    expect(result.receiptCandidate.evidence[0]).toMatchObject({
      admissionStatus: "pending",
      pendingAdmissionToken: "pending_adapter_pending",
    });
    expect(result.receiptCandidate.evidence[0]).not.toHaveProperty(
      "sourceEventId",
    );
    expectTypeOf(result.receiptCandidate).toExtend<ReceiptCandidate>();
  });

  it("keeps future adapter classes explicit instead of collapsing them into strings", () => {
    const adapterKinds: readonly AdapterKind[] = [
      "deterministic_fake",
      "deterministic_in_memory",
      "local_readonly",
      "controlled_compute",
      "external_read",
      "external_write",
    ];

    expect(adapterKinds).toContain("controlled_compute");
  });
});
