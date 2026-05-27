import { hashRunEventPayload, RunKernelError } from "@amca/kernel";
import type {
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import {
  candidateWith,
  effectEvidenceRef,
  eventTypes,
  FRESH_OBSERVED_AT,
  GENERATED_AT,
  historicalActionClaim,
  startedKernel,
} from "./mission-helpers.js";

const BAD_HASH =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const;

describe("Mission P4 persisted preflight and quarantine events", () => {
  it("preflight-quarantine-events-persist-and-replay", () => {
    const runId = "mission_preflight_quarantine_replay";
    const kernel = startedKernel(runId);
    const candidate = writePreflightCandidate(runId);
    const requested = kernel.recordWritePreflightRequested(candidate, {
      eventId: "evt_mission_preflight_requested",
      occurredAt: FRESH_OBSERVED_AT,
      correlationId: "corr_mission_preflight",
    });
    const quarantine = writeQuarantineState(runId);
    const decision = quarantinedWritePreflightDecision(runId, quarantine);
    const decided = kernel.recordWritePreflightDecided(decision, {
      eventId: "evt_mission_preflight_decided",
      occurredAt: FRESH_OBSERVED_AT,
      causationId: requested.eventId,
      correlationId: "corr_mission_preflight",
    });
    kernel.recordWriteQuarantined(quarantine, {
      eventId: "evt_mission_write_quarantined",
      occurredAt: FRESH_OBSERVED_AT,
      causationId: decided.eventId,
      correlationId: "corr_mission_preflight",
    });

    expect(eventTypes(kernel)).toEqual([
      "RunStarted",
      "WritePreflightRequested",
      "WritePreflightDecided",
      "WriteQuarantined",
    ]);
    expect(kernel.replay().map((event) => event.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(eventTypes(kernel)).not.toContain("EffectReceiptRecorded");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("malformed-preflight-event-payloads-fail-closed", () => {
    const runId = "mission_preflight_malformed_fail_closed";
    const kernel = startedKernel(runId);
    const candidate = writePreflightCandidate(runId);
    const malformedCandidate = {
      ...candidate,
      unexpected: "field",
    } as unknown as WritePreflightCandidate;

    expect(() =>
      kernel.recordWritePreflightRequested(malformedCandidate, {
        eventId: "evt_malformed_preflight",
      }),
    ).toThrow();
    expect(kernel.events()).toHaveLength(1);

    expect(() =>
      kernel.recordWritePreflightRequested(candidate, {
        payloadHash: BAD_HASH,
      }),
    ).toThrow(RunKernelError);
    expect(kernel.events()).toHaveLength(1);
  });

  it("write-quarantine-events-cannot-support-proof-or-release", () => {
    const runId = "mission_quarantine_cannot_prove_release";
    const kernel = startedKernel(runId);
    const candidate = writePreflightCandidate(runId);
    const requested = kernel.recordWritePreflightRequested(candidate, {
      eventId: "evt_mission_quarantine_request",
    });
    const quarantine = writeQuarantineState(runId);
    const decision = quarantinedWritePreflightDecision(runId, quarantine);
    const decided = kernel.recordWritePreflightDecided(decision, {
      eventId: "evt_mission_quarantine_decision",
      causationId: requested.eventId,
    });
    const quarantined = kernel.recordWriteQuarantined(quarantine, {
      eventId: "evt_mission_quarantine_state",
      causationId: decided.eventId,
    });
    const forgedEvidence = effectEvidenceRef(
      "ev_mission_quarantine_as_receipt",
      quarantined.payloadHash,
      {
        sourceEventId: quarantined.eventId,
      },
    );

    const result = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        historicalActionClaim({ evidenceRefs: [forgedEvidence] }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(eventTypes(kernel)).toContain("WriteQuarantined");
    expect(eventTypes(kernel)).not.toContain("EffectReceiptRecorded");
    expect(result.proof.verdict).toBe("fail");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        claimId: "claim_pr_opened",
      }),
    );
    expect(result.decision.status).toBe("blocked");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });
});

function writePreflightCandidate(runId: string): WritePreflightCandidate {
  return {
    kind: "write_preflight_candidate",
    preflightId: "preflight_write_001",
    runId,
    commandId: "command_write_001",
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    argsHash: hashRunEventPayload({
      targetType: "protected_resource",
      targetId: "critical_001",
    }),
    requestedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}

function writeQuarantineState(runId: string): WriteQuarantineState {
  return {
    kind: "write_quarantine_state",
    quarantineId: "quarantine_write_001",
    runId,
    preflightId: "preflight_write_001",
    commandId: "command_write_001",
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    status: "quarantined",
    reason: "critical_approval_required",
    message: "Critical writes require a later approval phase.",
    quarantinedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}

function quarantinedWritePreflightDecision(
  runId: string,
  quarantine: WriteQuarantineState,
): Extract<WritePreflightDecision, { status: "quarantined" }> {
  return {
    kind: "write_preflight_decision",
    status: "quarantined",
    runId,
    preflightId: "preflight_write_001",
    commandId: "command_write_001",
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    quarantine,
    decidedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}
