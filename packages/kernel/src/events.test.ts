import { describe, expect, it } from "vitest";

import type { RunEvent } from "@amca/protocol";

import {
  EventValidationError,
  hashRunEventPayload,
  InMemoryLedger,
} from "./index.js";

const runId = "run_phase_03_events";
const occurredAt = "2026-05-24T12:00:00.000Z";

describe("in-memory event ledger", () => {
  it("appends events in deterministic order with causation and correlation ids", () => {
    const ledger = new InMemoryLedger({ runId });

    const started = appendRunStarted(ledger, "evt_001");
    const proposal = ledger.append({
      eventId: "evt_002",
      runId,
      type: "ProposalReceived",
      payload: {
        proposal: {
          kind: "tool_command_request",
          commandId: "cmd_001",
          runId,
          capabilityId: "capability.test_runner",
          toolId: "tool.test_runner",
          args: { suite: "kernel" },
          sideEffectClass: "compute",
        },
      },
      causationId: started.eventId,
      correlationId: "corr_001",
      occurredAt,
    });

    expect(started.sequence).toBe(1);
    expect(proposal.sequence).toBe(2);
    expect(proposal.causationId).toBe(started.eventId);
    expect(proposal.correlationId).toBe("corr_001");
    expect(ledger.events().map((event) => event.eventId)).toEqual([
      "evt_001",
      "evt_002",
    ]);
  });

  it("replays a persisted event sequence in sequence order", () => {
    const ledger = new InMemoryLedger({ runId });
    appendRunStarted(ledger, "evt_001");
    ledger.append({
      eventId: "evt_002",
      runId,
      type: "ExternalStateObserved",
      payload: {
        observation: {
          observationId: "obs_001",
          runId,
          observationType: "workspace_state",
          subjectType: "package",
          subjectId: "@amca/kernel",
          observedState: { status: "ready" },
          observedAt: occurredAt,
          expiresAt: "2026-05-24T12:05:00.000Z",
          payloadHash: hashRunEventPayload({ status: "ready" }),
          evidence: [],
        },
      },
      causationId: "evt_001",
      correlationId: "corr_replay",
      occurredAt,
    });

    const replayedLedger = new InMemoryLedger({
      runId,
      initialEvents: ledger.events().reverse(),
    });

    expect(replayedLedger.replay().map((event) => event.eventId)).toEqual([
      "evt_001",
      "evt_002",
    ]);
  });

  it("rejects a sequence that goes backward or skips the next position", () => {
    const ledger = new InMemoryLedger({ runId });
    appendRunStarted(ledger, "evt_001");

    expectEventError(
      () =>
        ledger.append({
          eventId: "evt_002",
          runId,
          sequence: 1,
          type: "RunStarted",
          payload: { runId },
          occurredAt,
        }),
      "invalid_sequence",
    );

    expectEventError(
      () =>
        ledger.append({
          eventId: "evt_003",
          runId,
          sequence: 3,
          type: "RunStarted",
          payload: { runId },
          occurredAt,
        }),
      "invalid_sequence",
    );
  });

  it("attaches a payloadHash when absent and verifies a provided payloadHash", () => {
    const payload = { runId, profile: "standard" };
    const payloadHash = hashRunEventPayload(payload);

    const ledger = new InMemoryLedger({ runId });
    const started = ledger.append({
      eventId: "evt_001",
      runId,
      type: "RunStarted",
      payload,
      occurredAt,
    });

    expect(started.payloadHash).toBe(payloadHash);

    const secondLedger = new InMemoryLedger({ runId });
    expect(
      secondLedger.append({
        eventId: "evt_001",
        runId,
        type: "RunStarted",
        payload,
        payloadHash,
        occurredAt,
      }).payloadHash,
    ).toBe(payloadHash);

    expectEventError(
      () =>
        new InMemoryLedger({ runId }).append({
          eventId: "evt_bad_hash",
          runId,
          type: "RunStarted",
          payload,
          payloadHash: "sha256:not-the-payload",
          occurredAt,
        }),
      "payload_hash_mismatch",
    );
  });

  it("uses canonical object key order for payload hashing", () => {
    expect(hashRunEventPayload({ b: 2, a: 1 })).toBe(
      hashRunEventPayload({ a: 1, b: 2 }),
    );
    expect(hashRunEventPayload({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("rejects runId mismatches", () => {
    const ledger = new InMemoryLedger({ runId });

    expectEventError(
      () =>
        ledger.append({
          eventId: "evt_001",
          runId: "run_other",
          type: "RunStarted",
          payload: { runId: "run_other" },
          occurredAt,
        }),
      "run_id_mismatch",
    );
  });

  it("rejects duplicate event IDs and dangling causation IDs", () => {
    const ledger = new InMemoryLedger({ runId });
    appendRunStarted(ledger, "evt_001");

    expectEventError(
      () => appendRunStarted(ledger, "evt_001"),
      "duplicate_event_id",
    );

    expectEventError(
      () =>
        ledger.append({
          eventId: "evt_002",
          runId,
          type: "RunStarted",
          payload: { runId },
          causationId: "evt_missing",
          occurredAt,
        }),
      "invalid_causation_id",
    );
  });

  it("rejects replay events that point causation at themselves", () => {
    const ledger = new InMemoryLedger({ runId });
    const event = appendRunStarted(ledger, "evt_001");

    expectEventError(
      () =>
        new InMemoryLedger({
          runId,
          initialEvents: [{ ...event, causationId: event.eventId }],
        }),
      "invalid_causation_id",
    );
  });
});

function appendRunStarted(
  ledger: InMemoryLedger,
  eventId: string,
): RunEvent<"RunStarted"> {
  return ledger.append({
    eventId,
    runId,
    type: "RunStarted",
    payload: { runId, profile: "standard" },
    occurredAt,
  });
}

function expectEventError(
  operation: () => void,
  code: EventValidationError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EventValidationError);
    expect((error as EventValidationError).code).toBe(code);
    return;
  }

  throw new Error(`Expected EventValidationError with code ${code}.`);
}
