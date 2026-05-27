import { describe, expect, expectTypeOf, it } from "vitest";

import testsPassedBlockedJson from "../../../scenarios/tests-passed-blocked.json" with { type: "json" };
import testsPassedReleasedJson from "../../../scenarios/tests-passed-released.json" with { type: "json" };
import statementPredicateMismatchJson from "../../../scenarios/statement-predicate-mismatch-blocked-or-safely-rendered.json" with { type: "json" };
import prOpenedBlockedJson from "../../../scenarios/pr-opened-blocked.json" with { type: "json" };
import prOpenedReleasedJson from "../../../scenarios/pr-opened-released.json" with { type: "json" };
import prCurrentStateStaleBlockedJson from "../../../scenarios/pr-current-state-stale-blocked.json" with { type: "json" };
import prCurrentStateFreshReleasedJson from "../../../scenarios/pr-current-state-fresh-released.json" with { type: "json" };

import type {
  EffectReceipt,
  EffectRequest,
  ExternalStateObservation,
  FinalCandidate,
  Mismatch,
  ProofObject,
  ReleaseDecision,
  RunEvent,
  ToolCommandRequest,
} from "@amca/protocol";
import { orderAndValidateRunEvents } from "@amca/kernel";

import {
  prCurrentStateFreshReleasedScenario,
  prCurrentStateStaleBlockedScenario,
  scenarioFixtures,
  scenarioFixturesById,
  scenarioIds,
} from "./index.js";
import type { ScenarioExpected, ScenarioGiven, ScenarioId } from "./index.js";

const scenarioJsonById = {
  "tests-passed-blocked": testsPassedBlockedJson,
  "tests-passed-released": testsPassedReleasedJson,
  "statement-predicate-mismatch-blocked-or-safely-rendered":
    statementPredicateMismatchJson,
  "pr-opened-blocked": prOpenedBlockedJson,
  "pr-opened-released": prOpenedReleasedJson,
  "pr-current-state-stale-blocked": prCurrentStateStaleBlockedJson,
  "pr-current-state-fresh-released": prCurrentStateFreshReleasedJson,
} satisfies Record<ScenarioId, unknown>;

const expectedStaticRuntimeScope = {
  requiresRuntimeBehavior: false,
  implementsProofBehavior: false,
  implementsKernelBehavior: false,
  implementsCliBehavior: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const containsFunction = (value: unknown): boolean => {
  if (typeof value === "function") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(containsFunction);
  }

  if (isRecord(value)) {
    return Object.values(value).some(containsFunction);
  }

  return false;
};

describe("AMCA scenario fixtures", () => {
  it("matches the locked v0 scenario set", () => {
    expect(scenarioFixtures.map((scenario) => scenario.id)).toEqual(
      scenarioIds,
    );
    expect(Object.keys(scenarioFixturesById).sort()).toEqual(
      [...scenarioIds].sort(),
    );
  });

  it("keeps fixture fields typed against protocol models", () => {
    expectTypeOf<
      ScenarioGiven["toolCommandRequest"]
    >().toEqualTypeOf<ToolCommandRequest>();
    expectTypeOf<
      ScenarioGiven["effectRequest"]
    >().toEqualTypeOf<EffectRequest>();
    expectTypeOf<
      NonNullable<ScenarioGiven["effectReceipt"]>
    >().toEqualTypeOf<EffectReceipt>();
    expectTypeOf<
      NonNullable<ScenarioGiven["externalStateObservation"]>
    >().toEqualTypeOf<ExternalStateObservation>();
    expectTypeOf<
      ScenarioGiven["finalCandidate"]
    >().toEqualTypeOf<FinalCandidate>();
    expectTypeOf<
      ScenarioGiven["runEvents"][number]
    >().toEqualTypeOf<RunEvent>();
    expectTypeOf<ScenarioExpected["proof"]>().toEqualTypeOf<ProofObject>();
    expectTypeOf<
      ScenarioExpected["mismatches"][number]
    >().toEqualTypeOf<Mismatch>();
    expectTypeOf<
      ScenarioExpected["releaseDecision"]
    >().toEqualTypeOf<ReleaseDecision>();
  });

  it("represents negative and positive acceptance cases", () => {
    expect(
      scenarioFixtures
        .filter(({ case: caseKind }) => caseKind === "negative")
        .map((scenario) => scenario.id),
    ).toEqual([
      "tests-passed-blocked",
      "pr-opened-blocked",
      "pr-current-state-stale-blocked",
    ]);

    expect(
      scenarioFixtures
        .filter(({ case: caseKind }) => caseKind === "positive")
        .map((scenario) => scenario.id),
    ).toEqual([
      "tests-passed-released",
      "statement-predicate-mismatch-blocked-or-safely-rendered",
      "pr-opened-released",
      "pr-current-state-fresh-released",
    ]);
  });

  it("keeps final candidates structured and predicate-backed", () => {
    for (const scenario of scenarioFixtures) {
      expect(scenario.given.finalCandidate.kind).toBe("final_candidate");
      expect(scenario.given.finalCandidate.claims.length).toBeGreaterThan(0);

      for (const claim of scenario.given.finalCandidate.claims) {
        expect(claim.predicate.kind).toBe(claim.type);
        expect(claim.statement.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses first-class evidence refs whenever a fixture supplies evidence", () => {
    for (const scenario of scenarioFixtures) {
      const evidenceRefs = [
        ...scenario.given.finalCandidate.claims.flatMap(
          (claim) => claim.evidenceRefs,
        ),
        ...(scenario.given.effectReceipt?.evidence ?? []),
        ...(scenario.given.externalStateObservation?.evidence ?? []),
        ...scenario.expected.proof.claims.flatMap(
          (claimProof) => claimProof.evidenceRefs,
        ),
      ];

      for (const evidenceRef of evidenceRefs) {
        expect(evidenceRef.evidenceId).toMatch(/^ev_/);
        expect(evidenceRef.sourceEventId).toMatch(/^evt_/);
        expect(evidenceRef.hash).toMatch(/^sha256:/);
        expect(evidenceRef.observedAt).toMatch(/Z$/);
        expect(evidenceRef.sensitivity).toMatch(
          /^(public|internal|confidential|restricted)$/,
        );
      }
    }
  });

  it("aligns receipt payload fields with v0 claim predicates", () => {
    for (const scenario of scenarioFixtures) {
      const receiptPayload = scenario.given.effectReceipt?.payload;
      const [claim] = scenario.given.finalCandidate.claims;

      if (receiptPayload === undefined || claim === undefined) {
        continue;
      }

      if (claim.predicate.kind === "test_result") {
        expect(receiptPayload.result).toBe(claim.predicate.expectedStatus);
        expect(receiptPayload.testSuiteId).toBe(claim.predicate.testSuiteId);
      }

      if (claim.predicate.kind === "historical_action") {
        expect(receiptPayload.actionVerb).toBe(claim.predicate.actionVerb);
        expect(receiptPayload.subjectType).toBe(claim.predicate.subjectType);
        expect(receiptPayload.subjectId).toBe(claim.predicate.subjectId);
        expect(receiptPayload.targetType).toBe(claim.predicate.targetType);
        expect(receiptPayload.targetId).toBe(claim.predicate.targetId);
      }
    }
  });

  it("aligns expected decisions with mismatches", () => {
    for (const scenario of scenarioFixtures) {
      const blockingMismatchIds = scenario.expected.mismatches.map(
        (mismatch) => mismatch.mismatchId,
      );

      expect(scenario.expected.releaseDecision.blockingMismatchIds).toEqual(
        blockingMismatchIds,
      );

      if (scenario.case === "positive") {
        expect(scenario.expected.releaseDecision.status).toBe("released");
        expect(scenario.expected.mismatches).toEqual([]);
      } else {
        expect(scenario.expected.releaseDecision.status).toBe("blocked");
        expect(scenario.expected.mismatches.length).toBeGreaterThan(0);
      }
    }
  });

  it("captures stale and fresh current-state outcomes without evaluating proof", () => {
    expect(
      prCurrentStateStaleBlockedScenario.expected.mismatches.map(
        (mismatch) => mismatch.type,
      ),
    ).toEqual(["stale_external_state"]);
    expect(
      prCurrentStateStaleBlockedScenario.expected.releaseDecision.status,
    ).toBe("blocked");
    expect(prCurrentStateFreshReleasedScenario.expected.mismatches).toEqual([]);
    expect(
      prCurrentStateFreshReleasedScenario.expected.releaseDecision.status,
    ).toBe("released");
  });

  it("keeps event fixtures ordered and replayable as data", () => {
    for (const scenario of scenarioFixtures) {
      const events = [
        ...scenario.given.runEvents,
        ...scenario.expected.emittedEvents,
      ];

      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_, index) => index + 1),
      );
      expect(new Set(events.map((event) => event.eventId)).size).toBe(
        events.length,
      );

      for (const event of events) {
        expect(event.runId).toBe(scenario.given.finalCandidate.runId);
        expect(event.payloadHash).toMatch(/^sha256:/);
        expect(event.correlationId).not.toBeNull();
      }

      expect(
        orderAndValidateRunEvents(events, scenario.given.finalCandidate.runId),
      ).toEqual(events);
    }
  });

  it("does not embed runtime, proof, kernel, or CLI behavior", () => {
    for (const scenario of scenarioFixtures) {
      expect(scenario.runtimeScope).toEqual(expectedStaticRuntimeScope);
      expect(containsFunction(scenario)).toBe(false);
    }
  });

  it("keeps committed JSON scenario files in sync with typed fixtures", () => {
    for (const scenario of scenarioFixtures) {
      expect(scenarioJsonById[scenario.id]).toEqual(scenario);
    }
  });

  it("indexes scenarios by id without changing fixture objects", () => {
    for (const scenario of scenarioFixtures) {
      expect(scenarioFixturesById[scenario.id]).toBe(scenario);
    }
  });
});
