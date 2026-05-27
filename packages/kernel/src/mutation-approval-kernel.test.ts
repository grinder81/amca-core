import { canonicalObjectHash } from "@amca/contracts";
import type {
  ApprovalGrant,
  ApprovalRequest,
  ApprovalScope,
  Claim,
  FinalCandidate,
  JsonObject,
  MutationCommandRequest,
  MutationOperation,
  RunEvent,
  WritePreflightCandidate,
  WritePreflightDecision,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { InMemoryRunKernel, RunKernelError } from "./index.js";

const STARTED_AT = "2026-05-25T12:00:00.000Z";
const REQUESTED_AT = "2026-05-25T12:01:00.000Z";
const GRANTED_AT = "2026-05-25T12:02:00.000Z";
const DECIDED_AT = "2026-05-25T12:03:00.000Z";
const EXPIRES_AT = "2026-05-25T12:10:00.000Z";
const EXPIRED_AT = "2026-05-25T12:02:30.000Z";

describe("mutation kernel and human approvals", () => {
  it("blocks direct state mutation without a recorded MutationCommandRequest proposal", () => {
    const runId = "run_mutation_direct_write_blocked";
    const kernel = startedKernel(runId);
    const command = mutationCommand(runId, {
      commandId: "cmd_mutation_direct",
      mutationId: "mut_direct",
    });

    expect(() => kernel.commitMutation(command)).toThrow(RunKernelError);
    expect(() => kernel.commitMutation(command)).toThrow(
      /no matching MutationCommandRequest/u,
    );
    expect(kernel.stateRevision("state://settings")).toBe(0);
    expect(eventTypes(kernel)).not.toContain("MutationCommitted");
  });

  it("blocks stale mutation revisions", () => {
    const runId = "run_mutation_stale_revision";
    const kernel = startedKernel(runId);
    const first = mutationCommand(runId, {
      commandId: "cmd_mutation_first",
      mutationId: "mut_first",
      expectedRevision: 0,
    });
    const stale = mutationCommand(runId, {
      commandId: "cmd_mutation_stale",
      mutationId: "mut_stale",
      expectedRevision: 0,
      operation: { kind: "set", path: "/mode", value: "manual" },
    });

    kernel.submitMutationCommand(first);
    kernel.commitMutation(first, { occurredAt: "2026-05-25T12:02:00.000Z" });
    kernel.submitMutationCommand(stale);

    expect(() => kernel.commitMutation(stale)).toThrow(
      expect.objectContaining({ code: "mutation_stale_revision" }),
    );
    expect(kernel.stateRevision("state://settings")).toBe(1);
  });

  it("blocks mutation proposals without provenance", () => {
    const runId = "run_mutation_without_provenance";
    const kernel = startedKernel(runId);
    const malformed: Partial<MutationCommandRequest> = {
      ...mutationCommand(runId, {
        commandId: "cmd_without_provenance",
        mutationId: "mut_without_provenance",
      }),
    };
    delete malformed.provenance;

    expect(() =>
      kernel.submitMutationCommand(
        malformed as unknown as MutationCommandRequest,
      ),
    ).toThrow(/MutationCommandRequest validation failed/u);
    expect(eventTypes(kernel)).toEqual(["RunStarted"]);
  });

  it("records replayable MutationCommitted authority events", () => {
    const runId = "run_mutation_replayable";
    const kernel = startedKernel(runId);
    const command = mutationCommand(runId, {
      commandId: "cmd_mutation_replay",
      mutationId: "mut_replay",
    });

    kernel.submitMutationCommand(command, { eventId: "evt_mutation_proposed" });
    const committed = kernel.commitMutation(command, {
      eventId: "evt_mutation_committed",
      occurredAt: "2026-05-25T12:02:00.000Z",
      causationId: "evt_mutation_proposed",
    });
    const result = kernel.submitFinalCandidate(
      candidateWith(runId, testResultClaim([])),
      {
        occurredAt: "2026-05-25T12:03:00.000Z",
        generatedAt: "2026-05-25T12:03:00.000Z",
      },
    );

    expect(committed.payload.mutation).toMatchObject({
      kind: "mutation_committed",
      previousRevision: 0,
      newRevision: 1,
      stateRef: "state://settings",
    });
    expect(result.decision.status).toBe("blocked");
    expect(eventTypes(kernel)).toContain("MutationCommitted");
    expect(kernel.replay().map((event) => event.type)).toContain(
      "MutationCommitted",
    );
  });

  it("blocks critical writes without scoped approval", () => {
    const runId = "run_critical_without_approval";
    const kernel = startedKernel(runId);
    const candidate = criticalWritePreflightCandidate(runId);
    kernel.recordWritePreflightRequested(candidate);

    expect(() =>
      kernel.recordWritePreflightDecided(allowedCriticalDecision(candidate)),
    ).toThrow(expect.objectContaining({ code: "approval_required" }));
    expect(eventTypes(kernel)).not.toContain("WritePreflightDecided");
  });

  it("blocks critical writes when approval is expired", () => {
    const runId = "run_critical_expired_approval";
    const kernel = startedKernel(runId);
    const candidate = criticalWritePreflightCandidate(runId);
    const scope = writeScope(candidate);
    const request = approvalRequest(runId, scope);
    const grant = approvalGrant(runId, scope, { expiresAt: EXPIRED_AT });

    kernel.recordWritePreflightRequested(candidate);
    kernel.recordApprovalRequested(request);
    kernel.recordApprovalGranted(grant);

    expect(() =>
      kernel.recordWritePreflightDecided(
        allowedCriticalDecision(candidate, { approvalId: grant.approvalId }),
      ),
    ).toThrow(expect.objectContaining({ code: "approval_expired" }));
  });

  it("blocks critical writes when approval scope does not match", () => {
    const runId = "run_critical_wrong_scope";
    const kernel = startedKernel(runId);
    const candidate = criticalWritePreflightCandidate(runId);
    const wrongScope: ApprovalScope = {
      kind: "write_preflight",
      preflightId: "preflight_other",
      commandId: candidate.commandId,
      capabilityId: candidate.capabilityId,
      toolId: candidate.toolId,
      sideEffectClass: candidate.sideEffectClass,
      ...(candidate.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: candidate.idempotencyKey }),
    };
    const request = approvalRequest(runId, wrongScope);
    const grant = approvalGrant(runId, wrongScope);

    kernel.recordWritePreflightRequested(candidate);
    kernel.recordApprovalRequested(request);
    kernel.recordApprovalGranted(grant);

    expect(() =>
      kernel.recordWritePreflightDecided(
        allowedCriticalDecision(candidate, { approvalId: grant.approvalId }),
      ),
    ).toThrow(expect.objectContaining({ code: "approval_scope_mismatch" }));
  });

  it("does not allow approval events to serve as proof evidence", () => {
    const runId = "run_approval_not_proof";
    const kernel = startedKernel(runId);
    const candidate = criticalWritePreflightCandidate(runId);
    const scope = writeScope(candidate);
    const request = approvalRequest(runId, scope);
    const grant = approvalGrant(runId, scope);

    kernel.recordApprovalRequested(request, {
      eventId: "evt_approval_request",
    });
    const grantEvent = kernel.recordApprovalGranted(grant, {
      eventId: "evt_approval_grant",
    });

    const result = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim([
          {
            admissionStatus: "admitted",
            evidenceId: "ev_approval_event",
            kind: "ledger_event",
            sourceEventId: grantEvent.eventId,
            hash: grantEvent.payloadHash,
            observedAt: GRANTED_AT,
            sensitivity: "internal",
          },
        ]),
      ),
      {
        occurredAt: DECIDED_AT,
        generatedAt: DECIDED_AT,
      },
    );

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        claimId: "claim_tests_passed",
      }),
    );
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });
});

function startedKernel(runId: string): InMemoryRunKernel {
  const kernel = new InMemoryRunKernel({
    runId,
    clock: () => STARTED_AT,
  });
  kernel.startRun({ occurredAt: STARTED_AT });
  return kernel;
}

function mutationCommand(
  runId: string,
  input: {
    readonly commandId: string;
    readonly mutationId: string;
    readonly expectedRevision?: number;
    readonly operation?: MutationOperation;
  },
): MutationCommandRequest {
  const commandWithoutHash = {
    kind: "mutation_command_request" as const,
    commandId: input.commandId,
    mutationId: input.mutationId,
    runId,
    target: {
      stateRef: "state://settings",
    },
    operation: input.operation ?? { kind: "set", path: "/mode", value: "auto" },
    precondition: {
      expectedRevision: input.expectedRevision ?? 0,
    },
    provenance: {
      kind: "system_policy" as const,
      sourceEventId: "evt_policy_lock",
      reason: "Apply governed test state change.",
      actorId: "agent_worker_h",
    },
    requestedAt: REQUESTED_AT,
  };

  return {
    ...commandWithoutHash,
    payloadHash: canonicalObjectHash(
      commandWithoutHash as unknown as JsonObject,
    ),
  };
}

function criticalWritePreflightCandidate(
  runId: string,
): WritePreflightCandidate {
  return {
    kind: "write_preflight_candidate",
    preflightId: "preflight_critical_deploy",
    runId,
    commandId: "cmd_critical_deploy",
    capabilityId: "deploy.promote",
    toolId: "deploy.production",
    sideEffectClass: "critical_write",
    argsHash: canonicalObjectHash({ environment: "production" }),
    requestedAt: REQUESTED_AT,
    idempotencyKey: "idem_critical_deploy",
  };
}

function allowedCriticalDecision(
  candidate: WritePreflightCandidate,
  options: { readonly approvalId?: string } = {},
): WritePreflightDecision {
  return {
    kind: "write_preflight_decision",
    status: "allowed",
    runId: candidate.runId,
    preflightId: candidate.preflightId,
    commandId: candidate.commandId,
    capabilityId: candidate.capabilityId,
    toolId: candidate.toolId,
    sideEffectClass: candidate.sideEffectClass,
    idempotencyKey: candidate.idempotencyKey ?? "idem_critical_deploy",
    decidedAt: DECIDED_AT,
    ...(options.approvalId === undefined
      ? {}
      : { approvalId: options.approvalId }),
  };
}

function writeScope(candidate: WritePreflightCandidate): ApprovalScope {
  return {
    kind: "write_preflight",
    preflightId: candidate.preflightId,
    commandId: candidate.commandId,
    capabilityId: candidate.capabilityId,
    toolId: candidate.toolId,
    sideEffectClass: candidate.sideEffectClass,
    ...(candidate.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: candidate.idempotencyKey }),
  };
}

function approvalRequest(runId: string, scope: ApprovalScope): ApprovalRequest {
  return {
    kind: "approval_request",
    approvalId: "approval_critical_deploy",
    runId,
    requestedBy: "agent_worker_h",
    scope,
    criticality: "critical",
    reason: "Critical production write requires human approval.",
    requestedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function approvalGrant(
  runId: string,
  scope: ApprovalScope,
  options: { readonly expiresAt?: string } = {},
): ApprovalGrant {
  return {
    kind: "approval_grant",
    approvalId: "approval_critical_deploy",
    runId,
    approverId: "human_approver_001",
    scope,
    grantedAt: GRANTED_AT,
    expiresAt: options.expiresAt ?? EXPIRES_AT,
  };
}

function testResultClaim(evidenceRefs: Claim["evidenceRefs"]): Claim {
  return {
    claimId: "claim_tests_passed",
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
    candidateId: "candidate_mutation_approval",
    runId,
    claims: [claim],
  };
}

function eventTypes(kernel: InMemoryRunKernel): RunEvent["type"][] {
  return kernel.events().map((event) => event.type);
}
