import { describe, expect, it } from "vitest";

import type { RunEvent } from "@amca/protocol";

import {
  InMemorySemanticLedger,
  LedgerError,
  hashRunEventPayload,
  validateOrderedRunEvents,
} from "./index.js";

const runId = "run_phase_20_ledger";
const otherRunId = "run_other";
const occurredAt = "2026-05-24T12:00:00.000Z";

describe("semantic ledger port contract", () => {
  it("appends accepted RunEvent objects in strict sequence order", async () => {
    const ledger = new InMemorySemanticLedger();

    await expect(ledger.hasRun(runId)).resolves.toBe(false);
    await expect(ledger.appendAcceptedEvent(startedEvent())).resolves.toEqual({
      runId,
      eventId: "evt_001",
      sequence: 1,
    });
    await expect(
      ledger.appendAcceptedEvent(proposalEvent({ sequence: 2 })),
    ).resolves.toEqual({
      runId,
      eventId: "evt_002",
      sequence: 2,
    });

    await expect(ledger.hasRun(runId)).resolves.toBe(true);
    await expect(ledger.readRunEvents(runId)).resolves.toMatchObject([
      { eventId: "evt_001", sequence: 1 },
      { eventId: "evt_002", sequence: 2 },
    ]);
  });

  it("rejects duplicate event IDs and duplicate sequences", async () => {
    const ledger = new InMemorySemanticLedger();
    await ledger.appendAcceptedEvent(startedEvent());

    await expectLedgerError(
      () => ledger.appendAcceptedEvent(startedEvent()),
      "duplicate_event_id",
    );

    await expectLedgerError(
      () =>
        ledger.appendAcceptedEvent(
          proposalEvent({ eventId: "evt_duplicate_sequence", sequence: 1 }),
        ),
      "duplicate_sequence",
    );
  });

  it("rejects non-contiguous event sequences", async () => {
    const ledger = new InMemorySemanticLedger();
    await ledger.appendAcceptedEvent(startedEvent());

    await expectLedgerError(
      () =>
        ledger.appendAcceptedEvent(
          proposalEvent({ eventId: "evt_003", sequence: 3 }),
        ),
      "non_contiguous_sequence",
    );
  });

  it("rejects events whose causation does not point at earlier accepted events", async () => {
    const ledger = new InMemorySemanticLedger();
    await ledger.appendAcceptedEvent(startedEvent());

    await expectLedgerError(
      () =>
        ledger.appendAcceptedEvent(
          proposalEvent({
            eventId: "evt_bad_causation",
            sequence: 2,
            causationId: "evt_missing",
          }),
        ),
      "invalid_causation_id",
    );
  });

  it("rejects payload hash mismatches", async () => {
    const ledger = new InMemorySemanticLedger();

    await expectLedgerError(
      () =>
        ledger.appendAcceptedEvent({
          ...startedEvent(),
          payloadHash: "sha256:not-the-payload",
        }),
      "payload_hash_mismatch",
    );
  });

  it("rejects appending an event to the wrong run stream", async () => {
    const ledger = new InMemorySemanticLedger();

    await expectLedgerError(
      () => ledger.appendAcceptedEventToRun(otherRunId, startedEvent()),
      "run_id_mismatch",
    );
  });

  it("queries events in deterministic sequence order", async () => {
    const ledger = new InMemorySemanticLedger({
      initialEvents: [startedEvent(), proposalEvent({ sequence: 2 })],
    });

    const queried = await ledger.readRunEvents(runId);

    expect(queried.map((event) => event.eventId)).toEqual([
      "evt_001",
      "evt_002",
    ]);
    await expect(ledger.getRunEvent(runId, "evt_002")).resolves.toMatchObject({
      eventId: "evt_002",
      sequence: 2,
    });
  });

  it("returns clones so callers cannot mutate accepted history", async () => {
    const ledger = new InMemorySemanticLedger();
    await ledger.appendAcceptedEvent(startedEvent());

    const firstRead = await ledger.readRunEvents(runId);
    const mutableEvent = firstRead[0];
    if (mutableEvent === undefined) {
      throw new Error("Expected a returned event.");
    }

    mutableEvent.payload = { runId: "mutated_by_projection" };
    mutableEvent.payloadHash = hashRunEventPayload(mutableEvent.payload);

    const secondRead = await ledger.readRunEvents(runId);
    expect(secondRead[0]?.payload).toEqual({
      runId,
      profile: "standard",
    });
  });

  it("fails closed when projection-like objects try to masquerade as truth", async () => {
    const ledger = new InMemorySemanticLedger();
    const projectionSnapshot = {
      runId,
      status: "released",
      approvedClaimIds: ["claim_001"],
    } as unknown as RunEvent;

    await expectLedgerError(
      () => ledger.appendAcceptedEvent(projectionSnapshot),
      "empty_event_id",
    );
  });

  it("validates persisted streams without accepting reordered or cross-run events", () => {
    const event1 = startedEvent();
    const event2 = proposalEvent({ sequence: 2 });

    expect(validateOrderedRunEvents([event1, event2], runId)).toMatchObject([
      { eventId: "evt_001", sequence: 1 },
      { eventId: "evt_002", sequence: 2 },
    ]);

    expectLedgerErrorSync(
      () => validateOrderedRunEvents([event2, event1], runId),
      "non_contiguous_sequence",
    );
    expectLedgerErrorSync(
      () =>
        validateOrderedRunEvents(
          [
            event1,
            proposalEvent({
              eventId: "evt_bad_causation",
              sequence: 2,
              causationId: "evt_missing",
            }),
          ],
          runId,
        ),
      "invalid_causation_id",
    );
    expectLedgerErrorSync(
      () =>
        validateOrderedRunEvents(
          [
            event1,
            {
              ...proposalEvent({ sequence: 2 }),
              runId: otherRunId,
            },
          ],
          runId,
        ),
      "run_id_mismatch",
    );
  });
});

function startedEvent(): RunEvent<"RunStarted"> {
  const payload = { runId, profile: "standard" };
  return {
    eventId: "evt_001",
    runId,
    sequence: 1,
    type: "RunStarted",
    payload,
    payloadHash: hashRunEventPayload(payload),
    causationId: null,
    correlationId: null,
    occurredAt,
  };
}

interface ProposalEventOptions {
  readonly eventId?: string;
  readonly sequence: number;
  readonly causationId?: string;
}

function proposalEvent(
  options: ProposalEventOptions,
): RunEvent<"ProposalReceived"> {
  const payload = {
    proposal: {
      kind: "final_candidate" as const,
      candidateId: "candidate_001",
      runId,
      claims: [],
    },
  };
  return {
    eventId: options.eventId ?? "evt_002",
    runId,
    sequence: options.sequence,
    type: "ProposalReceived",
    payload,
    payloadHash: hashRunEventPayload(payload),
    causationId: options.causationId ?? "evt_001",
    correlationId: "corr_phase_20",
    occurredAt,
  };
}

async function expectLedgerError(
  operation: () => Promise<unknown>,
  code: LedgerError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    return;
  }

  throw new Error(`Expected LedgerError with code ${code}.`);
}

function expectLedgerErrorSync(
  operation: () => unknown,
  code: LedgerError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    return;
  }

  throw new Error(`Expected LedgerError with code ${code}.`);
}
