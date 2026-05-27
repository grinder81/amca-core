import { canonicalObjectHash } from "@amca/contracts";
import { InMemorySemanticLedger } from "@amca/ledger";
import type {
  Claim,
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  RunEvent,
  RunEventType,
  Sha256Hash,
  TestResultPredicate,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import {
  InMemoryRunKernel,
  LedgerBackedRunKernel,
  RunKernelError,
  semanticLedgerEventSink,
  type KernelEventSink,
} from "./index.js";

const STARTED_AT = "2026-05-24T11:58:00.000Z";
const GENERATED_AT = "2026-05-24T12:00:00.000Z";
const RECEIPT_AT = "2026-05-24T11:59:30.000Z";

describe("LedgerBackedRunKernel", () => {
  it("keeps the default in-memory kernel event stream unchanged", () => {
    const runId = "run_phase_32_default_in_memory";
    const kernel = new InMemoryRunKernel({
      runId,
      clock: () => GENERATED_AT,
    });

    kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
    const result = kernel.submitFinalCandidate(
      candidateWith(runId, testResultClaim({ evidenceRefs: [] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(result.decision.status).toBe("blocked");
    expect(eventTypes(kernel.events())).toEqual([
      "RunStarted",
      "ProposalReceived",
      "ProofGenerated",
      "MismatchDetected",
      "ReleaseDecided",
    ]);
  });

  it("mirrors accepted kernel events into a SemanticLedger sink in exact order", async () => {
    const runId = "run_phase_32_ledger_sink_order";
    const receiptEventId = "evt_phase_32_receipt";
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_phase_32_test_receipt",
      canonicalObjectHash(payload),
      {
        sourceEventId: receiptEventId,
      },
    );
    const semanticLedger = new InMemorySemanticLedger();
    const kernel = new LedgerBackedRunKernel({
      runId,
      eventSink: semanticLedgerEventSink({ ledger: semanticLedger }),
      clock: () => GENERATED_AT,
    });

    await kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
    await kernel.recordEffectRequest(testRunEffectRequest(runId));
    await kernel.recordEffectReceipt(
      testRunReceipt(runId, {
        evidence: [evidenceRef],
        payload,
      }),
      {
        eventId: receiptEventId,
        occurredAt: RECEIPT_AT,
      },
    );
    const result = await kernel.submitFinalCandidate(
      candidateWith(runId, testResultClaim({ evidenceRefs: [evidenceRef] })),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    const ledgerEvents = await semanticLedger.readRunEvents(runId);
    expect(result.decision.status).toBe("released");
    expect(ledgerEvents.map((event) => event.eventId)).toEqual(
      kernel.events().map((event) => event.eventId),
    );
    expect(ledgerEvents.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(eventTypes(ledgerEvents)).toEqual([
      "RunStarted",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
  });

  it("persists write preflight and quarantine events through the ledger sink", async () => {
    const runId = "run_phase_44_ledger_preflight";
    const semanticLedger = new InMemorySemanticLedger();
    const kernel = new LedgerBackedRunKernel({
      runId,
      eventSink: semanticLedgerEventSink({ ledger: semanticLedger }),
      clock: () => GENERATED_AT,
    });
    const candidate = writePreflightCandidate(runId);
    const quarantine = writeQuarantineState(runId);
    const decision = quarantinedWritePreflightDecision(runId, quarantine);

    await kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
    const requested = await kernel.recordWritePreflightRequested(candidate, {
      eventId: "evt_phase_44_preflight_requested",
      occurredAt: RECEIPT_AT,
      correlationId: "corr_phase_44_preflight",
    });
    const decided = await kernel.recordWritePreflightDecided(decision, {
      eventId: "evt_phase_44_preflight_decided",
      occurredAt: RECEIPT_AT,
      causationId: requested.eventId,
      correlationId: "corr_phase_44_preflight",
    });
    await kernel.recordWriteQuarantined(quarantine, {
      eventId: "evt_phase_44_write_quarantined",
      occurredAt: RECEIPT_AT,
      causationId: decided.eventId,
      correlationId: "corr_phase_44_preflight",
    });

    const ledgerEvents = await semanticLedger.readRunEvents(runId);
    expect(eventTypes(ledgerEvents)).toEqual([
      "RunStarted",
      "WritePreflightRequested",
      "WritePreflightDecided",
      "WriteQuarantined",
    ]);
    expect(kernel.writeQuarantineStates()).toEqual([quarantine]);
  });

  it("fails closed when the ledger sink rejects an accepted event", async () => {
    const runId = "run_phase_32_ledger_sink_failure";
    const kernel = new LedgerBackedRunKernel({
      runId,
      eventSink: failingSink("semantic ledger unavailable"),
      clock: () => GENERATED_AT,
    });

    await expect(
      kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" }),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });
    expect(() => kernel.events()).toThrow(RunKernelError);
    expect(() => kernel.replay()).toThrow(RunKernelError);
    await expect(
      kernel.submitFinalCandidate(
        candidateWith(runId, testResultClaim({ evidenceRefs: [] })),
      ),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });
  });

  it("fails closed when EffectRequested persistence fails", async () => {
    const runId = "run_phase_32_effect_requested_append_failure";
    const failingEventSink = new FailingOnEventTypeSink("EffectRequested");
    const kernel = new LedgerBackedRunKernel({
      runId,
      eventSink: failingEventSink,
      clock: () => GENERATED_AT,
    });

    await kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
    await expect(
      kernel.recordEffectRequest(testRunEffectRequest(runId)),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });

    expect(eventTypes(failingEventSink.events)).toEqual(["RunStarted"]);
    expect(() => kernel.events()).toThrow(RunKernelError);
  });

  it("fails closed when EffectReceiptRecorded persistence fails and blocks later claim support", async () => {
    const runId = "run_phase_32_receipt_append_failure";
    const receiptEventId = "evt_phase_32_receipt_append_failure";
    const payload = { result: "passed" };
    const evidenceRef = effectEvidenceRef(
      "ev_phase_32_receipt_append_failure",
      canonicalObjectHash(payload),
      {
        sourceEventId: receiptEventId,
      },
    );
    const failingEventSink = new FailingOnEventTypeSink(
      "EffectReceiptRecorded",
    );
    const kernel = new LedgerBackedRunKernel({
      runId,
      eventSink: failingEventSink,
      clock: () => GENERATED_AT,
    });

    await kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
    await kernel.recordEffectRequest(testRunEffectRequest(runId));
    await expect(
      kernel.recordEffectReceipt(
        testRunReceipt(runId, {
          evidence: [evidenceRef],
          payload,
        }),
        {
          eventId: receiptEventId,
          occurredAt: RECEIPT_AT,
        },
      ),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });

    expect(eventTypes(failingEventSink.events)).toEqual([
      "RunStarted",
      "EffectRequested",
    ]);
    await expect(
      kernel.submitFinalCandidate(
        candidateWith(runId, testResultClaim({ evidenceRefs: [evidenceRef] })),
      ),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });
  });

  it("fails closed when ProofGenerated persistence fails before release can be returned", async () => {
    const runId = "run_phase_32_proof_append_failure";
    const { kernel, sink, evidenceRef } = await releasedClaimKernel({
      failOnType: "ProofGenerated",
      runId,
    });

    await expect(
      kernel.submitFinalCandidate(
        candidateWith(runId, testResultClaim({ evidenceRefs: [evidenceRef] })),
        {
          occurredAt: GENERATED_AT,
          generatedAt: GENERATED_AT,
        },
      ),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });

    expect(eventTypes(sink.events)).not.toContain("ReleaseDecided");
    expect(eventTypes(sink.events)).not.toContain("FinalReleased");
  });

  it("fails closed when MismatchDetected persistence fails before a blocked release decision can be returned", async () => {
    const runId = "run_phase_32_mismatch_append_failure";
    const sink = new FailingOnEventTypeSink("MismatchDetected");
    const kernel = new LedgerBackedRunKernel({
      runId,
      eventSink: sink,
      clock: () => GENERATED_AT,
    });

    await kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
    await expect(
      kernel.submitFinalCandidate(
        candidateWith(runId, testResultClaim({ evidenceRefs: [] })),
        {
          occurredAt: GENERATED_AT,
          generatedAt: GENERATED_AT,
        },
      ),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });

    expect(eventTypes(sink.events)).toContain("ProofGenerated");
    expect(eventTypes(sink.events)).not.toContain("ReleaseDecided");
    expect(eventTypes(sink.events)).not.toContain("FinalReleased");
  });

  it("fails closed when ReleaseDecided persistence fails before output is returned", async () => {
    const runId = "run_phase_32_release_append_failure";
    const { kernel, sink, evidenceRef } = await releasedClaimKernel({
      failOnType: "ReleaseDecided",
      runId,
    });

    await expect(
      kernel.submitFinalCandidate(
        candidateWith(runId, testResultClaim({ evidenceRefs: [evidenceRef] })),
        {
          occurredAt: GENERATED_AT,
          generatedAt: GENERATED_AT,
        },
      ),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });

    expect(eventTypes(sink.events)).toContain("ProofGenerated");
    expect(eventTypes(sink.events)).not.toContain("ReleaseDecided");
    expect(eventTypes(sink.events)).not.toContain("FinalReleased");
  });

  it("fails closed when FinalReleased persistence fails and does not return a released message", async () => {
    const runId = "run_phase_32_final_released_append_failure";
    const { kernel, sink, evidenceRef } = await releasedClaimKernel({
      failOnType: "FinalReleased",
      runId,
    });

    await expect(
      kernel.submitFinalCandidate(
        candidateWith(runId, testResultClaim({ evidenceRefs: [evidenceRef] })),
        {
          occurredAt: GENERATED_AT,
          generatedAt: GENERATED_AT,
        },
      ),
    ).rejects.toMatchObject({
      code: "ledger_append_failed",
    });

    expect(eventTypes(sink.events)).toContain("ReleaseDecided");
    expect(eventTypes(sink.events)).not.toContain("FinalReleased");
    expect(() => kernel.events()).toThrow(RunKernelError);
  });

  it("validates event causality and evidence before ledger persistence", async () => {
    const runId = "run_phase_32_validate_before_sink";
    const receiptEventId = "evt_phase_32_receipt_expected";
    const payload = { result: "passed" };
    const recordingSink = new RecordingSink();
    const kernel = new LedgerBackedRunKernel({
      runId,
      eventSink: recordingSink,
      clock: () => GENERATED_AT,
    });

    await kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
    await kernel.recordEffectRequest(testRunEffectRequest(runId));

    await expect(
      kernel.recordEffectReceipt(
        testRunReceipt(runId, {
          evidence: [
            effectEvidenceRef(
              "ev_phase_32_wrong_source",
              canonicalObjectHash(payload),
              {
                sourceEventId: "evt_not_the_receipt_event",
              },
            ),
          ],
          payload,
        }),
        {
          eventId: receiptEventId,
          occurredAt: RECEIPT_AT,
        },
      ),
    ).rejects.toMatchObject({
      code: "evidence_source_event_mismatch",
    });

    expect(eventTypes(recordingSink.events)).toEqual([
      "RunStarted",
      "EffectRequested",
    ]);
    expect(recordingSink.events).not.toContainEqual(
      expect.objectContaining({ eventId: receiptEventId }),
    );
  });
});

class RecordingSink implements KernelEventSink {
  readonly events: RunEvent[] = [];

  appendAcceptedEvent(event: RunEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class FailingOnEventTypeSink implements KernelEventSink {
  readonly events: RunEvent[] = [];
  readonly #eventType: RunEventType;

  constructor(eventType: RunEventType) {
    this.#eventType = eventType;
  }

  appendAcceptedEvent(event: RunEvent): Promise<void> {
    if (event.type === this.#eventType) {
      return Promise.reject(
        new Error(`semantic ledger rejected ${event.type}`),
      );
    }

    this.events.push(event);
    return Promise.resolve();
  }
}

function failingSink(message: string): KernelEventSink {
  return {
    appendAcceptedEvent() {
      return Promise.reject(new Error(message));
    },
  };
}

async function releasedClaimKernel(input: {
  readonly failOnType: RunEventType;
  readonly runId: string;
}): Promise<{
  readonly evidenceRef: EvidenceRef;
  readonly kernel: LedgerBackedRunKernel;
  readonly sink: FailingOnEventTypeSink;
}> {
  const receiptEventId = `evt_${input.runId}_receipt`;
  const payload = { result: "passed" };
  const evidenceRef = effectEvidenceRef(
    `ev_${input.runId}_test_receipt`,
    canonicalObjectHash(payload),
    {
      sourceEventId: receiptEventId,
    },
  );
  const sink = new FailingOnEventTypeSink(input.failOnType);
  const kernel = new LedgerBackedRunKernel({
    runId: input.runId,
    eventSink: sink,
    clock: () => GENERATED_AT,
  });

  await kernel.startRun({ occurredAt: STARTED_AT, profile: "standard" });
  await kernel.recordEffectRequest(testRunEffectRequest(input.runId));
  await kernel.recordEffectReceipt(
    testRunReceipt(input.runId, {
      evidence: [evidenceRef],
      payload,
    }),
    {
      eventId: receiptEventId,
      occurredAt: RECEIPT_AT,
    },
  );

  return {
    evidenceRef,
    kernel,
    sink,
  };
}

function eventTypes(events: readonly RunEvent[]): RunEventType[] {
  return events.map((event) => event.type);
}

function candidateWith(runId: string, claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${claim.claimId}`,
    runId,
    claims: [claim],
  };
}

interface TestResultClaimOptions {
  readonly evidenceRefs: readonly EvidenceRef[];
}

function testResultClaim(options: TestResultClaimOptions): Claim {
  const predicate: TestResultPredicate = {
    kind: "test_result",
    capabilityId: "shell.run_tests",
    expectedStatus: "passed",
    requiredReceiptType: "test_run",
  };

  return {
    claimId: "claim_tests_passed",
    type: "test_result",
    statement: "Tests passed.",
    predicate,
    evidenceRefs: [...options.evidenceRefs],
    criticality: "medium",
  };
}

interface EvidenceRefOptions {
  readonly sourceEventId: string;
}

function effectEvidenceRef(
  evidenceId: string,
  hash: Sha256Hash,
  options: EvidenceRefOptions,
): EvidenceRef {
  return {
    evidenceId,
    kind: "effect_receipt",
    sourceEventId: options.sourceEventId,
    hash,
    observedAt: RECEIPT_AT,
    sensitivity: "internal",
  };
}

interface TestRunReceiptOptions {
  readonly evidence: readonly EvidenceRef[];
  readonly payload: JsonObject;
}

function testRunReceipt(
  runId: string,
  options: TestRunReceiptOptions,
): EffectReceipt {
  return {
    receiptId: "receipt_test_001",
    effectId: "effect_test_001",
    runId,
    capabilityId: "shell.run_tests",
    receiptType: "test_run",
    status: "succeeded",
    payload: options.payload,
    payloadHash: canonicalObjectHash(options.payload),
    evidence: [...options.evidence],
    observedAt: RECEIPT_AT,
  };
}

function testRunEffectRequest(runId: string): EffectRequest {
  return {
    effectId: "effect_test_001",
    commandId: "command_test_001",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    requestedAt: RECEIPT_AT,
  };
}

function writePreflightCandidate(runId: string): WritePreflightCandidate {
  return {
    kind: "write_preflight_candidate",
    preflightId: "preflight_write_001",
    runId,
    commandId: "command_write_001",
    capabilityId: "ops.critical_write",
    toolId: "ops.critical_write",
    sideEffectClass: "critical_write",
    argsHash: canonicalObjectHash({
      targetType: "protected_resource",
      targetId: "critical_001",
    }),
    requestedAt: RECEIPT_AT,
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
    quarantinedAt: RECEIPT_AT,
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
    decidedAt: RECEIPT_AT,
    idempotencyKey: `${runId}:critical_write:001`,
  };
}
