import { hashRunEventPayload, InMemoryRunKernel } from "@amca/kernel";
import type {
  ApprovalGrant,
  ApprovalRequest,
  ApprovalScope,
  Claim,
  FinalCandidate,
  RunEvent,
  WritePreflightCandidate,
  WritePreflightDecision,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

const startedAt = "2026-05-25T14:00:00.000Z";
const requestedAt = "2026-05-25T14:01:00.000Z";
const grantedAt = "2026-05-25T14:02:00.000Z";
const decidedAt = "2026-05-25T14:03:00.000Z";
const expiresAt = "2026-05-25T14:10:00.000Z";
const shortExpiry = "2026-05-25T14:02:30.000Z";

describe("mission P1/P4 human approvals and critical controls", () => {
  it("critical-write-without-approval-blocked", () => {
    const runId = "mission_critical_without_approval";
    const kernel = startedKernel(runId);
    const preflight = criticalPreflight(runId);

    kernel.recordWritePreflightRequested(preflight);

    expect(() =>
      kernel.recordWritePreflightDecided(allowedDecision(preflight)),
    ).toThrow(expect.objectContaining({ code: "approval_required" }));
    expect(eventTypes(kernel)).not.toContain("WritePreflightDecided");
  });

  it("expired-approval-blocked", () => {
    const runId = "mission_critical_expired_approval";
    const kernel = startedKernel(runId);
    const preflight = criticalPreflight(runId);
    const scope = writeScope(preflight);
    const request = approvalRequest(runId, scope);
    const grant = approvalGrant(runId, scope, { expiresAt: shortExpiry });

    kernel.recordWritePreflightRequested(preflight);
    kernel.recordApprovalRequested(request);
    kernel.recordApprovalGranted(grant);

    expect(() =>
      kernel.recordWritePreflightDecided(
        allowedDecision(preflight, { approvalId: grant.approvalId }),
      ),
    ).toThrow(expect.objectContaining({ code: "approval_expired" }));
  });

  it("approval-wrong-scope-blocked", () => {
    const runId = "mission_critical_wrong_scope";
    const kernel = startedKernel(runId);
    const preflight = criticalPreflight(runId);
    const wrongScope: ApprovalScope = {
      kind: "write_preflight",
      preflightId: "preflight_wrong_scope",
      commandId: preflight.commandId,
      capabilityId: preflight.capabilityId,
      toolId: preflight.toolId,
      sideEffectClass: preflight.sideEffectClass,
      ...(preflight.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: preflight.idempotencyKey }),
    };
    const request = approvalRequest(runId, wrongScope);
    const grant = approvalGrant(runId, wrongScope);

    kernel.recordWritePreflightRequested(preflight);
    kernel.recordApprovalRequested(request);
    kernel.recordApprovalGranted(grant);

    expect(() =>
      kernel.recordWritePreflightDecided(
        allowedDecision(preflight, { approvalId: grant.approvalId }),
      ),
    ).toThrow(expect.objectContaining({ code: "approval_scope_mismatch" }));
  });

  it("approval-event-not-proof-evidence", () => {
    const runId = "mission_approval_not_proof";
    const kernel = startedKernel(runId);
    const preflight = criticalPreflight(runId);
    const scope = writeScope(preflight);
    const request = approvalRequest(runId, scope);
    const grant = approvalGrant(runId, scope);

    kernel.recordApprovalRequested(request, {
      eventId: "evt_mission_approval",
    });
    const grantEvent = kernel.recordApprovalGranted(grant, {
      eventId: "evt_mission_approval_granted",
    });

    const result = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim([
          {
            admissionStatus: "admitted",
            evidenceId: "ev_approval_not_proof",
            kind: "ledger_event",
            sourceEventId: grantEvent.eventId,
            hash: grantEvent.payloadHash,
            observedAt: grantedAt,
            sensitivity: "internal",
          },
        ]),
      ),
      {
        occurredAt: decidedAt,
        generatedAt: decidedAt,
      },
    );

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({ type: "missing_evidence" }),
    );
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });
});

function startedKernel(runId: string): InMemoryRunKernel {
  const kernel = new InMemoryRunKernel({
    runId,
    clock: () => startedAt,
  });
  kernel.startRun({ occurredAt: startedAt });
  return kernel;
}

function criticalPreflight(runId: string): WritePreflightCandidate {
  return {
    kind: "write_preflight_candidate",
    preflightId: "preflight_mission_critical",
    runId,
    commandId: "cmd_mission_critical",
    capabilityId: "deploy.promote",
    toolId: "deploy.production",
    sideEffectClass: "critical_write",
    argsHash: hashRunEventPayload({ environment: "production" }),
    requestedAt,
    idempotencyKey: "idem_mission_critical",
  };
}

function writeScope(preflight: WritePreflightCandidate): ApprovalScope {
  return {
    kind: "write_preflight",
    preflightId: preflight.preflightId,
    commandId: preflight.commandId,
    capabilityId: preflight.capabilityId,
    toolId: preflight.toolId,
    sideEffectClass: preflight.sideEffectClass,
    ...(preflight.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: preflight.idempotencyKey }),
  };
}

function approvalRequest(runId: string, scope: ApprovalScope): ApprovalRequest {
  return {
    kind: "approval_request",
    approvalId: "approval_mission_critical",
    runId,
    requestedBy: "agent_mission",
    scope,
    criticality: "critical",
    reason: "Critical mission write requires human approval.",
    requestedAt,
    expiresAt,
  };
}

function approvalGrant(
  runId: string,
  scope: ApprovalScope,
  options: { readonly expiresAt?: string } = {},
): ApprovalGrant {
  return {
    kind: "approval_grant",
    approvalId: "approval_mission_critical",
    runId,
    approverId: "human_mission",
    scope,
    grantedAt,
    expiresAt: options.expiresAt ?? expiresAt,
  };
}

function allowedDecision(
  preflight: WritePreflightCandidate,
  options: { readonly approvalId?: string } = {},
): WritePreflightDecision {
  return {
    kind: "write_preflight_decision",
    status: "allowed",
    runId: preflight.runId,
    preflightId: preflight.preflightId,
    commandId: preflight.commandId,
    capabilityId: preflight.capabilityId,
    toolId: preflight.toolId,
    sideEffectClass: preflight.sideEffectClass,
    idempotencyKey: preflight.idempotencyKey ?? "idem_mission_critical",
    decidedAt,
    ...(options.approvalId === undefined
      ? {}
      : { approvalId: options.approvalId }),
  };
}

function testResultClaim(evidenceRefs: Claim["evidenceRefs"]): Claim {
  return {
    claimId: "claim_approval_tests_passed",
    type: "test_result",
    statement: "Tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId: "shell.run_tests",
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
    },
    evidenceRefs,
    criticality: "medium",
  };
}

function candidateWith(runId: string, claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: "candidate_approval_not_proof",
    runId,
    claims: [claim],
  };
}

function eventTypes(kernel: InMemoryRunKernel): RunEvent["type"][] {
  return kernel.events().map((event) => event.type);
}
