import type {
  EffectReceipt,
  EffectRequest,
  ExternalStateObservation,
  FinalCandidate,
  Mismatch,
  Profile,
  ProofObject,
  ReleaseDecision,
  RunEvent,
  ToolCommandRequest,
} from "@amca/protocol";

export const scenarioIds = [
  "tests-passed-blocked",
  "tests-passed-released",
  "statement-predicate-mismatch-blocked-or-safely-rendered",
  "pr-opened-blocked",
  "pr-opened-released",
  "pr-current-state-stale-blocked",
  "pr-current-state-fresh-released",
] as const;

export type ScenarioId = (typeof scenarioIds)[number];

export type ScenarioCase = "positive" | "negative";

export interface ScenarioRuntimeScope {
  requiresRuntimeBehavior: false;
  implementsProofBehavior: false;
  implementsKernelBehavior: false;
  implementsCliBehavior: false;
}

export interface ScenarioGiven {
  toolCommandRequest: ToolCommandRequest;
  effectRequest: EffectRequest;
  effectReceipt?: EffectReceipt;
  externalStateObservation?: ExternalStateObservation;
  finalCandidate: FinalCandidate;
  runEvents: RunEvent[];
}

export interface ScenarioExpected {
  proof: ProofObject;
  mismatches: Mismatch[];
  releaseDecision: ReleaseDecision;
  emittedEvents: RunEvent[];
}

export interface ScenarioFixture {
  id: ScenarioId;
  title: string;
  case: ScenarioCase;
  profile: Profile;
  description: string;
  runtimeScope: ScenarioRuntimeScope;
  given: ScenarioGiven;
  expected: ScenarioExpected;
}
