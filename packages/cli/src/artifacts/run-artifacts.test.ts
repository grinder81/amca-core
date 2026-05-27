import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { testsPassedReleasedScenario } from "@amca/testing";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "@amca/protocol";

import {
  RunArtifactError,
  buildRunArtifactsFromEvents,
  readRunArtifacts,
  writeRunArtifacts,
} from "./run-artifacts.js";

describe("local run artifacts", () => {
  it("writes the governed run artifact set deterministically", async () => {
    const store = await makeTempStore();
    const artifacts = releasedScenarioArtifacts();

    const runDir = await writeRunArtifacts(store, artifacts);

    await expect(
      readFile(path.join(runDir, "events.jsonl"), "utf8"),
    ).resolves.toContain('"sequence":1');
    await expect(
      readFile(path.join(runDir, "effect-requests.json"), "utf8"),
    ).resolves.toContain("effect_tests_passed_released");
    await expect(
      readFile(path.join(runDir, "receipts.json"), "utf8"),
    ).resolves.toContain("receipt_tests_passed_released");
    await expect(
      readFile(path.join(runDir, "proof.json"), "utf8"),
    ).resolves.toContain("proof_tests_passed_released");
    await expect(
      readFile(path.join(runDir, "mismatches.json"), "utf8"),
    ).resolves.toBe("[]\n");
    await expect(
      readFile(path.join(runDir, "release-decision.json"), "utf8"),
    ).resolves.toContain('"status": "released"');
    await expect(
      readFile(path.join(runDir, "final-candidate.json"), "utf8"),
    ).resolves.toContain("candidate_tests_passed_released");
    await expect(
      readFile(path.join(runDir, "summary.md"), "utf8"),
    ).resolves.toContain("- status: released");

    const eventLines = (
      await readFile(path.join(runDir, "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(
      eventLines.map(
        (line) => (JSON.parse(line) as { sequence: number }).sequence,
      ),
    ).toEqual(eventLines.map((_, index) => index + 1));

    await rm(store, { force: true, recursive: true });
  });

  it("reads artifacts only when critical files are valid and event-backed", async () => {
    const store = await makeTempStore();
    const artifacts = releasedScenarioArtifacts();

    await writeRunArtifacts(store, artifacts);
    const readBack = await readRunArtifacts(store, artifacts.runId);

    expect(readBack.releaseDecision.status).toBe("released");
    expect(readBack.finalCandidate.candidateId).toBe(
      "candidate_tests_passed_released",
    );
    expect(readBack.effectRequests).toHaveLength(1);
    expect(readBack.receipts).toHaveLength(1);

    await rm(store, { force: true, recursive: true });
  });

  it("fails closed when a critical artifact file is missing", async () => {
    const store = await makeTempStore();
    const artifacts = releasedScenarioArtifacts();
    const runDir = await writeRunArtifacts(store, artifacts);
    await unlink(path.join(runDir, "release-decision.json"));

    await expect(readRunArtifacts(store, artifacts.runId)).rejects.toThrow(
      RunArtifactError,
    );
    await expect(readRunArtifacts(store, artifacts.runId)).rejects.toThrow(
      /release-decision\.json/u,
    );

    await rm(store, { force: true, recursive: true });
  });

  it("fails closed when sidecar artifacts do not match admitted events", async () => {
    const store = await makeTempStore();
    const artifacts = releasedScenarioArtifacts();
    const runDir = await writeRunArtifacts(store, artifacts);
    await writeFile(path.join(runDir, "receipts.json"), "[]\n");

    await expect(readRunArtifacts(store, artifacts.runId)).rejects.toThrow(
      /receipts artifact does not match the admitted run events/u,
    );

    await rm(store, { force: true, recursive: true });
  });

  it("fails closed when events are malformed", async () => {
    const store = await makeTempStore();
    const artifacts = releasedScenarioArtifacts();
    const runDir = await writeRunArtifacts(store, artifacts);
    await writeFile(path.join(runDir, "events.jsonl"), '{"bad":true}\n');

    await expect(readRunArtifacts(store, artifacts.runId)).rejects.toThrow(
      /valid RunEvent/u,
    );

    await rm(store, { force: true, recursive: true });
  });

  it("fails closed when event payloads are tampered even if sidecars still claim release", async () => {
    const store = await makeTempStore();
    const artifacts = releasedScenarioArtifacts();
    const runDir = await writeRunArtifacts(store, artifacts);
    const events = artifacts.events.map((event, index) =>
      index === 1 ? tamperProposalEvent(event) : event,
    );
    await writeFile(
      path.join(runDir, "events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(readRunArtifacts(store, artifacts.runId)).rejects.toThrow(
      /payloadHash does not match/u,
    );

    await rm(store, { force: true, recursive: true });
  });

  it("fails closed when event sequence is missing or reordered", async () => {
    const store = await makeTempStore();
    const artifacts = releasedScenarioArtifacts();
    const runDir = await writeRunArtifacts(store, artifacts);
    const withoutFirstEvent = artifacts.events.slice(1);
    await writeFile(
      path.join(runDir, "events.jsonl"),
      `${withoutFirstEvent.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(readRunArtifacts(store, artifacts.runId)).rejects.toThrow(
      /expected sequence 1/u,
    );

    await writeFile(
      path.join(runDir, "events.jsonl"),
      `${[
        artifacts.events[1],
        artifacts.events[0],
        ...artifacts.events.slice(2),
      ]
        .filter((event) => event !== undefined)
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );

    await expect(readRunArtifacts(store, artifacts.runId)).rejects.toThrow(
      /expected sequence 1/u,
    );

    await rm(store, { force: true, recursive: true });
  });
});

function releasedScenarioArtifacts() {
  return buildRunArtifactsFromEvents({
    runId: testsPassedReleasedScenario.given.finalCandidate.runId,
    scenarioId: testsPassedReleasedScenario.id,
    events: [
      ...testsPassedReleasedScenario.given.runEvents,
      ...testsPassedReleasedScenario.expected.emittedEvents,
    ],
  });
}

function tamperProposalEvent(event: RunEvent): RunEvent {
  if (event.type !== "ProposalReceived") {
    return event;
  }

  const proposalEvent = event as RunEvent<"ProposalReceived">;
  if (proposalEvent.payload.proposal.kind !== "tool_command_request") {
    return event;
  }

  return {
    ...proposalEvent,
    payload: {
      proposal: {
        ...proposalEvent.payload.proposal,
        toolId: "forged_projection_truth",
      },
    },
  };
}

async function makeTempStore(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "amca-run-artifacts-"));
}
