import type {
  Claim,
  ClaimProof,
  CurrentStateOperator,
  CurrentStatePredicate,
  EffectReceipt,
  EvidenceRef,
  ExternalStateObservation,
  FinalCandidate,
  HistoricalActionPredicate,
  ISODateTimeString,
  JsonObject,
  JsonValue,
  Mismatch,
  ProofObject,
  TestResultPredicate,
} from "@amca/protocol";
import { canonicalObjectHash } from "@amca/contracts";

import {
  filterEvidenceRefsByKind,
  resolveEffectReceipts,
  resolveExternalStateObservations,
} from "./evidence-resolver.js";
import { buildBlockingMismatch, buildMismatchId } from "./mismatch-builder.js";

export interface ProofEvaluationInput {
  readonly candidate: FinalCandidate;
  readonly effectReceipts: readonly EffectReceipt[];
  readonly externalStateObservations: readonly ExternalStateObservation[];
  readonly generatedAt: ISODateTimeString;
  readonly proofId?: string;
}

interface ClaimEvaluation {
  readonly claimProof: ClaimProof;
  readonly mismatches: readonly Mismatch[];
}

export function evaluateProof(input: ProofEvaluationInput): ProofObject {
  const evaluations = input.candidate.claims.map((claim, index) =>
    evaluateClaim(input, claim, index),
  );
  const blockingMismatches = evaluations.flatMap((evaluation) =>
    evaluation.mismatches.filter((mismatch) => mismatch.blocking),
  );
  const claimProofs = evaluations.map((evaluation) => evaluation.claimProof);
  const approvedClaimIds = claimProofs
    .filter((claimProof) => claimProof.supported)
    .map((claimProof) => claimProof.claimId);
  const rejectedClaimIds = claimProofs
    .filter((claimProof) => !claimProof.supported)
    .map((claimProof) => claimProof.claimId);

  return {
    proofId: input.proofId ?? buildProofId(input.candidate, input.generatedAt),
    runId: input.candidate.runId,
    candidateId: input.candidate.candidateId,
    generatedAt: input.generatedAt,
    verdict: blockingMismatches.length === 0 ? "pass" : "fail",
    claims: claimProofs,
    approvedClaimIds,
    rejectedClaimIds,
    blockingMismatches,
    evaluatedClaims: input.candidate.claims,
  };
}

function evaluateClaim(
  input: ProofEvaluationInput,
  claim: Claim,
  claimIndex: number,
): ClaimEvaluation {
  if (claim.type !== claim.predicate.kind) {
    return unsupportedClaim(
      input,
      claim,
      claimIndex,
      "Claim type does not match predicate kind.",
      {
        type: claim.type,
        predicateKind: claim.predicate.kind,
      },
    );
  }

  switch (claim.predicate.kind) {
    case "historical_action":
      return evaluateHistoricalActionClaim(
        input,
        claim,
        claim.predicate,
        claimIndex,
      );
    case "test_result":
      return evaluateTestResultClaim(input, claim, claim.predicate, claimIndex);
    case "current_state":
      return evaluateCurrentStateClaim(
        input,
        claim,
        claim.predicate,
        claimIndex,
      );
  }
}

function evaluateTestResultClaim(
  input: ProofEvaluationInput,
  claim: Claim,
  predicate: TestResultPredicate,
  claimIndex: number,
): ClaimEvaluation {
  const evidenceRefs = filterEvidenceRefsByKind(
    claim.evidenceRefs,
    "effect_receipt",
  );

  if (evidenceRefs.length === 0) {
    return missingEvidence(input, claim, claimIndex, "effect_receipt");
  }

  const resolvedReceipts = resolveEffectReceipts(
    evidenceRefs,
    admittedEffectReceipts(input),
  );

  if (resolvedReceipts.length === 0) {
    return unverifiedReceipt(input, claim, claimIndex, evidenceRefs);
  }

  if (resolvedReceipts.some(({ receipt }) => receipt.status !== "succeeded")) {
    return unverifiedReceipt(input, claim, claimIndex, evidenceRefs);
  }

  const match = resolvedReceipts.find(({ receipt }) =>
    testResultReceiptMatches(receipt, predicate),
  );

  if (match === undefined) {
    return unsupportedClaim(
      input,
      claim,
      claimIndex,
      "No referenced effect receipt supports the test-result predicate.",
      {
        expectedReceiptType: predicate.requiredReceiptType,
        expectedCapabilityId: predicate.capabilityId,
        expectedStatus: predicate.expectedStatus,
        ...(predicate.testSuiteId === undefined
          ? {}
          : { expectedTestSuiteId: predicate.testSuiteId }),
      },
    );
  }

  return supportedClaim(claim, [match.claimEvidenceRef]);
}

function evaluateHistoricalActionClaim(
  input: ProofEvaluationInput,
  claim: Claim,
  predicate: HistoricalActionPredicate,
  claimIndex: number,
): ClaimEvaluation {
  const evidenceRefs = filterEvidenceRefsByKind(
    claim.evidenceRefs,
    "effect_receipt",
  );

  if (evidenceRefs.length === 0) {
    return missingEvidence(input, claim, claimIndex, "effect_receipt");
  }

  const resolvedReceipts = resolveEffectReceipts(
    evidenceRefs,
    admittedEffectReceipts(input),
  );

  if (resolvedReceipts.length === 0) {
    return unverifiedReceipt(input, claim, claimIndex, evidenceRefs);
  }

  if (resolvedReceipts.some(({ receipt }) => receipt.status !== "succeeded")) {
    return unverifiedReceipt(input, claim, claimIndex, evidenceRefs);
  }

  const match = resolvedReceipts.find(({ receipt }) =>
    historicalActionReceiptMatches(receipt, predicate),
  );

  if (match === undefined) {
    return unsupportedClaim(
      input,
      claim,
      claimIndex,
      "No referenced effect receipt supports the historical-action predicate.",
      {
        expectedReceiptType: predicate.requiredReceiptType,
        expectedCapabilityId: predicate.capabilityId,
        expectedActionVerb: predicate.actionVerb,
        expectedSubjectType: predicate.subjectType,
        expectedTargetType: predicate.targetType,
        ...(predicate.subjectId === undefined
          ? {}
          : { expectedSubjectId: predicate.subjectId }),
        ...(predicate.targetId === undefined
          ? {}
          : { expectedTargetId: predicate.targetId }),
      },
    );
  }

  return supportedClaim(claim, [match.claimEvidenceRef]);
}

function evaluateCurrentStateClaim(
  input: ProofEvaluationInput,
  claim: Claim,
  predicate: CurrentStatePredicate,
  claimIndex: number,
): ClaimEvaluation {
  const evidenceRefs = filterEvidenceRefsByKind(
    claim.evidenceRefs,
    "external_observation",
  );

  if (evidenceRefs.length === 0) {
    return missingEvidence(input, claim, claimIndex, "external_observation");
  }

  const resolvedObservations = resolveExternalStateObservations(
    evidenceRefs,
    admittedExternalStateObservations(input),
  );

  if (resolvedObservations.length === 0) {
    return unsupportedClaim(
      input,
      claim,
      claimIndex,
      "No external state observation can be resolved for the referenced evidence.",
      {
        expectedEvidenceKind: "external_observation",
      },
    );
  }

  const identityMatches = resolvedObservations.filter(({ observation }) =>
    currentStateIdentityMatches(observation, predicate),
  );

  if (identityMatches.length === 0) {
    return unsupportedClaim(
      input,
      claim,
      claimIndex,
      "No referenced external state observation matches the current-state subject.",
      {
        observationType: predicate.observationType,
        subjectType: predicate.subjectType,
        subjectId: predicate.subjectId,
      },
    );
  }

  const freshMatches = identityMatches.filter(({ observation }) =>
    observationIsFresh(
      observation,
      predicate.freshnessRequirementMs,
      input.generatedAt,
    ),
  );

  if (freshMatches.length === 0) {
    return staleExternalState(input, claim, predicate, claimIndex);
  }

  const match = freshMatches.find(({ observation }) =>
    observedStateSatisfiesPredicate(observation, predicate),
  );

  if (match === undefined) {
    return unsupportedClaim(
      input,
      claim,
      claimIndex,
      "No fresh external state observation satisfies the current-state predicate.",
      {
        property: predicate.property,
        operator: predicate.operator,
        expectedValue: predicate.expectedValue,
      },
    );
  }

  return supportedClaim(claim, [match.claimEvidenceRef]);
}

function supportedClaim(
  claim: Claim,
  evidenceRefs: readonly EvidenceRef[],
): ClaimEvaluation {
  return {
    claimProof: {
      claimId: claim.claimId,
      supported: true,
      evidenceRefs: [...evidenceRefs],
      mismatchIds: [],
    },
    mismatches: [],
  };
}

function missingEvidence(
  input: ProofEvaluationInput,
  claim: Claim,
  claimIndex: number,
  evidenceKind: "effect_receipt" | "external_observation",
): ClaimEvaluation {
  const mismatch = buildBlockingMismatch({
    mismatchId: buildMismatchId(claim.claimId, "missing_evidence", claimIndex),
    runId: input.candidate.runId,
    type: "missing_evidence",
    claimId: claim.claimId,
    message: `Claim is missing required ${evidenceKind} evidence.`,
    expected: {
      evidenceKind,
      minimumCount: 1,
    },
    actual: {
      evidenceRefs: claim.evidenceRefs.length,
    },
  });

  return rejectedClaim(claim, [mismatch]);
}

function unverifiedReceipt(
  input: ProofEvaluationInput,
  claim: Claim,
  claimIndex: number,
  evidenceRefs: readonly EvidenceRef[],
): ClaimEvaluation {
  const mismatch = buildBlockingMismatch({
    mismatchId: buildMismatchId(
      claim.claimId,
      "unverified_receipt",
      claimIndex,
    ),
    runId: input.candidate.runId,
    type: "unverified_receipt",
    claimId: claim.claimId,
    message: "Claim references effect receipt evidence that was not resolved.",
    expected: {
      evidenceKind: "effect_receipt",
      evidenceIds: evidenceRefs.map((evidenceRef) => evidenceRef.evidenceId),
    },
    actual: {
      resolvedReceipts: 0,
    },
  });

  return rejectedClaim(claim, [mismatch]);
}

function unsupportedClaim(
  input: ProofEvaluationInput,
  claim: Claim,
  claimIndex: number,
  message: string,
  expected?: JsonObject,
): ClaimEvaluation {
  const mismatch = buildBlockingMismatch({
    mismatchId: buildMismatchId(claim.claimId, "unsupported_claim", claimIndex),
    runId: input.candidate.runId,
    type: "unsupported_claim",
    claimId: claim.claimId,
    message,
    ...(expected === undefined ? {} : { expected }),
  });

  return rejectedClaim(claim, [mismatch]);
}

function staleExternalState(
  input: ProofEvaluationInput,
  claim: Claim,
  predicate: CurrentStatePredicate,
  claimIndex: number,
): ClaimEvaluation {
  const mismatch = buildBlockingMismatch({
    mismatchId: buildMismatchId(
      claim.claimId,
      "stale_external_state",
      claimIndex,
    ),
    runId: input.candidate.runId,
    type: "stale_external_state",
    claimId: claim.claimId,
    message: "External state observation is stale for the current-state claim.",
    expected: {
      freshnessRequirementMs: predicate.freshnessRequirementMs,
      generatedAt: input.generatedAt,
    },
  });

  return rejectedClaim(claim, [mismatch]);
}

function rejectedClaim(
  claim: Claim,
  mismatches: readonly Mismatch[],
): ClaimEvaluation {
  return {
    claimProof: {
      claimId: claim.claimId,
      supported: false,
      evidenceRefs: [],
      mismatchIds: mismatches.map((mismatch) => mismatch.mismatchId),
    },
    mismatches,
  };
}

function testResultReceiptMatches(
  receipt: EffectReceipt,
  predicate: TestResultPredicate,
): boolean {
  return (
    receipt.receiptType === predicate.requiredReceiptType &&
    receipt.status === "succeeded" &&
    receipt.capabilityId === predicate.capabilityId &&
    receipt.payload.result === predicate.expectedStatus &&
    optionalPayloadFieldMatches(receipt, "testSuiteId", predicate.testSuiteId)
  );
}

function admittedEffectReceipts(
  input: ProofEvaluationInput,
): readonly EffectReceipt[] {
  return input.effectReceipts.filter(
    (receipt) =>
      receipt.runId === input.candidate.runId &&
      receipt.payloadHash === canonicalObjectHash(receipt.payload) &&
      receipt.evidence.every(
        (evidenceRef) =>
          evidenceRef.kind === "effect_receipt" &&
          evidenceRef.hash === receipt.payloadHash,
      ),
  );
}

function admittedExternalStateObservations(
  input: ProofEvaluationInput,
): readonly ExternalStateObservation[] {
  return input.externalStateObservations.filter(
    (observation) =>
      observation.runId === input.candidate.runId &&
      observation.payloadHash ===
        canonicalObjectHash(observation.observedState) &&
      observation.evidence.every(
        (evidenceRef) =>
          evidenceRef.kind === "external_observation" &&
          evidenceRef.hash === observation.payloadHash,
      ),
  );
}

function historicalActionReceiptMatches(
  receipt: EffectReceipt,
  predicate: HistoricalActionPredicate,
): boolean {
  return (
    receipt.receiptType === predicate.requiredReceiptType &&
    receipt.status === "succeeded" &&
    receipt.capabilityId === predicate.capabilityId &&
    receipt.payload.actionVerb === predicate.actionVerb &&
    receipt.payload.subjectType === predicate.subjectType &&
    receipt.payload.targetType === predicate.targetType &&
    optionalPayloadFieldMatches(receipt, "subjectId", predicate.subjectId) &&
    optionalPayloadFieldMatches(receipt, "targetId", predicate.targetId)
  );
}

function optionalPayloadFieldMatches(
  receipt: EffectReceipt,
  field: string,
  expected: string | undefined,
): boolean {
  if (expected === undefined) {
    return true;
  }

  return receipt.payload[field] === expected;
}

function currentStateIdentityMatches(
  observation: ExternalStateObservation,
  predicate: CurrentStatePredicate,
): boolean {
  return (
    observation.observationType === predicate.observationType &&
    observation.subjectType === predicate.subjectType &&
    observation.subjectId === predicate.subjectId
  );
}

function observationIsFresh(
  observation: ExternalStateObservation,
  freshnessRequirementMs: number,
  generatedAt: ISODateTimeString,
): boolean {
  const observedAtMs = Date.parse(observation.observedAt);
  const generatedAtMs = Date.parse(generatedAt);

  if (!Number.isFinite(observedAtMs) || !Number.isFinite(generatedAtMs)) {
    return false;
  }

  const ageMs = generatedAtMs - observedAtMs;

  return ageMs >= 0 && ageMs <= freshnessRequirementMs;
}

function observedStateSatisfiesPredicate(
  observation: ExternalStateObservation,
  predicate: CurrentStatePredicate,
): boolean {
  const observedValue = observation.observedState[predicate.property];

  if (observedValue === undefined) {
    return false;
  }

  return observedValueSatisfies(
    observedValue,
    predicate.operator,
    predicate.expectedValue,
  );
}

function observedValueSatisfies(
  observedValue: JsonValue,
  operator: CurrentStateOperator,
  expectedValue: string | number | boolean,
): boolean {
  switch (operator) {
    case "equals":
      return (
        observedValueIsComparablePrimitive(observedValue) &&
        observedValue === expectedValue
      );
    case "not_equals":
      return (
        observedValueIsComparablePrimitive(observedValue) &&
        observedValue !== expectedValue
      );
    case "contains":
      return observedValueContains(observedValue, expectedValue);
  }
}

function observedValueIsComparablePrimitive(
  observedValue: JsonValue,
): observedValue is string | number | boolean {
  return (
    typeof observedValue === "string" ||
    typeof observedValue === "number" ||
    typeof observedValue === "boolean"
  );
}

function observedValueContains(
  observedValue: JsonValue,
  expectedValue: string | number | boolean,
): boolean {
  if (typeof observedValue === "string" && typeof expectedValue === "string") {
    return observedValue.includes(expectedValue);
  }

  if (Array.isArray(observedValue)) {
    return observedValue.some((item) => item === expectedValue);
  }

  return false;
}

function buildProofId(
  candidate: FinalCandidate,
  generatedAt: ISODateTimeString,
): string {
  return `proof_${sanitizeIdPart(candidate.runId)}_${sanitizeIdPart(
    candidate.candidateId,
  )}_${sanitizeIdPart(generatedAt)}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
