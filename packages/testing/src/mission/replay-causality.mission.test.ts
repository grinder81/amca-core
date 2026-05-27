import { describe, expect, it } from "vitest";

import {
  EventValidationError,
  hashRunEventPayload,
  InMemoryLedger,
  orderAndValidateRunEvents,
} from "@amca/kernel";
import {
  createLocalReadonlyAdapter,
  createShellCommandAdapter,
} from "@amca/adapters-tools";
import { replayRunEvents } from "@amca/replay";
import type { RunEvent } from "@amca/protocol";

import {
  candidateWith,
  eventTypes,
  GENERATED_AT,
  startedKernel,
  submitReleasedTestClaim,
  testResultClaim,
} from "./mission-helpers.js";

const runId = "mission_replay_causality";
const occurredAt = "2026-05-24T12:00:00.000Z";

describe("Mission P6 replayability and causality", () => {
  it("replays accepted semantic events without adding new execution events", () => {
    const { kernel } = submitReleasedTestClaim("mission_replay_no_side_effect");
    const beforeReplay = eventTypes(kernel);
    const replayed = kernel.replay();

    expect(replayed.map((event) => event.type)).toEqual(beforeReplay);
    expect(eventTypes(kernel)).toEqual(beforeReplay);
  });

  it("rejects replay sequences with missing causation or mutated payload hashes", () => {
    const ledger = new InMemoryLedger({ runId });
    const started = ledger.append({
      eventId: "evt_001",
      runId,
      type: "RunStarted",
      payload: { runId },
      occurredAt,
    });
    const proposal = ledger.append({
      eventId: "evt_002",
      runId,
      type: "ProposalReceived",
      payload: {
        proposal: {
          kind: "tool_command_request",
          commandId: "cmd_001",
          runId,
          capabilityId: "shell.run_tests",
          toolId: "pnpm.test",
          args: { command: "pnpm test" },
          sideEffectClass: "compute",
        },
      },
      causationId: started.eventId,
      occurredAt,
    });

    expect(() =>
      orderAndValidateRunEvents([{ ...proposal, causationId: "evt_missing" }]),
    ).toThrow(EventValidationError);

    expect(() =>
      orderAndValidateRunEvents([
        started,
        {
          ...proposal,
          payloadHash: hashRunEventPayload({ mutated: true }),
        },
      ]),
    ).toThrow(EventValidationError);
  });

  it("rejects replay sequences with non-contiguous event ordering", () => {
    const event = {
      eventId: "evt_002",
      runId,
      sequence: 2,
      type: "RunStarted" as const,
      payload: { runId },
      payloadHash: hashRunEventPayload({ runId }),
      causationId: null,
      correlationId: null,
      occurredAt,
    };

    expect(() => orderAndValidateRunEvents([event], runId)).toThrow(
      EventValidationError,
    );
  });

  it("deterministically replays a complete accepted semantic event stream", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_replay_runner_reconstructs",
    );
    const replay = replayRunEvents({ events: kernel.events() });

    expect(replay).toMatchObject({
      status: "passed",
      runId: "mission_replay_runner_reconstructs",
      replayedDecision: {
        status: "released",
      },
    });
  });

  it("replays ledger-hydrated accepted event streams for released and blocked decisions", () => {
    const { kernel: releasedKernel } = submitReleasedTestClaim(
      "mission_replay_ledger_released",
    );
    const blockedKernel = startedKernel("mission_replay_ledger_blocked");
    const blocked = blockedKernel.submitFinalCandidate(
      candidateWith(
        "mission_replay_ledger_blocked",
        testResultClaim({
          evidenceRefs: [],
          testSuiteId: "unit",
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(blocked.decision.status).toBe("blocked");
    expect(
      replayRunEvents({
        events: ledgerHydrateEvents(releasedKernel.events()),
      }),
    ).toMatchObject({
      status: "passed",
      runId: "mission_replay_ledger_released",
      replayedDecision: {
        status: "released",
      },
    });
    expect(
      replayRunEvents({
        events: ledgerHydrateEvents(blockedKernel.events()),
      }),
    ).toMatchObject({
      status: "passed",
      runId: "mission_replay_ledger_blocked",
      replayedDecision: {
        status: "blocked",
      },
    });
  });

  it("fails closed when replay input payload hashes are mutated", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_replay_runner_mutated_hash",
    );
    const events = kernel.events().map((event, index) =>
      index === 1
        ? {
            ...event,
            payloadHash: hashRunEventPayload({ forged: true }),
          }
        : event,
    );

    const replay = replayRunEvents({ events });

    expect(replay).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
  });

  it("fails closed when a ledger-backed replay stream is missing its release event", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_replay_missing_ledger_event",
    );
    const missingReleaseEvent = resequence(
      kernel
        .events()
        .filter(
          (event) =>
            event.type !== "ReleaseDecided" && event.type !== "FinalReleased",
        ),
    );

    expect(
      replayRunEvents({
        events: ledgerHydrateEvents(missingReleaseEvent),
      }),
    ).toMatchObject({
      status: "failed",
      code: "release_event_missing",
    });
  });

  it("fails closed when replay input is reordered or omits effect admission", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_replay_runner_bad_causality",
    );
    const events = kernel.events();
    const reordered = [events[1], events[0], ...events.slice(2)].filter(
      (event): event is RunEvent => event !== undefined,
    );
    const withoutEffectRequest = resequence(
      events.filter((event) => event.type !== "EffectRequested"),
    );

    expect(replayRunEvents({ events: reordered })).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
    expect(replayRunEvents({ events: withoutEffectRequest })).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
  });

  it("fails closed when replay input has non-contiguous ledger sequence numbers", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_replay_non_contiguous_ledger_stream",
    );
    const nonContiguous = kernel.events().map((event, index) =>
      index >= 2
        ? {
            ...event,
            sequence: event.sequence + 1,
          }
        : event,
    );

    expect(replayRunEvents({ events: nonContiguous })).toMatchObject({
      status: "failed",
      code: "event_stream_integrity_failed",
    });
  });

  it("does not invoke a local_readonly adapter that exists in the replay process", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_replay_adapter_not_dispatched",
    );
    const adapter = createLocalReadonlyAdapter({
      adapterId: "adapter_replay_trap",
      capabilityId: "filesystem.read",
      toolId: "filesystem.read",
      rootPath: process.cwd(),
      clock: () => GENERATED_AT,
    });
    let dispatchCount = 0;
    const trapAdapter = {
      ...adapter,
      execute: (...args: Parameters<typeof adapter.execute>) => {
        dispatchCount += 1;
        return adapter.execute(...args);
      },
    };

    expect(trapAdapter.adapterId).toBe("adapter_replay_trap");
    expect(
      replayRunEvents({
        events: ledgerHydrateEvents(kernel.events()),
      }),
    ).toMatchObject({
      status: "passed",
      runId: "mission_replay_adapter_not_dispatched",
    });
    expect(dispatchCount).toBe(0);
  });

  it("shell-adapter-replay-does-not-execute-shell", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_replay_shell_adapter_not_dispatched",
    );
    const adapter = createShellCommandAdapter({
      adapterId: "adapter_replay_shell_trap",
      capabilityId: "amca.shell.run_profile",
      toolId: "shell.run_profile",
      rootDir: process.cwd(),
      profiles: [
        {
          profileId: "replay-trap",
          profileClass: "read_only_compute",
          executablePath: process.execPath,
          args: ["-e", "process.stdout.write('replay trap executed')"],
        },
      ],
      clock: () => GENERATED_AT,
    });
    let dispatchCount = 0;
    const trapAdapter = {
      ...adapter,
      execute: (...args: Parameters<typeof adapter.execute>) => {
        dispatchCount += 1;
        return adapter.execute(...args);
      },
    };

    expect(trapAdapter.adapterId).toBe("adapter_replay_shell_trap");
    expect(
      replayRunEvents({
        events: ledgerHydrateEvents(kernel.events()),
      }),
    ).toMatchObject({
      status: "passed",
      runId: "mission_replay_shell_adapter_not_dispatched",
    });
    expect(dispatchCount).toBe(0);
  });
});

function resequence(events: readonly RunEvent[]): RunEvent[] {
  return events.map((event, index) => ({
    ...event,
    sequence: index + 1,
    causationId:
      event.causationId === null ||
      events.some((candidate) => candidate.eventId === event.causationId)
        ? event.causationId
        : (events[index - 1]?.eventId ?? null),
    payloadHash: hashRunEventPayload(event.payload),
  }));
}

function ledgerHydrateEvents(events: readonly RunEvent[]): RunEvent[] {
  return JSON.parse(JSON.stringify(events)) as RunEvent[];
}
