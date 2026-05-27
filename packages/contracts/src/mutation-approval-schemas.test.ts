import type {
  ApprovalGrant,
  ApprovalRequest,
  MutationCommandRequest,
  MutationCommitted,
  RunEvent,
  WritePreflightDecision,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { canonicalHash } from "./hash.js";
import {
  validateApprovalGrant,
  validateApprovalRequest,
  validateMutationCommandRequest,
  validateMutationCommitted,
  validateRunEvent,
  validateWritePreflightDecision,
} from "./validate.js";

const observedAt = "2026-05-25T12:00:00.000Z";
const expiresAt = "2026-05-25T12:10:00.000Z";

describe("mutation and approval contract schemas", () => {
  it("validates structured mutation command requests and commits", () => {
    expect(validateMutationCommandRequest(mutationCommand).success).toBe(true);
    expect(validateMutationCommitted(mutationCommitted).success).toBe(true);
  });

  it("fails closed when mutation provenance is missing", () => {
    const malformed: Partial<MutationCommandRequest> = { ...mutationCommand };
    delete malformed.provenance;

    const result = validateMutationCommandRequest(malformed);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.path.join("."))).toContain(
        "provenance",
      );
    }
  });

  it("validates replayable mutation committed events", () => {
    const event = {
      eventId: "evt_mutation_committed",
      runId: "run_schema_mutation",
      sequence: 3,
      type: "MutationCommitted",
      payload: {
        mutation: mutationCommitted,
      },
      payloadHash: canonicalHash({ mutation: mutationCommitted }),
      causationId: "evt_mutation_proposed",
      correlationId: null,
      occurredAt: observedAt,
    } satisfies RunEvent<"MutationCommitted">;

    expect(validateRunEvent(event).success).toBe(true);
  });

  it("validates approval request/grant and approval-bearing critical decisions", () => {
    expect(validateApprovalRequest(approvalRequest).success).toBe(true);
    expect(validateApprovalGrant(approvalGrant).success).toBe(true);
    expect(validateWritePreflightDecision(criticalDecision).success).toBe(true);
  });

  it("validates replayable approval events", () => {
    const requested = {
      eventId: "evt_approval_requested",
      runId: "run_schema_mutation",
      sequence: 2,
      type: "ApprovalRequested",
      payload: {
        request: approvalRequest,
      },
      payloadHash: canonicalHash({ request: approvalRequest }),
      causationId: "evt_run_started",
      correlationId: null,
      occurredAt: observedAt,
    } satisfies RunEvent<"ApprovalRequested">;

    const granted = {
      eventId: "evt_approval_granted",
      runId: "run_schema_mutation",
      sequence: 3,
      type: "ApprovalGranted",
      payload: {
        grant: approvalGrant,
      },
      payloadHash: canonicalHash({ grant: approvalGrant }),
      causationId: requested.eventId,
      correlationId: null,
      occurredAt: observedAt,
    } satisfies RunEvent<"ApprovalGranted">;

    expect(validateRunEvent(requested).success).toBe(true);
    expect(validateRunEvent(granted).success).toBe(true);
  });
});

const mutationCommandWithoutHash = {
  kind: "mutation_command_request",
  commandId: "cmd_mutation_schema",
  mutationId: "mut_schema",
  runId: "run_schema_mutation",
  target: {
    stateRef: "state://schema",
  },
  operation: {
    kind: "merge",
    path: "/",
    value: { enabled: true },
  },
  precondition: {
    expectedRevision: 0,
  },
  provenance: {
    kind: "system_policy",
    sourceEventId: "evt_policy_schema",
    reason: "Schema fixture.",
    actorId: "agent_schema",
  },
  requestedAt: observedAt,
} as const;

const mutationCommand = {
  ...mutationCommandWithoutHash,
  payloadHash: canonicalHash(mutationCommandWithoutHash),
} satisfies MutationCommandRequest;

const mutationCommittedWithoutHash = {
  kind: "mutation_committed",
  mutationId: mutationCommand.mutationId,
  commandId: mutationCommand.commandId,
  runId: mutationCommand.runId,
  stateRef: mutationCommand.target.stateRef,
  previousRevision: 0,
  newRevision: 1,
  operation: mutationCommand.operation,
  provenance: mutationCommand.provenance,
  committedAt: observedAt,
} as const;

const mutationCommitted = {
  ...mutationCommittedWithoutHash,
  payloadHash: canonicalHash(mutationCommittedWithoutHash),
} satisfies MutationCommitted;

const approvalScope = {
  kind: "write_preflight",
  preflightId: "preflight_critical_schema",
  commandId: "cmd_critical_schema",
  capabilityId: "deploy.promote",
  toolId: "deploy.production",
  sideEffectClass: "critical_write",
  idempotencyKey: "idem_critical_schema",
} as const;

const approvalRequest = {
  kind: "approval_request",
  approvalId: "approval_schema",
  runId: "run_schema_mutation",
  requestedBy: "agent_schema",
  scope: approvalScope,
  criticality: "critical",
  reason: "Schema fixture critical write.",
  requestedAt: observedAt,
  expiresAt,
} satisfies ApprovalRequest;

const approvalGrant = {
  kind: "approval_grant",
  approvalId: approvalRequest.approvalId,
  runId: approvalRequest.runId,
  approverId: "human_schema",
  scope: approvalScope,
  grantedAt: observedAt,
  expiresAt,
} satisfies ApprovalGrant;

const criticalDecision = {
  kind: "write_preflight_decision",
  status: "allowed",
  runId: "run_schema_mutation",
  preflightId: approvalScope.preflightId,
  commandId: approvalScope.commandId,
  capabilityId: approvalScope.capabilityId,
  toolId: approvalScope.toolId,
  sideEffectClass: "critical_write",
  idempotencyKey: approvalScope.idempotencyKey,
  decidedAt: observedAt,
  approvalId: approvalGrant.approvalId,
} satisfies WritePreflightDecision;
