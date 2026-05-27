import { describe, expect, it } from "vitest";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LocalRunHarness } from "@amca/harness";
import { hashRunEventPayload } from "@amca/kernel";
import type {
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  ExternalStateObservation,
  ExternalStateObservationCandidate,
  JsonObject,
  Mismatch,
  PendingEvidenceRef,
  ReceiptCandidate,
  RunEvent,
  RunEventType,
  ToolCommandRequest,
} from "@amca/protocol";

import {
  candidateWith,
  currentStateClaim,
  eventTypes,
  expectRunKernelError,
  FRESH_OBSERVED_AT,
  FUTURE_OBSERVED_AT,
  observationEvidenceRef,
  pullRequestStateObservation,
  STALE_OBSERVED_AT,
  STARTED_AT,
  startedKernel,
} from "./mission-helpers.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const now = "2026-05-24T12:00:00.000Z";
const reevaluatedAt = "2026-05-24T12:00:15.000Z";

describe("Mission governed external-state observation admission", () => {
  it("releases a current-state claim through the broker/harness path only after observation admission", async () => {
    const fixture = observationFixture({
      runId: "mission_observation_harness_admitted",
    });
    const harness = startedObservationHarness(fixture);

    await harness.dispatchToolCommand(fixture.command);

    const observationEvent = singleObservationEvent(harness);
    const admittedEvidenceRef = singleEvidenceRef(
      observationEvent.payload.observation,
    );
    const result = harness.submitFinalCandidate(
      candidateWith(
        fixture.command.runId,
        currentStateClaim({ evidenceRefs: [admittedEvidenceRef] }),
      ),
      {
        causationId: observationEvent.eventId,
        generatedAt: now,
        occurredAt: now,
      },
    );

    expect(result.decision.status).toBe("released");
    expect(fixture.calls).toHaveLength(1);
    expect(eventTypes(harness.kernel)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ExternalStateObserved",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
  });

  it("does not treat adapter-observed external state as proof until the kernel admits it", async () => {
    const fixture = observationFixture({
      runId: "mission_observation_adapter_unadmitted",
    });
    const brokerResult = await fixture.broker.dispatch(fixture.command);
    const kernel = startedKernel(fixture.command.runId);
    const proposalEvent = kernel.submitToolCommand(fixture.command);
    const effectRequestEvent = kernel.recordEffectRequest(
      brokerResult.effectRequest,
      {
        causationId: proposalEvent.eventId,
        occurredAt: brokerResult.effectRequest.requestedAt,
      },
    );
    kernel.recordEffectReceipt(fixture.receipt, {
      eventId: fixture.receiptEventId,
      causationId: effectRequestEvent.eventId,
      occurredAt: fixture.receipt.observedAt,
    });

    const result = kernel.submitFinalCandidate(
      candidateWith(
        fixture.command.runId,
        currentStateClaim({ evidenceRefs: [fixture.observationEvidenceRef] }),
      ),
      {
        generatedAt: now,
        occurredAt: now,
      },
    );

    expect(fixture.calls).toHaveLength(1);
    expect(brokerResult.externalStateObservationCandidate).toEqual(
      fixture.observationCandidate,
    );
    expect(
      brokerResult.externalStateObservationCandidate.evidence[0],
    ).not.toHaveProperty("sourceEventId");
    expect(kernel.externalStateObservations()).toEqual([]);
    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unsupported_claim",
        blocking: true,
      }),
    );
    expect(eventTypes(kernel)).not.toContain("ExternalStateObserved");
    expect(eventTypes(kernel)).not.toContain("FinalReleased");
  });

  it("rejects direct kernel admission when observation evidence names a fake source event", () => {
    const runId = "mission_observation_fake_source_event";
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_mission_observation_fake_source_event",
      hashRunEventPayload(observedState),
      {
        sourceEventId: "evt_forged_external_observation",
      },
    );
    const kernel = startedKernel(runId);

    expectRunKernelError(
      () =>
        kernel.recordExternalStateObservation(
          pullRequestStateObservation(runId, {
            evidence: [evidenceRef],
            observedState,
          }),
          {
            eventId: "evt_real_external_observation",
            occurredAt: FRESH_OBSERVED_AT,
          },
        ),
      "evidence_source_event_mismatch",
    );
    expect(eventTypes(kernel)).toEqual(["RunStarted"]);
  });

  it("keeps stale, future, wrong-value, and wrong-subject observations blocked after admission", () => {
    expectAdmittedObservationBlocked("mission_observation_stale_blocked", {
      observedAt: STALE_OBSERVED_AT,
      observedState: { state: "open" },
      mismatchType: "stale_external_state",
    });
    expectAdmittedObservationBlocked("mission_observation_future_blocked", {
      observedAt: FUTURE_OBSERVED_AT,
      observedState: { state: "open" },
      mismatchType: "stale_external_state",
    });
    expectAdmittedObservationBlocked(
      "mission_observation_wrong_value_blocked",
      {
        observedAt: FRESH_OBSERVED_AT,
        observedState: { state: "closed" },
        mismatchType: "unsupported_claim",
      },
    );
    expectAdmittedObservationBlocked(
      "mission_observation_wrong_subject_blocked",
      {
        observedAt: FRESH_OBSERVED_AT,
        observedState: { state: "open" },
        subjectId: "456",
        mismatchType: "unsupported_claim",
      },
    );
  });

  it("replays and re-evaluates admitted observations without redispatching observation adapters", async () => {
    const fixture = observationFixture({
      runId: "mission_observation_replay_no_redispatch",
    });
    const harness = startedObservationHarness(fixture);

    await harness.dispatchToolCommand(fixture.command);
    const observationEvent = singleObservationEvent(harness);
    const admittedEvidenceRef = singleEvidenceRef(
      observationEvent.payload.observation,
    );
    const finalCandidate = candidateWith(
      fixture.command.runId,
      currentStateClaim({ evidenceRefs: [admittedEvidenceRef] }),
    );

    const released = harness.submitFinalCandidate(finalCandidate, {
      causationId: observationEvent.eventId,
      generatedAt: now,
      occurredAt: now,
    });
    const beforeReplay = eventTypes(harness.kernel);

    expect(released.decision.status).toBe("released");
    expect(harness.replay().events.map((event) => event.type)).toEqual(
      beforeReplay,
    );

    const reevaluated = harness.reevaluateFinalCandidate(finalCandidate, {
      generatedAt: reevaluatedAt,
      occurredAt: reevaluatedAt,
    });

    expect(reevaluated.decision.status).toBe("released");
    expect(fixture.calls).toHaveLength(1);
    expect(countEvents(harness.kernel, "ExternalStateObserved")).toBe(1);
  });

  it("keeps harness and CLI observation paths free of real execution hooks", () => {
    const forbiddenTokens = [
      "child_process",
      "exec(",
      "execFile(",
      "spawn(",
      "fetch(",
      "http.request",
      "https.request",
      "Octokit",
    ];

    for (const sourceFile of sourceFiles([
      path.join(repoRoot, "packages/harness/src"),
      path.join(repoRoot, "packages/cli/src"),
    ])) {
      const source = readFileSync(sourceFile, "utf8");
      if (!source.includes("observation")) {
        continue;
      }

      for (const token of forbiddenTokens) {
        expect(source, `${sourceFile} must not contain ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});

interface ObservationFixture {
  readonly broker: ObservationBroker;
  readonly calls: ToolCommandRequest[];
  readonly command: ToolCommandRequest;
  readonly effectRequest: EffectRequest;
  readonly observation: ExternalStateObservation;
  readonly observationCandidate: ExternalStateObservationCandidate;
  readonly observationEvidenceRef: EvidenceRef;
  readonly receipt: EffectReceipt;
  readonly receiptEventId: string;
}

interface ObservationDispatchResult {
  readonly status: "dispatched";
  readonly effectRequest: EffectRequest;
  readonly receiptCandidate: ReceiptCandidate;
  readonly externalStateObservationCandidate: ExternalStateObservationCandidate;
}

interface ObservationBroker {
  dispatch(command: ToolCommandRequest): Promise<ObservationDispatchResult>;
}

function startedObservationHarness(
  fixture: ObservationFixture,
): LocalRunHarness {
  const harness = new LocalRunHarness({
    runId: fixture.command.runId,
    broker: fixture.broker,
    clock: () => now,
  });
  harness.startRun({
    occurredAt: STARTED_AT,
    profile: "standard",
  });
  return harness;
}

function observationFixture(input: {
  readonly runId: string;
  readonly observedAt?: string;
  readonly observedState?: JsonObject;
  readonly subjectId?: string;
}): ObservationFixture {
  const capabilityId = "mission.observe.pull_request_state";
  const toolId = "mission.observe.pull_request_state";
  const commandId = `cmd_${input.runId}`;
  const effectRequest: EffectRequest = {
    effectId: `effect_${commandId}`,
    commandId,
    runId: input.runId,
    capabilityId,
    toolId,
    args: {
      subjectType: "pull_request",
      subjectId: "123",
      property: "state",
    },
    sideEffectClass: "read",
    requestedAt: now,
  };
  const observedState = input.observedState ?? { state: "open" };
  const observedAt = input.observedAt ?? FRESH_OBSERVED_AT;
  const observationEventId = `evt_${commandId}_external_state_observed`;
  const observationEvidence = observationEvidenceRef(
    `ev_${commandId}_external_state`,
    hashRunEventPayload(observedState),
    {
      sourceEventId: observationEventId,
      observedAt,
    },
  );
  const observation = pullRequestStateObservation(input.runId, {
    evidence: [observationEvidence],
    observedAt,
    observedState,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
  });
  const receiptPayload = {
    observationId: observation.observationId,
    observationType: observation.observationType,
    subjectId: observation.subjectId,
    subjectType: observation.subjectType,
  };
  const receiptEventId = `evt_${commandId}_receipt_recorded`;
  const receipt = observationReceipt({
    effectRequest,
    payload: receiptPayload,
    receiptEventId,
  });
  const receiptCandidate = receiptCandidateFromReceipt(receipt);
  const observationCandidate = observationCandidateFromObservation(observation);
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId,
    runId: input.runId,
    capabilityId,
    toolId,
    args: effectRequest.args,
    sideEffectClass: "read",
  };
  const calls: ToolCommandRequest[] = [];

  return {
    broker: {
      dispatch: (dispatchedCommand) => {
        calls.push(dispatchedCommand);
        return Promise.resolve({
          status: "dispatched",
          effectRequest,
          receiptCandidate,
          externalStateObservationCandidate: observationCandidate,
        });
      },
    },
    calls,
    command,
    effectRequest,
    observation,
    observationCandidate,
    observationEvidenceRef: observationEvidence,
    receipt,
    receiptEventId,
  };
}

function receiptCandidateFromReceipt(receipt: EffectReceipt): ReceiptCandidate {
  return {
    ...receipt,
    evidence: receipt.evidence.map((evidenceRef) =>
      pendingEvidenceRef({
        evidenceId: evidenceRef.evidenceId,
        kind: evidenceRef.kind,
        hash: evidenceRef.hash,
        observedAt: evidenceRef.observedAt,
        sensitivity: evidenceRef.sensitivity,
        ...(evidenceRef.artifactUri === undefined
          ? {}
          : { artifactUri: evidenceRef.artifactUri }),
        ...(evidenceRef.expiresAt === undefined
          ? {}
          : { expiresAt: evidenceRef.expiresAt }),
        ...(evidenceRef.metadata === undefined
          ? {}
          : { metadata: evidenceRef.metadata }),
      }),
    ),
  };
}

function observationCandidateFromObservation(
  observation: ExternalStateObservation,
): ExternalStateObservationCandidate {
  return {
    ...observation,
    evidence: observation.evidence.map((evidenceRef) =>
      pendingEvidenceRef({
        evidenceId: evidenceRef.evidenceId,
        kind: evidenceRef.kind,
        hash: evidenceRef.hash,
        observedAt: evidenceRef.observedAt,
        sensitivity: evidenceRef.sensitivity,
        ...(evidenceRef.artifactUri === undefined
          ? {}
          : { artifactUri: evidenceRef.artifactUri }),
        ...(evidenceRef.expiresAt === undefined
          ? {}
          : { expiresAt: evidenceRef.expiresAt }),
        ...(evidenceRef.metadata === undefined
          ? {}
          : { metadata: evidenceRef.metadata }),
      }),
    ),
  };
}

function pendingEvidenceRef(
  input: Omit<PendingEvidenceRef, "admissionStatus" | "pendingAdmissionToken">,
): PendingEvidenceRef {
  return {
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${input.evidenceId}`,
    ...input,
  };
}

function observationReceipt(input: {
  readonly effectRequest: EffectRequest;
  readonly payload: JsonObject;
  readonly receiptEventId: string;
}): EffectReceipt {
  const payloadHash = hashRunEventPayload(input.payload);
  return {
    receiptId: `receipt_${input.effectRequest.effectId}`,
    effectId: input.effectRequest.effectId,
    runId: input.effectRequest.runId,
    capabilityId: input.effectRequest.capabilityId,
    receiptType: "external_state_observation_read",
    status: "succeeded",
    payload: input.payload,
    payloadHash,
    evidence: [
      {
        evidenceId: `ev_${input.effectRequest.commandId}_receipt`,
        kind: "effect_receipt",
        sourceEventId: input.receiptEventId,
        hash: payloadHash,
        observedAt: now,
        sensitivity: "internal",
      },
    ],
    observedAt: now,
  };
}

function expectAdmittedObservationBlocked(
  runId: string,
  options: {
    readonly observedAt: string;
    readonly observedState: JsonObject;
    readonly mismatchType: Mismatch["type"];
    readonly subjectId?: string;
  },
): void {
  const kernel = startedKernel(runId);
  const observationEventId = `evt_${runId}_observation`;
  const evidenceRef = observationEvidenceRef(
    `ev_${runId}`,
    hashRunEventPayload(options.observedState),
    {
      sourceEventId: observationEventId,
      observedAt: options.observedAt,
    },
  );
  kernel.recordExternalStateObservation(
    pullRequestStateObservation(runId, {
      evidence: [evidenceRef],
      observedAt: options.observedAt,
      observedState: options.observedState,
      ...(options.subjectId === undefined
        ? {}
        : { subjectId: options.subjectId }),
    }),
    {
      eventId: observationEventId,
      occurredAt: options.observedAt,
    },
  );

  const result = kernel.submitFinalCandidate(
    candidateWith(runId, currentStateClaim({ evidenceRefs: [evidenceRef] })),
    {
      generatedAt: now,
      occurredAt: now,
    },
  );

  expect(result.decision.status).toBe("blocked");
  expect(result.proof.blockingMismatches).toContainEqual(
    expect.objectContaining({
      type: options.mismatchType,
      blocking: true,
    }),
  );
}

function singleObservationEvent(
  harness: LocalRunHarness,
): RunEvent<"ExternalStateObserved"> {
  const events = harness.kernel
    .events()
    .filter(
      (event): event is RunEvent<"ExternalStateObserved"> =>
        event.type === "ExternalStateObserved",
    );
  expect(events).toHaveLength(1);

  const [event] = events;
  if (event === undefined) {
    throw new Error("Expected one ExternalStateObserved event.");
  }
  return event;
}

function singleEvidenceRef(observation: ExternalStateObservation): EvidenceRef {
  const [evidenceRef] = observation.evidence;
  if (evidenceRef === undefined) {
    throw new Error("Expected observation evidence.");
  }
  return evidenceRef;
}

function countEvents(
  kernel: LocalRunHarness["kernel"],
  type: RunEventType,
): number {
  return eventTypes(kernel).filter((eventType) => eventType === type).length;
}

function sourceFiles(directories: readonly string[]): string[] {
  return directories
    .filter((directory) => existsSync(directory))
    .flatMap((directory) =>
      readdirSync(directory).flatMap((entry) => {
        const entryPath = path.join(directory, entry);
        const entryStat = statSync(entryPath);

        if (entryStat.isDirectory()) {
          return sourceFiles([entryPath]);
        }

        if (!entryStat.isFile() || entryPath.endsWith(".test.ts")) {
          return [];
        }

        return [entryPath];
      }),
    )
    .sort();
}
