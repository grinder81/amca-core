import { describe, expect, it } from "vitest";

import type { RunEvent } from "@amca/protocol";
import testsPassedReleasedJson from "../../../scenarios/tests-passed-released.json" with { type: "json" };
import prCurrentStateStaleBlockedJson from "../../../scenarios/pr-current-state-stale-blocked.json" with { type: "json" };

import { evaluateAcceptedRun, renderEvalMarkdown } from "./run-eval.js";

const testsPassedReleasedScenario = testsPassedReleasedJson as ScenarioLike;
const prCurrentStateStaleBlockedScenario =
  prCurrentStateStaleBlockedJson as ScenarioLike;

interface ScenarioLike {
  readonly given: {
    readonly runEvents: readonly RunEvent[];
  };
  readonly expected: {
    readonly emittedEvents: readonly RunEvent[];
    readonly releaseDecision: {
      readonly status: string;
      readonly approvedClaimIds: readonly string[];
    };
  };
}

describe("evaluateAcceptedRun", () => {
  it("passes when replayed accepted events match expectations", () => {
    const result = evaluateAcceptedRun({
      events: eventsForScenario(testsPassedReleasedScenario),
      expected: {
        releaseStatus:
          testsPassedReleasedScenario.expected.releaseDecision.status,
        approvedClaimIds:
          testsPassedReleasedScenario.expected.releaseDecision.approvedClaimIds,
        mismatchTypes: [],
      },
    });

    expect(result.status).toBe("pass");
    expect(result.regressions).toEqual([]);
    expect(renderEvalMarkdown(result)).toContain("status: pass");
  });

  it("detects release status regressions", () => {
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

  it("detects mismatch regressions", () => {
    const result = evaluateAcceptedRun({
      events: eventsForScenario(prCurrentStateStaleBlockedScenario),
      expected: {
        releaseStatus: "blocked",
        mismatchTypes: ["missing_evidence"],
      },
    });

    expect(result.status).toBe("fail");
    expect(result.regressions.map((regression) => regression.code)).toContain(
      "mismatch_types_changed",
    );
  });

  it("detects approved claim regressions", () => {
    const result = evaluateAcceptedRun({
      events: eventsForScenario(testsPassedReleasedScenario),
      expected: {
        releaseStatus: "released",
        approvedClaimIds: ["claim_wrong"],
      },
    });

    expect(result.status).toBe("fail");
    expect(result.regressions.map((regression) => regression.code)).toContain(
      "approved_claim_ids_changed",
    );
  });

  it("fails when replay rejects tampered events", () => {
    const [first, second, ...rest] = eventsForScenario(
      testsPassedReleasedScenario,
    );
    if (first === undefined || second === undefined) {
      throw new Error("Scenario events missing.");
    }

    const result = evaluateAcceptedRun({
      events: [
        first,
        {
          ...second,
          payloadHash:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
        ...rest,
      ],
      expected: {
        releaseStatus: "released",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.regressions.map((regression) => regression.code)).toContain(
      "replay_failed",
    );
  });
});

function eventsForScenario(scenario: ScenarioLike): readonly RunEvent[] {
  return [...scenario.given.runEvents, ...scenario.expected.emittedEvents];
}
