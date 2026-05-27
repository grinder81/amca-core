import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LedgerError, hashRunEventPayload } from "@amca/ledger";
import type { RunEvent, Sha256Hash } from "@amca/protocol";

import {
  LocalJsonlSemanticLedger,
  localRunEventsPath,
} from "./local-jsonl-ledger.js";

const runId = "run_local_ledger";
const occurredAt = "2026-05-24T12:00:00.000Z";
const badHash =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" satisfies Sha256Hash;

describe("LocalJsonlSemanticLedger", () => {
  it("writes and reads accepted events through events.jsonl", async () => {
    const rootDir = await makeTempStore();
    const ledger = new LocalJsonlSemanticLedger({ rootDir });

    await ledger.appendAcceptedEvent(startedEvent());
    await ledger.appendAcceptedEvent(proposalEvent());

    await expect(
      readFile(localRunEventsPath(rootDir, runId), "utf8"),
    ).resolves.toContain('"RunStarted"');
    await expect(ledger.readRunEvents(runId)).resolves.toMatchObject([
      { eventId: "evt_001", sequence: 1 },
      { eventId: "evt_002", sequence: 2 },
    ]);

    await rm(rootDir, { force: true, recursive: true });
  });

  it("detects manually mutated payloads", async () => {
    const rootDir = await makeTempStore();
    const ledger = new LocalJsonlSemanticLedger({ rootDir });
    await ledger.appendAcceptedEvent(startedEvent());

    const mutated = {
      ...startedEvent(),
      payload: { runId, profile: "mutated" },
    };
    await writeFile(
      localRunEventsPath(rootDir, runId),
      `${JSON.stringify(mutated)}\n`,
    );

    await expectLedgerError(
      () => ledger.readRunEvents(runId),
      "payload_hash_mismatch",
    );

    await rm(rootDir, { force: true, recursive: true });
  });

  it("detects missing events in the sequence", async () => {
    const rootDir = await makeTempStore();
    const ledger = new LocalJsonlSemanticLedger({ rootDir });
    await ledger.appendAcceptedEvent(startedEvent());
    await writeFile(
      localRunEventsPath(rootDir, runId),
      `${JSON.stringify(proposalEvent())}\n`,
    );

    await expectLedgerError(
      () => ledger.readRunEvents(runId),
      "non_contiguous_sequence",
    );

    await rm(rootDir, { force: true, recursive: true });
  });

  it("detects reordered events", async () => {
    const rootDir = await makeTempStore();
    const ledger = new LocalJsonlSemanticLedger({ rootDir });
    await ledger.appendAcceptedEvent(startedEvent());
    await ledger.appendAcceptedEvent(proposalEvent());
    await writeFile(
      localRunEventsPath(rootDir, runId),
      `${JSON.stringify(proposalEvent())}\n${JSON.stringify(startedEvent())}\n`,
    );

    await expectLedgerError(
      () => ledger.readRunEvents(runId),
      "non_contiguous_sequence",
    );

    await rm(rootDir, { force: true, recursive: true });
  });

  it("rejects cross-run events in a run stream", async () => {
    const rootDir = await makeTempStore();
    const ledger = new LocalJsonlSemanticLedger({ rootDir });
    await ledger.appendAcceptedEvent(startedEvent());
    await writeFile(
      localRunEventsPath(rootDir, runId),
      `${JSON.stringify(startedEvent())}\n${JSON.stringify({
        ...proposalEvent(),
        runId: "run_other",
      })}\n`,
    );

    await expectLedgerError(
      () => ledger.readRunEvents(runId),
      "run_id_mismatch",
    );

    await rm(rootDir, { force: true, recursive: true });
  });

  it("rejects append attempts after local tampering is detected", async () => {
    const rootDir = await makeTempStore();
    const ledger = new LocalJsonlSemanticLedger({ rootDir });
    await ledger.appendAcceptedEvent(startedEvent());
    await writeFile(
      localRunEventsPath(rootDir, runId),
      `${JSON.stringify({ ...startedEvent(), payloadHash: badHash })}\n`,
    );

    await expectLedgerError(
      () => ledger.appendAcceptedEvent(proposalEvent()),
      "payload_hash_mismatch",
    );

    await rm(rootDir, { force: true, recursive: true });
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

function proposalEvent(): RunEvent<"ProposalReceived"> {
  const payload = {
    proposal: {
      kind: "tool_command_request" as const,
      commandId: "cmd_local_ledger",
      runId,
      capabilityId: "shell.run_tests",
      toolId: "pnpm.test",
      args: {},
      sideEffectClass: "compute" as const,
    },
  };
  return {
    eventId: "evt_002",
    runId,
    sequence: 2,
    type: "ProposalReceived",
    payload,
    payloadHash: hashRunEventPayload(payload),
    causationId: "evt_001",
    correlationId: "corr_local_ledger",
    occurredAt,
  };
}

async function makeTempStore(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "amca-local-ledger-"));
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
