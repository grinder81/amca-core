import { hashRunEventPayload, InMemoryRunKernel } from "@amca/kernel";
import type {
  MutationCommandRequest,
  MutationOperation,
  RunEvent,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

const startedAt = "2026-05-25T13:00:00.000Z";
const requestedAt = "2026-05-25T13:01:00.000Z";

describe("mission P1/P6 mutation kernel", () => {
  it("mutation-direct-state-write-blocked", () => {
    const runId = "mission_mutation_direct_write_blocked";
    const kernel = startedKernel(runId);
    const command = mutationCommand(runId, "cmd_direct", "mut_direct");

    expect(() => kernel.commitMutation(command)).toThrow(
      expect.objectContaining({ code: "mutation_proposal_not_found" }),
    );
    expect(kernel.stateRevision("state://mission")).toBe(0);
    expect(eventTypes(kernel)).not.toContain("MutationCommitted");
  });

  it("stale-revision-blocked", () => {
    const runId = "mission_mutation_stale_revision";
    const kernel = startedKernel(runId);
    const first = mutationCommand(runId, "cmd_first", "mut_first");
    const stale = mutationCommand(runId, "cmd_stale", "mut_stale", {
      kind: "set",
      path: "/enabled",
      value: false,
    });

    kernel.submitMutationCommand(first);
    kernel.commitMutation(first);
    kernel.submitMutationCommand(stale);

    expect(() => kernel.commitMutation(stale)).toThrow(
      expect.objectContaining({ code: "mutation_stale_revision" }),
    );
    expect(kernel.stateRevision("state://mission")).toBe(1);
  });

  it("mutation-without-provenance-blocked", () => {
    const runId = "mission_mutation_without_provenance";
    const kernel = startedKernel(runId);
    const malformed: Partial<MutationCommandRequest> = {
      ...mutationCommand(runId, "cmd_no_provenance", "mut_no_provenance"),
    };
    delete malformed.provenance;

    expect(() =>
      kernel.submitMutationCommand(
        malformed as unknown as MutationCommandRequest,
      ),
    ).toThrow(/MutationCommandRequest validation failed/u);
    expect(eventTypes(kernel)).toEqual(["RunStarted"]);
  });

  it("mutation-committed-replayable", () => {
    const runId = "mission_mutation_committed_replayable";
    const kernel = startedKernel(runId);
    const command = mutationCommand(runId, "cmd_replay", "mut_replay");

    const proposal = kernel.submitMutationCommand(command, {
      eventId: "evt_mutation_mission_proposed",
    });
    const committed = kernel.commitMutation(command, {
      eventId: "evt_mutation_mission_committed",
      causationId: proposal.eventId,
    });

    expect(committed.payload.mutation).toMatchObject({
      stateRef: "state://mission",
      previousRevision: 0,
      newRevision: 1,
    });
    expect(kernel.replay().map((event) => event.type)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "MutationCommitted",
    ]);
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

function mutationCommand(
  runId: string,
  commandId: string,
  mutationId: string,
  operation: MutationOperation = { kind: "set", path: "/enabled", value: true },
): MutationCommandRequest {
  const commandWithoutHash = {
    kind: "mutation_command_request",
    commandId,
    mutationId,
    runId,
    target: {
      stateRef: "state://mission",
    },
    operation,
    precondition: {
      expectedRevision: 0,
    },
    provenance: {
      kind: "system_policy",
      sourceEventId: "evt_policy_mission",
      reason: "Mission mutation fixture.",
    },
    requestedAt,
  } as const;

  return {
    ...commandWithoutHash,
    payloadHash: hashRunEventPayload(commandWithoutHash),
  };
}

function eventTypes(kernel: InMemoryRunKernel): RunEvent["type"][] {
  return kernel.events().map((event) => event.type);
}
