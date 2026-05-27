import { describe, expect, it } from "vitest";

import { canonicalObjectHash } from "@amca/contracts";
import { hashRunEventPayload, InMemoryRunKernel } from "@amca/kernel";
import type {
  Claim,
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  MutationCommandRequest,
  MutationOperation,
  RunEvent,
  Sha256Hash,
  ToolCommandRequest,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";

import { replayRunEvents } from "./replay-runner.js";

const startedAt = "2026-05-24T12:00:00.000Z";
const observedAt = "2026-05-24T12:00:01.000Z";
const generatedAt = "2026-05-24T12:00:02.000Z";
const badHash =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" satisfies Sha256Hash;

describe("replayRunEvents", () => {
  it("reconstructs a released run from accepted semantic events", () => {
    const { events } = releasedRun("run_replay_released");

    const replay = replayRunEvents({ events });

    expect(replay).toMatchObject({
      status: "passed",
      runId: "run_replay_released",
      replayedDecision: {
        status: "released",
      },
      storedDecision: {
        status: "released",
      },
    });
  });

  it("reconstructs a released run from ledger-hydrated accepted events", () => {
    const { events } = releasedRun("run_replay_ledger_released");

    const replay = replayRunEvents({
      events: ledgerHydrateEvents(events),
    });

    expect(replay).toMatchObject({
      status: "passed",
      runId: "run_replay_ledger_released",
      replayedDecision: {
        status: "released",
      },
      storedDecision: {
        status: "released",
      },
    });
  });

  it("reconstructs a blocked unsupported claim without minting evidence", () => {
    const events = blockedRun("run_replay_blocked");

    const replay = replayRunEvents({ events });

    expect(replay).toMatchObject({
      status: "passed",
      runId: "run_replay_blocked",
      replayedDecision: {
        status: "blocked",
      },
      storedDecision: {
        status: "blocked",
      },
    });
  });

  it("reconstructs a blocked ledger-hydrated run without minting evidence", () => {
    const events = blockedRun("run_replay_ledger_blocked");

    const replay = replayRunEvents({
      events: ledgerHydrateEvents(events),
    });

    expect(replay).toMatchObject({
      status: "passed",
      runId: "run_replay_ledger_blocked",
      replayedDecision: {
        status: "blocked",
      },
      storedDecision: {
        status: "blocked",
      },
    });
  });

  it("reconstructs runs with persisted preflight and quarantine events", () => {
    const events = preflightQuarantinedRun("run_replay_preflight_quarantine");

    const replay = replayRunEvents({ events });

    expect(replay).toMatchObject({
      status: "passed",
      runId: "run_replay_preflight_quarantine",
      replayedDecision: {
        status: "blocked",
      },
      storedDecision: {
        status: "blocked",
      },
    });
    if (replay.status !== "passed") {
      throw new Error("Expected replay to pass.");
    }
    expect(replay.replayedEvents.map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
  });

  it("reconstructs runs with persisted mutation commits", () => {
    const events = mutationCommittedRun("run_replay_mutation_committed");

    const replay = replayRunEvents({ events });

    expect(replay).toMatchObject({
      status: "passed",
      runId: "run_replay_mutation_committed",
      replayedDecision: {
        status: "blocked",
      },
    });
    if (replay.status !== "passed") {
      throw new Error("Expected replay to pass.");
    }
    expect(replay.replayedEvents.map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
  });

  it("fails closed when the ledger stream is missing the release decision", () => {
    const { events } = releasedRun("run_replay_missing_release");
    const missingRelease = resequence(
      events.filter(
        (event) =>
          event.type !== "ReleaseDecided" && event.type !== "FinalReleased",
      ),
    );

    const replay = replayRunEvents({
      events: ledgerHydrateEvents(missingRelease),
    });

    expect(replay).toMatchObject({
      status: "failed",
      code: "release_event_missing",
    });
    expect(replay.notes.join("\n")).toContain("no ReleaseDecided event");
  });

  it("fails closed when payload hashes are mutated", () => {
    const { events } = releasedRun("run_replay_mutated_hash");
    const mutated: RunEvent[] = events.map((event, index) =>
      index === 1
        ? {
            ...event,
            payloadHash: badHash,
          }
        : event,
    );

    const replay = replayRunEvents({ events: mutated });

    expect(replay).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
    expect(replay.notes.join("\n")).toContain("payloadHash");
  });

  it("fails closed when the input stream is reordered", () => {
    const { events } = releasedRun("run_replay_reordered");
    const reordered = [events[1], events[0], ...events.slice(2)].filter(
      (event): event is RunEvent => event !== undefined,
    );

    const replay = replayRunEvents({ events: reordered });

    expect(replay).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
    expect(replay.notes.join("\n")).toContain("contiguous sequence order");
  });

  it("fails closed when the input stream has non-contiguous ledger sequence numbers", () => {
    const { events } = releasedRun("run_replay_non_contiguous");
    const nonContiguous = events.map((event, index) =>
      index >= 2
        ? {
            ...event,
            sequence: event.sequence + 1,
          }
        : event,
    );

    const replay = replayRunEvents({ events: nonContiguous });

    expect(replay).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
    expect(replay.notes.join("\n")).toContain("contiguous sequence order");
  });

  it("fails closed when a receipt appears without a prior effect request", () => {
    const { events } = releasedRun("run_replay_receipt_without_request");
    const withoutEffectRequest = resequence(
      events.filter((event) => event.type !== "EffectRequested"),
    );

    const replay = replayRunEvents({ events: withoutEffectRequest });

    expect(replay).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
    expect(replay.notes.join("\n")).toContain("was not requested");
  });
});

function releasedRun(runId: string): {
  readonly events: readonly RunEvent[];
  readonly evidenceRef: EvidenceRef;
} {
  const kernel = startedKernel(runId);
  kernel.submitToolCommand(toolCommand(runId), {
    eventId: `evt_${runId}_tool_proposed`,
    occurredAt: startedAt,
  });
  kernel.recordEffectRequest(effectRequest(runId), {
    eventId: `evt_${runId}_effect_requested`,
    occurredAt: observedAt,
  });

  const payload = testPayload();
  const evidenceRef = evidence(runId, canonicalObjectHash(payload));
  kernel.recordEffectReceipt(receipt(runId, payload, evidenceRef), {
    eventId: evidenceRef.sourceEventId,
    occurredAt: observedAt,
  });
  kernel.submitFinalCandidate(candidate(runId, [evidenceRef]), {
    eventId: `evt_${runId}_final_proposed`,
    occurredAt: generatedAt,
    generatedAt,
    proofId: `proof_${runId}`,
    proofEventId: `evt_${runId}_proof_generated`,
    releaseEventId: `evt_${runId}_release_decided`,
    finalReleasedEventId: `evt_${runId}_final_released`,
  });

  return {
    events: kernel.events(),
    evidenceRef,
  };
}

function blockedRun(runId: string): readonly RunEvent[] {
  const kernel = startedKernel(runId);
  kernel.submitToolCommand(toolCommand(runId), {
    eventId: `evt_${runId}_tool_proposed`,
    occurredAt: startedAt,
  });
  kernel.recordEffectRequest(effectRequest(runId), {
    eventId: `evt_${runId}_effect_requested`,
    occurredAt: observedAt,
  });
  kernel.submitFinalCandidate(candidate(runId, []), {
    eventId: `evt_${runId}_final_proposed`,
    occurredAt: generatedAt,
    generatedAt,
    proofId: `proof_${runId}`,
    proofEventId: `evt_${runId}_proof_generated`,
    mismatchEventIds: [`evt_${runId}_mismatch_detected`],
    releaseEventId: `evt_${runId}_release_decided`,
  });

  return kernel.events();
}

function preflightQuarantinedRun(runId: string): readonly RunEvent[] {
  const kernel = startedKernel(runId);
  const preflight = writePreflightCandidate(runId);
  const requested = kernel.recordWritePreflightRequested(preflight, {
    eventId: `evt_${runId}_preflight_requested`,
    occurredAt: observedAt,
  });
  const quarantine = writeQuarantineState(runId);
  const decision = quarantinedWritePreflightDecision(runId, quarantine);
  const decided = kernel.recordWritePreflightDecided(decision, {
    eventId: `evt_${runId}_preflight_decided`,
    causationId: requested.eventId,
    occurredAt: observedAt,
  });
  kernel.recordWriteQuarantined(quarantine, {
    eventId: `evt_${runId}_write_quarantined`,
    causationId: decided.eventId,
    occurredAt: observedAt,
  });
  kernel.submitFinalCandidate(candidate(runId, []), {
    eventId: `evt_${runId}_final_proposed`,
    occurredAt: generatedAt,
    generatedAt,
    proofId: `proof_${runId}`,
    proofEventId: `evt_${runId}_proof_generated`,
    mismatchEventIds: [`evt_${runId}_mismatch_detected`],
    releaseEventId: `evt_${runId}_release_decided`,
  });

  return kernel.events();
}

function mutationCommittedRun(runId: string): readonly RunEvent[] {
  const kernel = startedKernel(runId);
  const mutation = mutationCommand(runId, {
    commandId: `cmd_mutation_${runId}`,
    mutationId: `mut_${runId}`,
  });

  const proposed = kernel.submitMutationCommand(mutation, {
    eventId: `evt_${runId}_mutation_proposed`,
    occurredAt: observedAt,
  });
  kernel.commitMutation(mutation, {
    eventId: `evt_${runId}_mutation_committed`,
    causationId: proposed.eventId,
    occurredAt: observedAt,
  });
  kernel.submitFinalCandidate(candidate(runId, []), {
    eventId: `evt_${runId}_final_proposed`,
    occurredAt: generatedAt,
    generatedAt,
    proofId: `proof_${runId}`,
    proofEventId: `evt_${runId}_proof_generated`,
    mismatchEventIds: [`evt_${runId}_mismatch_detected`],
    releaseEventId: `evt_${runId}_release_decided`,
  });

  return kernel.events();
}

function startedKernel(runId: string): InMemoryRunKernel {
  const kernel = new InMemoryRunKernel({
    runId,
    clock: () => generatedAt,
  });
  kernel.startRun({
    eventId: `evt_${runId}_started`,
    occurredAt: startedAt,
    profile: "standard",
  });
  return kernel;
}

function toolCommand(runId: string): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: `cmd_${runId}`,
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      testSuiteId: "unit",
    },
    sideEffectClass: "compute",
  };
}

function effectRequest(runId: string): EffectRequest {
  return {
    effectId: `effect_${runId}`,
    commandId: `cmd_${runId}`,
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      testSuiteId: "unit",
    },
    sideEffectClass: "compute",
    requestedAt: observedAt,
  };
}

function receipt(
  runId: string,
  payload: JsonObject,
  evidenceRef: EvidenceRef,
): EffectReceipt {
  return {
    receiptId: `receipt_${runId}`,
    effectId: `effect_${runId}`,
    runId,
    capabilityId: "shell.run_tests",
    receiptType: "test_run",
    status: "succeeded",
    payload,
    payloadHash: canonicalObjectHash(payload),
    evidence: [evidenceRef],
    observedAt,
  };
}

function writePreflightCandidate(runId: string): WritePreflightCandidate {
  return {
    kind: "write_preflight_candidate",
    preflightId: `preflight_${runId}`,
    runId,
    commandId: `cmd_write_${runId}`,
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    argsHash: canonicalObjectHash({
      targetType: "protected_resource",
      targetId: "critical_001",
    }),
    requestedAt: observedAt,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}

function writeQuarantineState(runId: string): WriteQuarantineState {
  return {
    kind: "write_quarantine_state",
    quarantineId: `quarantine_${runId}`,
    runId,
    preflightId: `preflight_${runId}`,
    commandId: `cmd_write_${runId}`,
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    status: "quarantined",
    reason: "critical_approval_required",
    message: "Critical writes require a later approval phase.",
    quarantinedAt: observedAt,
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
    preflightId: `preflight_${runId}`,
    commandId: `cmd_write_${runId}`,
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    quarantine,
    decidedAt: observedAt,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}

function mutationCommand(
  runId: string,
  input: {
    readonly commandId: string;
    readonly mutationId: string;
    readonly operation?: MutationOperation;
  },
): MutationCommandRequest {
  const commandWithoutHash = {
    kind: "mutation_command_request",
    commandId: input.commandId,
    mutationId: input.mutationId,
    runId,
    target: {
      stateRef: "state://replay",
    },
    operation: input.operation ?? { kind: "set", path: "/mode", value: "safe" },
    precondition: {
      expectedRevision: 0,
    },
    provenance: {
      kind: "system_policy",
      sourceEventId: `evt_${runId}_started`,
      reason: "Replay mutation fixture.",
    },
    requestedAt: observedAt,
  } as const;

  return {
    ...commandWithoutHash,
    payloadHash: canonicalObjectHash(
      commandWithoutHash as unknown as JsonObject,
    ),
  };
}

function evidence(
  runId: string,
  hash: EffectReceipt["payloadHash"],
): EvidenceRef {
  return {
    evidenceId: `ev_${runId}`,
    kind: "effect_receipt",
    sourceEventId: `evt_${runId}_receipt_recorded`,
    hash,
    observedAt,
    sensitivity: "internal",
  };
}

function candidate(
  runId: string,
  evidenceRefs: readonly EvidenceRef[],
): FinalCandidate {
  const claim: Claim = {
    claimId: `claim_${runId}_tests_passed`,
    type: "test_result",
    statement: "Tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId: "shell.run_tests",
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
      testSuiteId: "unit",
    },
    evidenceRefs: [...evidenceRefs],
    criticality: "medium",
  };

  return {
    kind: "final_candidate",
    candidateId: `candidate_${runId}`,
    runId,
    claims: [claim],
  };
}

function testPayload(): JsonObject {
  return {
    result: "passed",
    testSuiteId: "unit",
  };
}

function resequence(events: readonly RunEvent[]): RunEvent[] {
  return events.map((event, index) => {
    const sequence = index + 1;
    const causationId =
      event.causationId === null ||
      events.some((candidate) => candidate.eventId === event.causationId)
        ? event.causationId
        : (events[index - 1]?.eventId ?? null);

    return {
      ...event,
      sequence,
      causationId,
      payloadHash: hashRunEventPayload(event.payload),
    };
  });
}

function ledgerHydrateEvents(events: readonly RunEvent[]): RunEvent[] {
  return JSON.parse(JSON.stringify(events)) as RunEvent[];
}
