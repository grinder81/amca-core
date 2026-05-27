import { describe, expect, it } from "vitest";

import { LocalAmcaService, ServiceError } from "@amca/service";
import {
  SecurityError,
  type Principal,
  type SecurityContext,
} from "@amca/security";
import type {
  Claim,
  EffectReceipt,
  EvidenceRef,
  FinalCandidate,
  ToolCommandRequest,
} from "@amca/protocol";

describe("Mission P1/P2/P3/P10 service and security boundary", () => {
  it("service-direct-release-bypass-blocked", async () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_service_direct_release",
      profile: "standard",
    });

    await expect(
      service.handleOperation({
        type: "direct_release",
        input: {
          context: context(operator()),
          runId: "mission_service_direct_release",
          decision: {
            status: "released",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "authority_bypass_blocked",
    });
  });

  it("service-direct-receipt-admission-blocked", async () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_service_direct_receipt",
      profile: "standard",
    });

    await expect(
      service.handleOperation({
        type: "direct_receipt_admission",
        input: {
          context: context(operator()),
          runId: "mission_service_direct_receipt",
          receipt: receipt("mission_service_direct_receipt"),
        },
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("inspect-redacts-restricted-evidence", () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_service_redaction",
      profile: "standard",
    });
    service.submitFinalCandidate({
      context: context(operator()),
      runId: "mission_service_redaction",
      finalCandidate: candidate("mission_service_redaction", [
        restrictedEvidenceRef(),
      ]),
    });

    const inspected = service.inspectRun({
      context: context(viewer()),
      runId: "mission_service_redaction",
    });
    const serialized = JSON.stringify(inspected.redactedEvents);

    expect(serialized).toContain("evidence_access_denied");
    expect(serialized).not.toContain(validHash("d"));
    expect(inspected.projection.summary.status).toBe("blocked");
  });

  it("tenant-cross-run-access-blocked", () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_tenant_a_run",
      profile: "standard",
    });

    expect(() =>
      service.inspectRun({
        context: context(principal("viewer_b", "tenant_b", ["viewer"])),
        runId: "mission_tenant_a_run",
      }),
    ).toThrow(SecurityError);
  });

  it("service-cross-tenant-dispatch-tool-command-blocked", async () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_tenant_a_dispatch",
      profile: "standard",
    });

    await expect(
      service.dispatchToolCommand({
        context: context(principal("operator_b", "tenant_b", ["operator"])),
        runId: "mission_tenant_a_dispatch",
        toolCommand: toolCommand("mission_tenant_a_dispatch"),
      }),
    ).rejects.toMatchObject({
      name: "SecurityError",
      code: "tenant_access_denied",
    });
  });

  it("service-cross-tenant-audit-export-blocked", () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_tenant_a_audit_export",
      profile: "standard",
    });

    expect(() =>
      service.exportAudit({
        context: context(principal("auditor_b", "tenant_b", ["auditor"])),
        runId: "mission_tenant_a_audit_export",
      }),
    ).toThrow(SecurityError);
  });

  it("service-cross-tenant-replay-blocked", () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_tenant_a_replay",
      profile: "standard",
    });

    expect(() =>
      service.replayRun({
        context: context(principal("viewer_b", "tenant_b", ["viewer"])),
        runId: "mission_tenant_a_replay",
      }),
    ).toThrow(SecurityError);
  });

  it("service-cross-tenant-receipt-admission-blocked", () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_tenant_a_receipt_admission",
      profile: "standard",
    });

    expect(() =>
      service.requestDirectReceiptAdmission({
        context: context(principal("operator_b", "tenant_b", ["operator"])),
        runId: "mission_tenant_a_receipt_admission",
        receipt: receipt("mission_tenant_a_receipt_admission"),
      }),
    ).toThrow(SecurityError);
  });

  it("role-without-capability-blocked", () => {
    const service = new LocalAmcaService();

    expect(() =>
      service.startRun({
        context: context(viewer()),
        runId: "mission_viewer_start_blocked",
        profile: "standard",
      }),
    ).toThrow(SecurityError);
  });

  it("audit-export-no-secret-leak and audit-explains-release-block", () => {
    const service = new LocalAmcaService();
    service.startRun({
      context: context(operator()),
      runId: "mission_audit_service",
      profile: "standard",
      metadata: {
        authorizationToken: "secret-token",
      },
    });
    service.submitFinalCandidate({
      context: context(operator()),
      runId: "mission_audit_service",
      finalCandidate: candidate("mission_audit_service", []),
    });

    const report = service.exportAudit({
      context: context(auditor()),
      runId: "mission_audit_service",
    });
    const serialized = JSON.stringify(report);

    expect(report.proofUsable).toBe(false);
    expect(report.containsRawEvidence).toBe(false);
    expect(report.decisions[0]?.status).toBe("blocked");
    expect(report.decisions[0]?.blockingMismatchIds.length).toBeGreaterThan(0);
    expect(report.mismatches[0]?.type).toBe("missing_evidence");
    expect(serialized).not.toContain("secret-token");
  });
});

function operator(): Principal {
  return principal("operator_001", "tenant_a", ["operator"]);
}

function viewer(): Principal {
  return principal("viewer_001", "tenant_a", ["viewer"]);
}

function auditor(): Principal {
  return principal("auditor_001", "tenant_a", ["auditor"]);
}

function principal(
  principalId: string,
  tenantId: string,
  roles: Principal["roles"],
): Principal {
  return {
    principalId,
    tenantId,
    roles,
  };
}

function context(principalValue: Principal): SecurityContext {
  return {
    tenantId: principalValue.tenantId,
    principal: principalValue,
  };
}

function candidate(
  runId: string,
  evidenceRefs: readonly EvidenceRef[],
): FinalCandidate {
  const claim: Claim = {
    claimId: "claim_tests_passed",
    type: "test_result",
    statement: "Tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId: "shell.run_tests",
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
    },
    evidenceRefs: [...evidenceRefs],
    criticality: "medium",
  };

  return {
    kind: "final_candidate",
    candidateId: "candidate_tests_passed",
    runId,
    claims: [claim],
  };
}

function restrictedEvidenceRef(): EvidenceRef {
  return {
    admissionStatus: "admitted",
    evidenceId: "ev_restricted",
    kind: "effect_receipt",
    sourceEventId: "evt_missing_receipt",
    hash: validHash("d"),
    observedAt: "2026-05-25T00:00:00.000Z",
    sensitivity: "restricted",
    metadata: {
      authorizationToken: "secret-token",
    },
  };
}

function receipt(runId: string): EffectReceipt {
  return {
    receiptId: "receipt_direct",
    effectId: "effect_direct",
    runId,
    capabilityId: "shell.run_tests",
    receiptType: "test_run",
    status: "succeeded",
    payload: {
      result: "passed",
    },
    payloadHash: validHash("e"),
    evidence: [],
    observedAt: "2026-05-25T00:00:00.000Z",
  };
}

function toolCommand(runId: string): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `cmd_${runId}`,
    runId,
    capabilityId: "shell.run_tests",
    toolId: "shell.run_tests",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
  };
}

function validHash(char: string): `sha256:${string}` {
  return `sha256:${char.repeat(64)}`;
}
