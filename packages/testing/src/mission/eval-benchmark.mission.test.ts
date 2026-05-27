import { describe, expect, it } from "vitest";

import { evaluateAcceptedRun, runDeterministicBenchmark } from "@amca/eval";
import { hashRunEventPayload } from "@amca/kernel";
import type { EffectReceipt, EvidenceRef, RunEvent } from "@amca/protocol";
import { replayRunEvents } from "@amca/replay";
import {
  prCurrentStateStaleBlockedScenario,
  testsPassedReleasedScenario,
  type ScenarioFixture,
} from "@amca/testing";

import {
  candidateWith,
  effectEvidenceRef,
  GENERATED_AT,
  startedKernel,
  testResultClaim,
  testRunEffectRequest,
} from "./mission-helpers.js";

describe("Mission eval and benchmark litmus", () => {
  it("eval catches false release status regressions", () => {
    const result = evaluateAcceptedRun({
      events: eventsForScenario(testsPassedReleasedScenario),
      expected: {
        releaseStatus: "blocked",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.regressions.map((regression) => regression.code)).toContain(
      "release_status_changed",
    );
  });

  it("eval catches missing mismatch regressions", () => {
    const result = evaluateAcceptedRun({
      events: eventsForScenario(prCurrentStateStaleBlockedScenario),
      expected: {
        releaseStatus: "blocked",
        mismatchTypes: [],
      },
    });

    expect(result.status).toBe("fail");
    expect(result.regressions.map((regression) => regression.code)).toContain(
      "mismatch_types_changed",
    );
  });

  it("benchmark results are not proof authority", () => {
    const result = runDeterministicBenchmark({
      benchmarkId: "mission_benchmark_not_proof",
      iterations: 1,
      clock: fixedClock([100, 105]),
      task: () => undefined,
    });

    expect(result.kind).toBe("benchmark_result");
    expect(result.proofUsable).toBe(false);
  });

  it("eval-runner-output-referenced-as-evidence-blocked", () => {
    const runId = "mission_eval_output_evidence_attack";
    const evalOutput = evaluateAcceptedRun({
      events: eventsForScenario(testsPassedReleasedScenario),
      expected: {
        releaseStatus: "released",
      },
    });
    const invalidEvidenceRef = evalOutput as unknown as EvidenceRef;
    const kernel = startedKernel(runId);

    expect(evalOutput.status).toBe("pass");
    expect(() =>
      kernel.submitFinalCandidate(
        candidateWith(
          runId,
          testResultClaim({
            evidenceRefs: [invalidEvidenceRef],
          }),
        ),
        {
          occurredAt: GENERATED_AT,
          generatedAt: GENERATED_AT,
        },
      ),
    ).toThrow(/FinalCandidate validation failed/u);
    expectNoProofPassOrReleasedDecision(kernel);

    const forgedEvidenceRef = evidenceRefForArtifact(
      "ev_eval_runner_output",
      "evt_eval_runner_output",
      evalOutput,
    );
    const blocked = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim({
          evidenceRefs: [forgedEvidenceRef],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(blocked.proof.verdict).toBe("fail");
    expect(blocked.decision.status).toBe("blocked");
    expect(blocked.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        blocking: true,
      }),
    );
    expectNoProofPassOrReleasedDecision(kernel);
  });

  it("benchmark-output-referenced-as-evidence-blocked", () => {
    const runId = "mission_benchmark_output_evidence_attack";
    const benchmarkOutput = runDeterministicBenchmark({
      benchmarkId: "mission_benchmark_output_attack",
      iterations: 1,
      clock: fixedClock([200, 205]),
      task: () => undefined,
    });
    const invalidEvidenceRef = benchmarkOutput as unknown as EvidenceRef;
    const kernel = startedKernel(runId);

    expect(() =>
      kernel.submitFinalCandidate(
        candidateWith(
          runId,
          testResultClaim({
            evidenceRefs: [invalidEvidenceRef],
          }),
        ),
        {
          occurredAt: GENERATED_AT,
          generatedAt: GENERATED_AT,
        },
      ),
    ).toThrow(/FinalCandidate validation failed/u);
    expectNoProofPassOrReleasedDecision(kernel);

    const forgedEvidenceRef = evidenceRefForArtifact(
      "ev_benchmark_output",
      "evt_benchmark_output",
      benchmarkOutput,
    );
    const blocked = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim({
          evidenceRefs: [forgedEvidenceRef],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(blocked.proof.verdict).toBe("fail");
    expect(blocked.decision.status).toBe("blocked");
    expect(blocked.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        blocking: true,
      }),
    );
    expectNoProofPassOrReleasedDecision(kernel);
  });

  it("replay-output-used-as-receipt-blocked", () => {
    const runId = "mission_replay_output_receipt_attack";
    const replayOutput = replayRunEvents({
      events: eventsForScenario(testsPassedReleasedScenario),
    });
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(testRunEffectRequest(runId));

    expect(replayOutput.status).toBe("passed");
    expect(() =>
      kernel.recordEffectReceipt(replayOutput as unknown as EffectReceipt, {
        eventId: "evt_replay_output_as_receipt",
        occurredAt: GENERATED_AT,
      }),
    ).toThrow(/EffectReceipt validation failed/u);
    expect(kernel.events().map((event) => event.type)).not.toContain(
      "EffectReceiptRecorded",
    );

    const forgedEvidenceRef = evidenceRefForArtifact(
      "ev_replay_output",
      "evt_replay_output",
      replayOutput,
    );
    const blocked = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim({
          evidenceRefs: [forgedEvidenceRef],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(blocked.proof.verdict).toBe("fail");
    expect(blocked.decision.status).toBe("blocked");
    expect(blocked.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        blocking: true,
      }),
    );
    expectNoProofPassOrReleasedDecision(kernel);
  });

  it("external-effect-safety-review-output-used-as-receipt-blocked", () => {
    const runId = "mission_external_effect_report_receipt_attack";
    const reviewOutput = {
      kind: "phase_evidence_report",
      phase: "40-42",
      status: "pass",
      statement: "External effect safety checks passed.",
    };
    const kernel = startedKernel(runId);

    kernel.recordEffectRequest(testRunEffectRequest(runId));

    expect(() =>
      kernel.recordEffectReceipt(reviewOutput as unknown as EffectReceipt, {
        eventId: "evt_phase_report_as_receipt",
        occurredAt: GENERATED_AT,
      }),
    ).toThrow(/EffectReceipt validation failed/u);
    expect(kernel.events().map((event) => event.type)).not.toContain(
      "EffectReceiptRecorded",
    );

    const forgedEvidenceRef = evidenceRefForArtifact(
      "ev_phase_report_output",
      "evt_phase_report_output",
      reviewOutput,
    );
    const blocked = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim({
          evidenceRefs: [forgedEvidenceRef],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(blocked.proof.verdict).toBe("fail");
    expect(blocked.decision.status).toBe("blocked");
    expect(blocked.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        blocking: true,
      }),
    );
    expectNoProofPassOrReleasedDecision(kernel);
  });
});

function eventsForScenario(
  scenario: ScenarioFixture,
): ScenarioFixture["given"]["runEvents"] {
  return [...scenario.given.runEvents, ...scenario.expected.emittedEvents];
}

function fixedClock(values: readonly number[]) {
  let index = 0;
  return {
    now: (): number => {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error("Clock exhausted.");
      }

      return value;
    },
  };
}

function evidenceRefForArtifact(
  evidenceId: string,
  sourceEventId: string,
  artifact: unknown,
): EvidenceRef {
  return effectEvidenceRef(evidenceId, hashRunEventPayload(artifact), {
    sourceEventId,
  });
}

function expectNoProofPassOrReleasedDecision(
  kernel: ReturnType<typeof startedKernel>,
): void {
  const eventTypes = kernel.events().map((event) => event.type);

  for (const event of proofGeneratedEvents(kernel.events())) {
    expect(event.payload.proof.verdict).not.toBe("pass");
  }

  for (const event of releaseDecidedEvents(kernel.events())) {
    expect(event.payload.decision.status).not.toBe("released");
  }

  expect(eventTypes).not.toContain("FinalReleased");
}

function proofGeneratedEvents(
  events: readonly RunEvent[],
): Array<RunEvent<"ProofGenerated">> {
  return events.filter(
    (event): event is RunEvent<"ProofGenerated"> =>
      event.type === "ProofGenerated",
  );
}

function releaseDecidedEvents(
  events: readonly RunEvent[],
): Array<RunEvent<"ReleaseDecided">> {
  return events.filter(
    (event): event is RunEvent<"ReleaseDecided"> =>
      event.type === "ReleaseDecided",
  );
}
