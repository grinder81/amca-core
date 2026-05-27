import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hashRunEventPayload } from "@amca/kernel";
import {
  LocalJsonlSemanticLedger,
  localRunEventsPath,
} from "@amca/ledger-local";
import type { RunEvent } from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { submitReleasedTestClaim } from "./mission-helpers.js";

describe("Mission local durable ledger adapter litmus", () => {
  it("reads accepted local semantic events through the ledger boundary", async () => {
    const rootDir = await makeStore();
    const { kernel } = submitReleasedTestClaim("mission_local_ledger_reads");
    const ledger = new LocalJsonlSemanticLedger({ rootDir });

    for (const event of kernel.events()) {
      await ledger.appendAcceptedEvent(event);
    }

    await expect(
      ledger.readRunEvents("mission_local_ledger_reads"),
    ).resolves.toHaveLength(kernel.events().length);
    await expect(
      ledger.verifyRunIntegrity("mission_local_ledger_reads"),
    ).resolves.toBeUndefined();

    await rm(rootDir, { force: true, recursive: true });
  });

  it("fails closed when local accepted events are tampered", async () => {
    const rootDir = await makeStore();
    const { kernel } = submitReleasedTestClaim("mission_local_ledger_tamper");
    const ledger = new LocalJsonlSemanticLedger({ rootDir });

    for (const event of kernel.events()) {
      await ledger.appendAcceptedEvent(event);
    }

    const events = kernel
      .events()
      .map((event, index) => (index === 1 ? tamperEventPayload(event) : event));
    await writeFile(
      localRunEventsPath(rootDir, "mission_local_ledger_tamper"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(
      ledger.readRunEvents("mission_local_ledger_tamper"),
    ).rejects.toThrow(/payloadHash does not match/u);

    await rm(rootDir, { force: true, recursive: true });
  });

  it("fails closed when derived artifacts exist without accepted events", async () => {
    const rootDir = await makeStore();
    const runId = "mission_local_ledger_no_event_truth";
    const runDir = path.join(rootDir, runId);
    const ledger = new LocalJsonlSemanticLedger({ rootDir });

    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "release-decision.json"), "{}\n");

    await expect(ledger.readRunEvents(runId)).rejects.toThrow(
      /does not exist/u,
    );

    await rm(rootDir, { force: true, recursive: true });
  });
});

async function makeStore(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "amca-local-ledger-mission-"));
}

function tamperEventPayload(event: RunEvent): RunEvent {
  if (event.type === "EffectRequested") {
    const effectRequestedEvent = event as RunEvent<"EffectRequested">;
    return {
      ...effectRequestedEvent,
      payload: {
        effectRequest: {
          ...effectRequestedEvent.payload.effectRequest,
          toolId: "forged.tool",
        },
      },
      payloadHash: hashRunEventPayload(effectRequestedEvent.payload),
    };
  }

  throw new Error(`Expected EffectRequested event, received ${event.type}.`);
}
