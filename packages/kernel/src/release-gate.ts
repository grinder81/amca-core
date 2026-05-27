import type {
  BlockedDecision,
  Claim,
  FinalCandidate,
  Mismatch,
  NeedsRepairDecision,
  ProofObject,
  QuarantineReason,
  QuarantinedDecision,
  ReleasedDecision,
  ReleaseDecision,
} from "@amca/protocol";

const inconsistentProofMismatchId = "release_gate_inconsistent_proof";

export interface ReleaseGateInput {
  readonly candidate: FinalCandidate;
  readonly proof: ProofObject;
}

export function decideRelease(input: ReleaseGateInput): ReleaseDecision {
  const blockingMismatchIds = blockingMismatchIdsForDecision(input.proof);

  if (blockingMismatchIds.length > 0) {
    return decideBlockedRelease(input.proof, blockingMismatchIds);
  }

  switch (input.proof.verdict) {
    case "pass":
      return releasedDecision(input);
    case "fail":
      return blockedDecision(input.proof, blockingMismatchIds);
    case "needs_repair":
      return needsRepairDecision(input.proof, blockingMismatchIds);
    case "quarantine":
      return quarantinedDecision(input.proof, blockingMismatchIds);
  }
}

export function renderApprovedClaims(
  candidate: FinalCandidate,
  approvedClaimIds: readonly string[],
): string | undefined {
  const approvedClaimIdSet = new Set(approvedClaimIds);
  const renderedClaims = candidate.claims
    .filter((claim) => approvedClaimIdSet.has(claim.claimId))
    .map(renderApprovedClaimPredicate);

  if (renderedClaims.length === 0) {
    return undefined;
  }

  return renderedClaims.join("\n");
}

function decideBlockedRelease(
  proof: ProofObject,
  blockingMismatchIds: string[],
): ReleaseDecision {
  switch (proof.verdict) {
    case "pass":
    case "fail":
      return blockedDecision(proof, blockingMismatchIds);
    case "needs_repair":
      return needsRepairDecision(proof, blockingMismatchIds);
    case "quarantine":
      return quarantinedDecision(proof, blockingMismatchIds);
  }
}

function releasedDecision(input: ReleaseGateInput): ReleasedDecision {
  const renderedFinalMessage = renderApprovedClaims(
    input.candidate,
    input.proof.approvedClaimIds,
  );

  const decision: ReleasedDecision = {
    status: "released",
    runId: input.proof.runId,
    proofId: input.proof.proofId,
    approvedClaimIds: [...input.proof.approvedClaimIds],
    blockingMismatchIds: [],
  };

  if (renderedFinalMessage !== undefined) {
    decision.finalMessage = renderedFinalMessage;
  }

  return decision;
}

function blockedDecision(
  proof: ProofObject,
  blockingMismatchIds: string[],
): BlockedDecision {
  return {
    status: "blocked",
    runId: proof.runId,
    proofId: proof.proofId,
    approvedClaimIds: [...proof.approvedClaimIds],
    blockingMismatchIds,
    repairHints: repairMessages(proof),
  };
}

function needsRepairDecision(
  proof: ProofObject,
  blockingMismatchIds: string[],
): NeedsRepairDecision {
  return {
    status: "needs_repair",
    runId: proof.runId,
    proofId: proof.proofId,
    approvedClaimIds: [...proof.approvedClaimIds],
    blockingMismatchIds,
    repairInstructions: repairMessages(proof),
  };
}

function quarantinedDecision(
  proof: ProofObject,
  blockingMismatchIds: string[],
): QuarantinedDecision {
  return {
    status: "quarantined",
    runId: proof.runId,
    proofId: proof.proofId,
    approvedClaimIds: [...proof.approvedClaimIds],
    blockingMismatchIds,
    reason: quarantineReason(proof),
  };
}

function repairMessages(proof: ProofObject): string[] {
  const messages = blockingMismatches(proof).map((mismatch) => {
    const claimPrefix =
      mismatch.claimId === undefined ? "" : ` for claim ${mismatch.claimId}`;

    return `Resolve ${mismatch.type} mismatch ${mismatch.mismatchId}${claimPrefix}: ${mismatch.message}`;
  });

  if (messages.length > 0) {
    return messages;
  }

  return [
    `Resolve proof ${proof.proofId}: proof verdict ${proof.verdict} did not provide a blocking mismatch.`,
  ];
}

function quarantineReason(proof: ProofObject): QuarantineReason {
  if (
    blockingMismatches(proof).some(
      (mismatch) => mismatch.type === "uncertain_external_effect",
    )
  ) {
    return "uncertain_external_effect";
  }

  return "inconsistent_evidence";
}

function blockingMismatches(proof: ProofObject): Mismatch[] {
  return proof.blockingMismatches.filter((mismatch) => mismatch.blocking);
}

function blockingMismatchIdsForDecision(proof: ProofObject): string[] {
  const mismatchIds = blockingMismatches(proof).map(
    (mismatch) => mismatch.mismatchId,
  );

  if (mismatchIds.length > 0 || proof.verdict === "pass") {
    return mismatchIds;
  }

  return [inconsistentProofMismatchId];
}

function renderApprovedClaimPredicate(claim: Claim): string {
  switch (claim.predicate.kind) {
    case "test_result":
      return renderTestResultClaim(claim);
    case "historical_action":
      return renderHistoricalActionClaim(claim);
    case "current_state":
      return renderCurrentStateClaim(claim);
  }
}

function renderTestResultClaim(claim: Claim): string {
  if (claim.predicate.kind !== "test_result") {
    return "Unsupported test-result claim.";
  }

  const status =
    claim.predicate.expectedStatus === "passed" ? "passed" : "failed";

  if (claim.predicate.testSuiteId !== undefined) {
    return `Test suite ${claim.predicate.testSuiteId} ${status}.`;
  }

  return `Tests ${status}.`;
}

function renderHistoricalActionClaim(claim: Claim): string {
  if (claim.predicate.kind !== "historical_action") {
    return "Unsupported historical-action claim.";
  }

  const target = renderEntity(
    claim.predicate.targetType,
    claim.predicate.targetId,
  );

  return `${target} was ${claim.predicate.actionVerb}.`;
}

function renderCurrentStateClaim(claim: Claim): string {
  if (claim.predicate.kind !== "current_state") {
    return "Unsupported current-state claim.";
  }

  const subject = renderEntity(
    claim.predicate.subjectType,
    claim.predicate.subjectId,
  );
  const expectedValue = renderValue(claim.predicate.expectedValue);

  if (
    claim.predicate.property === "state" &&
    claim.predicate.operator === "equals"
  ) {
    return `${subject} is currently ${expectedValue}.`;
  }

  return `${subject} ${renderProperty(
    claim.predicate.property,
  )} ${renderOperator(claim.predicate.operator)} ${expectedValue}.`;
}

function renderEntity(type: string, id?: string): string {
  const label = sentenceCase(type.replace(/[_-]+/gu, " "));

  if (id === undefined || id.trim().length === 0) {
    return label;
  }

  return `${label} ${id}`;
}

function renderProperty(property: string): string {
  return property.replace(/[_-]+/gu, " ");
}

function renderOperator(
  operator: "contains" | "equals" | "not_equals",
): string {
  switch (operator) {
    case "equals":
      return "equals";
    case "not_equals":
      return "does not equal";
    case "contains":
      return "contains";
  }
}

function renderValue(value: string | number | boolean): string {
  return String(value);
}

function sentenceCase(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
