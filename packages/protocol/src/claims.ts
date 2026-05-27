import type { EvidenceRef } from "./evidence.js";
import type { Criticality } from "./shared.js";

export type ClaimType = "historical_action" | "test_result" | "current_state";

export type ClaimPredicate =
  | HistoricalActionPredicate
  | TestResultPredicate
  | CurrentStatePredicate;

export interface Claim {
  claimId: string;
  type: ClaimType;
  statement: string;
  predicate: ClaimPredicate;
  evidenceRefs: EvidenceRef[];
  criticality: Criticality;
}

export type HistoricalActionVerb =
  | "created"
  | "updated"
  | "deleted"
  | "sent"
  | "opened"
  | "executed";

export interface HistoricalActionPredicate {
  kind: "historical_action";
  actionVerb: HistoricalActionVerb;
  subjectType: string;
  targetType: string;
  capabilityId: string;
  requiredReceiptType: string;
  subjectId?: string;
  targetId?: string;
}

export interface TestResultPredicate {
  kind: "test_result";
  capabilityId: string;
  expectedStatus: "passed" | "failed";
  requiredReceiptType: "test_run";
  testSuiteId?: string;
}

export type CurrentStateOperator = "equals" | "not_equals" | "contains";

export interface CurrentStatePredicate {
  kind: "current_state";
  subjectType: string;
  subjectId: string;
  property: string;
  operator: CurrentStateOperator;
  expectedValue: string | number | boolean;
  observationType: string;
  freshnessRequirementMs: number;
}
