import type {
  Claim,
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  ExternalStateObservation,
  FinalCandidate,
  Mismatch,
  ProofObject,
  ReleaseDecision,
  RunEvent,
  ToolCommandRequest,
} from "@amca/protocol";
import { hashRunEventPayload } from "@amca/kernel";

import type { ScenarioFixture, ScenarioId } from "./scenarios.js";

const staticRuntimeScope = {
  requiresRuntimeBehavior: false,
  implementsProofBehavior: false,
  implementsKernelBehavior: false,
  implementsCliBehavior: false,
} satisfies ScenarioFixture["runtimeScope"];

function withEventPayloadHashes(events: readonly RunEvent[]): RunEvent[] {
  return events.map((event) => ({
    ...event,
    payloadHash: hashRunEventPayload(event.payload),
  }));
}

const testsPassedBlockedToolCommand: ToolCommandRequest = {
  kind: "tool_command_request",
  commandId: "cmd_tests_passed_blocked",
  runId: "run_tests_passed_blocked",
  capabilityId: "test.runner",
  toolId: "pnpm.test",
  args: {
    command: "pnpm test",
    testSuiteId: "unit",
  },
  sideEffectClass: "compute",
  idempotencyKey: "idem_tests_passed_blocked",
};

const testsPassedBlockedEffectRequest: EffectRequest = {
  effectId: "effect_tests_passed_blocked",
  commandId: testsPassedBlockedToolCommand.commandId,
  runId: testsPassedBlockedToolCommand.runId,
  capabilityId: testsPassedBlockedToolCommand.capabilityId,
  toolId: testsPassedBlockedToolCommand.toolId,
  args: testsPassedBlockedToolCommand.args,
  sideEffectClass: testsPassedBlockedToolCommand.sideEffectClass,
  requestedAt: "2026-05-24T18:00:01.000Z",
  idempotencyKey: "idem_tests_passed_blocked",
};

const testsPassedBlockedClaim: Claim = {
  claimId: "claim_tests_passed_blocked",
  type: "test_result",
  statement: "The unit test suite passed.",
  predicate: {
    kind: "test_result",
    capabilityId: testsPassedBlockedToolCommand.capabilityId,
    expectedStatus: "passed",
    requiredReceiptType: "test_run",
    testSuiteId: "unit",
  },
  evidenceRefs: [],
  criticality: "high",
};

const testsPassedBlockedFinalCandidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_tests_passed_blocked",
  runId: testsPassedBlockedToolCommand.runId,
  claims: [testsPassedBlockedClaim],
  narrativeDraft: "The unit test suite passed.",
};

const testsPassedBlockedMismatch: Mismatch = {
  mismatchId: "mismatch_tests_passed_missing_receipt",
  runId: testsPassedBlockedToolCommand.runId,
  type: "missing_evidence",
  blocking: true,
  message:
    "The test_result claim has no first-class test_run receipt evidence.",
  claimId: testsPassedBlockedClaim.claimId,
  expected: "test_run receipt with status succeeded",
  actual: "no evidenceRefs",
};

const testsPassedBlockedProof: ProofObject = {
  proofId: "proof_tests_passed_blocked",
  runId: testsPassedBlockedToolCommand.runId,
  candidateId: testsPassedBlockedFinalCandidate.candidateId,
  generatedAt: "2026-05-24T18:00:03.000Z",
  verdict: "fail",
  claims: [
    {
      claimId: testsPassedBlockedClaim.claimId,
      supported: false,
      evidenceRefs: [],
      mismatchIds: [testsPassedBlockedMismatch.mismatchId],
    },
  ],
  approvedClaimIds: [],
  rejectedClaimIds: [testsPassedBlockedClaim.claimId],
  blockingMismatches: [testsPassedBlockedMismatch],
  evaluatedClaims: [testsPassedBlockedClaim],
};

const testsPassedBlockedReleaseDecision: ReleaseDecision = {
  status: "blocked",
  runId: testsPassedBlockedToolCommand.runId,
  proofId: testsPassedBlockedProof.proofId,
  approvedClaimIds: [],
  blockingMismatchIds: [testsPassedBlockedMismatch.mismatchId],
  repairHints: [
    "Record a succeeded test_run receipt before releasing the claim.",
  ],
};

const testsPassedBlockedRunEvents: RunEvent[] = [
  {
    eventId: "evt_tests_passed_blocked_run_started",
    runId: testsPassedBlockedToolCommand.runId,
    sequence: 1,
    type: "RunStarted",
    payload: {
      runId: testsPassedBlockedToolCommand.runId,
      profile: "standard",
      metadata: {
        scenarioId: "tests-passed-blocked",
      },
    },
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    causationId: null,
    correlationId: "corr_tests_passed_blocked",
    occurredAt: "2026-05-24T18:00:00.000Z",
  },
  {
    eventId: "evt_tests_passed_blocked_tool_proposed",
    runId: testsPassedBlockedToolCommand.runId,
    sequence: 2,
    type: "ProposalReceived",
    payload: {
      proposal: testsPassedBlockedToolCommand,
    },
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111112",
    causationId: "evt_tests_passed_blocked_run_started",
    correlationId: "corr_tests_passed_blocked",
    occurredAt: "2026-05-24T18:00:00.500Z",
  },
  {
    eventId: "evt_tests_passed_blocked_effect_requested",
    runId: testsPassedBlockedToolCommand.runId,
    sequence: 3,
    type: "EffectRequested",
    payload: {
      effectRequest: testsPassedBlockedEffectRequest,
    },
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111113",
    causationId: "evt_tests_passed_blocked_tool_proposed",
    correlationId: "corr_tests_passed_blocked",
    occurredAt: testsPassedBlockedEffectRequest.requestedAt,
  },
  {
    eventId: "evt_tests_passed_blocked_final_proposed",
    runId: testsPassedBlockedToolCommand.runId,
    sequence: 4,
    type: "ProposalReceived",
    payload: {
      proposal: testsPassedBlockedFinalCandidate,
    },
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111114",
    causationId: "evt_tests_passed_blocked_effect_requested",
    correlationId: "corr_tests_passed_blocked",
    occurredAt: "2026-05-24T18:00:02.000Z",
  },
];

const testsPassedBlockedExpectedEvents: RunEvent[] = [
  {
    eventId: "evt_tests_passed_blocked_proof_generated",
    runId: testsPassedBlockedToolCommand.runId,
    sequence: 5,
    type: "ProofGenerated",
    payload: {
      proof: testsPassedBlockedProof,
    },
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111115",
    causationId: "evt_tests_passed_blocked_final_proposed",
    correlationId: "corr_tests_passed_blocked",
    occurredAt: testsPassedBlockedProof.generatedAt,
  },
  {
    eventId: "evt_tests_passed_blocked_mismatch_detected",
    runId: testsPassedBlockedToolCommand.runId,
    sequence: 6,
    type: "MismatchDetected",
    payload: {
      mismatch: testsPassedBlockedMismatch,
    },
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111116",
    causationId: "evt_tests_passed_blocked_proof_generated",
    correlationId: "corr_tests_passed_blocked",
    occurredAt: "2026-05-24T18:00:03.100Z",
  },
  {
    eventId: "evt_tests_passed_blocked_release_decided",
    runId: testsPassedBlockedToolCommand.runId,
    sequence: 7,
    type: "ReleaseDecided",
    payload: {
      decision: testsPassedBlockedReleaseDecision,
    },
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111117",
    causationId: "evt_tests_passed_blocked_proof_generated",
    correlationId: "corr_tests_passed_blocked",
    occurredAt: "2026-05-24T18:00:03.200Z",
  },
];

const testsPassedReleasedReceiptEvidence: EvidenceRef = {
  evidenceId: "ev_tests_passed_released_receipt",
  kind: "effect_receipt",
  sourceEventId: "evt_tests_passed_released_receipt_recorded",
  hash: "sha256:3950821da56952d3700fae082acfae718d40c868cfc4983eafad23974c678a29",
  observedAt: "2026-05-24T18:05:02.000Z",
  sensitivity: "internal",
  artifactUri: "artifact://amca/tests/tests-passed-released",
  metadata: {
    testSuiteId: "unit",
  },
};

const testsPassedReleasedToolCommand: ToolCommandRequest = {
  kind: "tool_command_request",
  commandId: "cmd_tests_passed_released",
  runId: "run_tests_passed_released",
  capabilityId: "test.runner",
  toolId: "pnpm.test",
  args: {
    command: "pnpm test",
    testSuiteId: "unit",
  },
  sideEffectClass: "compute",
  idempotencyKey: "idem_tests_passed_released",
};

const testsPassedReleasedEffectRequest: EffectRequest = {
  effectId: "effect_tests_passed_released",
  commandId: testsPassedReleasedToolCommand.commandId,
  runId: testsPassedReleasedToolCommand.runId,
  capabilityId: testsPassedReleasedToolCommand.capabilityId,
  toolId: testsPassedReleasedToolCommand.toolId,
  args: testsPassedReleasedToolCommand.args,
  sideEffectClass: testsPassedReleasedToolCommand.sideEffectClass,
  requestedAt: "2026-05-24T18:05:01.000Z",
  idempotencyKey: "idem_tests_passed_released",
};

const testsPassedReleasedEffectReceipt: EffectReceipt = {
  receiptId: "receipt_tests_passed_released",
  effectId: testsPassedReleasedEffectRequest.effectId,
  runId: testsPassedReleasedToolCommand.runId,
  capabilityId: testsPassedReleasedToolCommand.capabilityId,
  receiptType: "test_run",
  status: "succeeded",
  payload: {
    testSuiteId: "unit",
    result: "passed",
    passed: 42,
    failed: 0,
  },
  payloadHash:
    "sha256:3950821da56952d3700fae082acfae718d40c868cfc4983eafad23974c678a29",
  evidence: [testsPassedReleasedReceiptEvidence],
  observedAt: testsPassedReleasedReceiptEvidence.observedAt,
  externalRef: "artifact://amca/tests/tests-passed-released/results.json",
};

const testsPassedReleasedClaim: Claim = {
  claimId: "claim_tests_passed_released",
  type: "test_result",
  statement: "The unit test suite passed.",
  predicate: {
    kind: "test_result",
    capabilityId: testsPassedReleasedToolCommand.capabilityId,
    expectedStatus: "passed",
    requiredReceiptType: "test_run",
    testSuiteId: "unit",
  },
  evidenceRefs: [testsPassedReleasedReceiptEvidence],
  criticality: "high",
};

const testsPassedReleasedFinalCandidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_tests_passed_released",
  runId: testsPassedReleasedToolCommand.runId,
  claims: [testsPassedReleasedClaim],
  narrativeDraft: "The unit test suite passed.",
};

const testsPassedReleasedProof: ProofObject = {
  proofId: "proof_tests_passed_released",
  runId: testsPassedReleasedToolCommand.runId,
  candidateId: testsPassedReleasedFinalCandidate.candidateId,
  generatedAt: "2026-05-24T18:05:03.000Z",
  verdict: "pass",
  claims: [
    {
      claimId: testsPassedReleasedClaim.claimId,
      supported: true,
      evidenceRefs: [testsPassedReleasedReceiptEvidence],
      mismatchIds: [],
    },
  ],
  approvedClaimIds: [testsPassedReleasedClaim.claimId],
  rejectedClaimIds: [],
  blockingMismatches: [],
  evaluatedClaims: [testsPassedReleasedClaim],
};

const testsPassedReleasedReleaseDecision: ReleaseDecision = {
  status: "released",
  runId: testsPassedReleasedToolCommand.runId,
  proofId: testsPassedReleasedProof.proofId,
  approvedClaimIds: [testsPassedReleasedClaim.claimId],
  blockingMismatchIds: [],
  finalMessage: "Test suite unit passed.",
};

const testsPassedReleasedRunEvents: RunEvent[] = [
  {
    eventId: "evt_tests_passed_released_run_started",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 1,
    type: "RunStarted",
    payload: {
      runId: testsPassedReleasedToolCommand.runId,
      profile: "standard",
      metadata: {
        scenarioId: "tests-passed-released",
      },
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222223",
    causationId: null,
    correlationId: "corr_tests_passed_released",
    occurredAt: "2026-05-24T18:05:00.000Z",
  },
  {
    eventId: "evt_tests_passed_released_tool_proposed",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 2,
    type: "ProposalReceived",
    payload: {
      proposal: testsPassedReleasedToolCommand,
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222224",
    causationId: "evt_tests_passed_released_run_started",
    correlationId: "corr_tests_passed_released",
    occurredAt: "2026-05-24T18:05:00.500Z",
  },
  {
    eventId: "evt_tests_passed_released_effect_requested",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 3,
    type: "EffectRequested",
    payload: {
      effectRequest: testsPassedReleasedEffectRequest,
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222225",
    causationId: "evt_tests_passed_released_tool_proposed",
    correlationId: "corr_tests_passed_released",
    occurredAt: testsPassedReleasedEffectRequest.requestedAt,
  },
  {
    eventId: "evt_tests_passed_released_receipt_recorded",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 4,
    type: "EffectReceiptRecorded",
    payload: {
      receipt: testsPassedReleasedEffectReceipt,
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222226",
    causationId: "evt_tests_passed_released_effect_requested",
    correlationId: "corr_tests_passed_released",
    occurredAt: testsPassedReleasedEffectReceipt.observedAt,
  },
  {
    eventId: "evt_tests_passed_released_final_proposed",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 5,
    type: "ProposalReceived",
    payload: {
      proposal: testsPassedReleasedFinalCandidate,
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222227",
    causationId: "evt_tests_passed_released_receipt_recorded",
    correlationId: "corr_tests_passed_released",
    occurredAt: "2026-05-24T18:05:02.500Z",
  },
];

const testsPassedReleasedExpectedEvents: RunEvent[] = [
  {
    eventId: "evt_tests_passed_released_proof_generated",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 6,
    type: "ProofGenerated",
    payload: {
      proof: testsPassedReleasedProof,
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222228",
    causationId: "evt_tests_passed_released_final_proposed",
    correlationId: "corr_tests_passed_released",
    occurredAt: testsPassedReleasedProof.generatedAt,
  },
  {
    eventId: "evt_tests_passed_released_release_decided",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 7,
    type: "ReleaseDecided",
    payload: {
      decision: testsPassedReleasedReleaseDecision,
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222229",
    causationId: "evt_tests_passed_released_proof_generated",
    correlationId: "corr_tests_passed_released",
    occurredAt: "2026-05-24T18:05:03.100Z",
  },
  {
    eventId: "evt_tests_passed_released_final_released",
    runId: testsPassedReleasedToolCommand.runId,
    sequence: 8,
    type: "FinalReleased",
    payload: {
      decision: testsPassedReleasedReleaseDecision,
      candidate: testsPassedReleasedFinalCandidate,
    },
    payloadHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222230",
    causationId: "evt_tests_passed_released_release_decided",
    correlationId: "corr_tests_passed_released",
    occurredAt: "2026-05-24T18:05:03.200Z",
  },
];

const statementPredicateMismatchReceiptEvidence: EvidenceRef = {
  ...testsPassedReleasedReceiptEvidence,
  evidenceId: "ev_statement_predicate_mismatch_receipt",
  sourceEventId: "evt_statement_predicate_mismatch_receipt_recorded",
  artifactUri: "artifact://amca/tests/statement-predicate-mismatch",
};

const statementPredicateMismatchToolCommand: ToolCommandRequest = {
  ...testsPassedReleasedToolCommand,
  commandId: "cmd_statement_predicate_mismatch",
  runId: "run_statement_predicate_mismatch",
  idempotencyKey: "idem_statement_predicate_mismatch",
};

const statementPredicateMismatchEffectRequest: EffectRequest = {
  ...testsPassedReleasedEffectRequest,
  effectId: "effect_statement_predicate_mismatch",
  commandId: statementPredicateMismatchToolCommand.commandId,
  runId: statementPredicateMismatchToolCommand.runId,
  idempotencyKey: "idem_statement_predicate_mismatch",
};

const statementPredicateMismatchEffectReceipt: EffectReceipt = {
  ...testsPassedReleasedEffectReceipt,
  receiptId: "receipt_statement_predicate_mismatch",
  effectId: statementPredicateMismatchEffectRequest.effectId,
  runId: statementPredicateMismatchToolCommand.runId,
  evidence: [statementPredicateMismatchReceiptEvidence],
  observedAt: statementPredicateMismatchReceiptEvidence.observedAt,
  externalRef:
    "artifact://amca/tests/statement-predicate-mismatch/results.json",
};

const statementPredicateMismatchClaim: Claim = {
  ...testsPassedReleasedClaim,
  claimId: "claim_statement_predicate_mismatch",
  statement: "I deployed the fix to production.",
  evidenceRefs: [statementPredicateMismatchReceiptEvidence],
};

const statementPredicateMismatchFinalCandidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_statement_predicate_mismatch",
  runId: statementPredicateMismatchToolCommand.runId,
  claims: [statementPredicateMismatchClaim],
  narrativeDraft: "I deployed the fix to production.",
};

const statementPredicateMismatchProof: ProofObject = {
  ...testsPassedReleasedProof,
  proofId: "proof_statement_predicate_mismatch",
  runId: statementPredicateMismatchToolCommand.runId,
  candidateId: statementPredicateMismatchFinalCandidate.candidateId,
  claims: [
    {
      claimId: statementPredicateMismatchClaim.claimId,
      supported: true,
      evidenceRefs: [statementPredicateMismatchReceiptEvidence],
      mismatchIds: [],
    },
  ],
  approvedClaimIds: [statementPredicateMismatchClaim.claimId],
  evaluatedClaims: [statementPredicateMismatchClaim],
};

const statementPredicateMismatchReleaseDecision: ReleaseDecision = {
  status: "released",
  runId: statementPredicateMismatchToolCommand.runId,
  proofId: statementPredicateMismatchProof.proofId,
  approvedClaimIds: [statementPredicateMismatchClaim.claimId],
  blockingMismatchIds: [],
  finalMessage: "Test suite unit passed.",
};

const statementPredicateMismatchRunEvents: RunEvent[] = [
  {
    eventId: "evt_statement_predicate_mismatch_run_started",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 1,
    type: "RunStarted",
    payload: {
      runId: statementPredicateMismatchToolCommand.runId,
      profile: "standard",
      metadata: {
        scenarioId: "statement-predicate-mismatch-blocked-or-safely-rendered",
      },
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777771",
    causationId: null,
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: "2026-05-24T18:06:00.000Z",
  },
  {
    eventId: "evt_statement_predicate_mismatch_tool_proposed",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 2,
    type: "ProposalReceived",
    payload: {
      proposal: statementPredicateMismatchToolCommand,
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777772",
    causationId: "evt_statement_predicate_mismatch_run_started",
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: "2026-05-24T18:06:00.500Z",
  },
  {
    eventId: "evt_statement_predicate_mismatch_effect_requested",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 3,
    type: "EffectRequested",
    payload: {
      effectRequest: statementPredicateMismatchEffectRequest,
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777773",
    causationId: "evt_statement_predicate_mismatch_tool_proposed",
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: statementPredicateMismatchEffectRequest.requestedAt,
  },
  {
    eventId: "evt_statement_predicate_mismatch_receipt_recorded",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 4,
    type: "EffectReceiptRecorded",
    payload: {
      receipt: statementPredicateMismatchEffectReceipt,
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777774",
    causationId: "evt_statement_predicate_mismatch_effect_requested",
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: statementPredicateMismatchEffectReceipt.observedAt,
  },
  {
    eventId: "evt_statement_predicate_mismatch_final_proposed",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 5,
    type: "ProposalReceived",
    payload: {
      proposal: statementPredicateMismatchFinalCandidate,
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777775",
    causationId: "evt_statement_predicate_mismatch_receipt_recorded",
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: "2026-05-24T18:06:02.500Z",
  },
];

const statementPredicateMismatchExpectedEvents: RunEvent[] = [
  {
    eventId: "evt_statement_predicate_mismatch_proof_generated",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 6,
    type: "ProofGenerated",
    payload: {
      proof: statementPredicateMismatchProof,
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777776",
    causationId: "evt_statement_predicate_mismatch_final_proposed",
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: statementPredicateMismatchProof.generatedAt,
  },
  {
    eventId: "evt_statement_predicate_mismatch_release_decided",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 7,
    type: "ReleaseDecided",
    payload: {
      decision: statementPredicateMismatchReleaseDecision,
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777777",
    causationId: "evt_statement_predicate_mismatch_proof_generated",
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: "2026-05-24T18:06:03.100Z",
  },
  {
    eventId: "evt_statement_predicate_mismatch_final_released",
    runId: statementPredicateMismatchToolCommand.runId,
    sequence: 8,
    type: "FinalReleased",
    payload: {
      decision: statementPredicateMismatchReleaseDecision,
      candidate: statementPredicateMismatchFinalCandidate,
    },
    payloadHash:
      "sha256:7777777777777777777777777777777777777777777777777777777777777778",
    causationId: "evt_statement_predicate_mismatch_release_decided",
    correlationId: "corr_statement_predicate_mismatch",
    occurredAt: "2026-05-24T18:06:03.200Z",
  },
];

const prOpenedBlockedReceiptEvidence: EvidenceRef = {
  evidenceId: "ev_pr_opened_blocked_receipt",
  kind: "effect_receipt",
  sourceEventId: "evt_pr_opened_blocked_receipt_recorded",
  hash: "sha256:ddc6db2b4512123e90503639794a28f4b674a958ed9c713c3fcbbcfb165cfa3d",
  observedAt: "2026-05-24T18:10:02.000Z",
  sensitivity: "internal",
  metadata: {
    targetId: "pr-214",
  },
};

const prOpenedBlockedToolCommand: ToolCommandRequest = {
  kind: "tool_command_request",
  commandId: "cmd_pr_opened_blocked",
  runId: "run_pr_opened_blocked",
  capabilityId: "vcs.pull_request.open",
  toolId: "vcs.openPullRequest",
  args: {
    repository: "amca",
    branch: "phase/testing-fixtures",
    targetBranch: "main",
    title: "AMCA testing fixtures",
  },
  sideEffectClass: "idempotent_write",
  idempotencyKey: "idem_pr_opened_blocked",
};

const prOpenedBlockedEffectRequest: EffectRequest = {
  effectId: "effect_pr_opened_blocked",
  commandId: prOpenedBlockedToolCommand.commandId,
  runId: prOpenedBlockedToolCommand.runId,
  capabilityId: prOpenedBlockedToolCommand.capabilityId,
  toolId: prOpenedBlockedToolCommand.toolId,
  args: prOpenedBlockedToolCommand.args,
  sideEffectClass: prOpenedBlockedToolCommand.sideEffectClass,
  requestedAt: "2026-05-24T18:10:01.000Z",
  idempotencyKey: "idem_pr_opened_blocked",
};

const prOpenedBlockedEffectReceipt: EffectReceipt = {
  receiptId: "receipt_pr_opened_blocked",
  effectId: prOpenedBlockedEffectRequest.effectId,
  runId: prOpenedBlockedToolCommand.runId,
  capabilityId: prOpenedBlockedToolCommand.capabilityId,
  receiptType: "pull_request_opened",
  status: "failed",
  payload: {
    actionVerb: "opened",
    subjectType: "agent_run",
    subjectId: prOpenedBlockedToolCommand.runId,
    targetType: "pull_request",
    targetId: "pr-214",
    status: "failed",
    reason: "remote_rejected",
  },
  payloadHash:
    "sha256:ddc6db2b4512123e90503639794a28f4b674a958ed9c713c3fcbbcfb165cfa3d",
  evidence: [prOpenedBlockedReceiptEvidence],
  observedAt: prOpenedBlockedReceiptEvidence.observedAt,
  externalRef: "vcs://amca/pull-requests/pr-214",
};

const prOpenedBlockedClaim: Claim = {
  claimId: "claim_pr_opened_blocked",
  type: "historical_action",
  statement: "A pull request was opened.",
  predicate: {
    kind: "historical_action",
    actionVerb: "opened",
    subjectType: "agent_run",
    subjectId: prOpenedBlockedToolCommand.runId,
    targetType: "pull_request",
    targetId: "pr-214",
    capabilityId: prOpenedBlockedToolCommand.capabilityId,
    requiredReceiptType: "pull_request_opened",
  },
  evidenceRefs: [prOpenedBlockedReceiptEvidence],
  criticality: "high",
};

const prOpenedBlockedFinalCandidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_pr_opened_blocked",
  runId: prOpenedBlockedToolCommand.runId,
  claims: [prOpenedBlockedClaim],
  narrativeDraft: "A pull request was opened.",
};

const prOpenedBlockedMismatch: Mismatch = {
  mismatchId: "mismatch_pr_opened_receipt_failed",
  runId: prOpenedBlockedToolCommand.runId,
  type: "unverified_receipt",
  blocking: true,
  message:
    "The historical_action claim requires a succeeded pull_request_opened receipt.",
  claimId: prOpenedBlockedClaim.claimId,
  expected: {
    receiptType: "pull_request_opened",
    status: "succeeded",
  },
  actual: {
    receiptType: prOpenedBlockedEffectReceipt.receiptType,
    status: prOpenedBlockedEffectReceipt.status,
  },
};

const prOpenedBlockedProof: ProofObject = {
  proofId: "proof_pr_opened_blocked",
  runId: prOpenedBlockedToolCommand.runId,
  candidateId: prOpenedBlockedFinalCandidate.candidateId,
  generatedAt: "2026-05-24T18:10:03.000Z",
  verdict: "fail",
  claims: [
    {
      claimId: prOpenedBlockedClaim.claimId,
      supported: false,
      evidenceRefs: [prOpenedBlockedReceiptEvidence],
      mismatchIds: [prOpenedBlockedMismatch.mismatchId],
    },
  ],
  approvedClaimIds: [],
  rejectedClaimIds: [prOpenedBlockedClaim.claimId],
  blockingMismatches: [prOpenedBlockedMismatch],
  evaluatedClaims: [prOpenedBlockedClaim],
};

const prOpenedBlockedReleaseDecision: ReleaseDecision = {
  status: "blocked",
  runId: prOpenedBlockedToolCommand.runId,
  proofId: prOpenedBlockedProof.proofId,
  approvedClaimIds: [],
  blockingMismatchIds: [prOpenedBlockedMismatch.mismatchId],
  repairHints: [
    "Retry through the Effect Broker and record a succeeded receipt.",
  ],
};

const prOpenedBlockedRunEvents: RunEvent[] = [
  {
    eventId: "evt_pr_opened_blocked_run_started",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 1,
    type: "RunStarted",
    payload: {
      runId: prOpenedBlockedToolCommand.runId,
      profile: "standard",
      metadata: {
        scenarioId: "pr-opened-blocked",
      },
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    causationId: null,
    correlationId: "corr_pr_opened_blocked",
    occurredAt: "2026-05-24T18:10:00.000Z",
  },
  {
    eventId: "evt_pr_opened_blocked_tool_proposed",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 2,
    type: "ProposalReceived",
    payload: {
      proposal: prOpenedBlockedToolCommand,
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333334",
    causationId: "evt_pr_opened_blocked_run_started",
    correlationId: "corr_pr_opened_blocked",
    occurredAt: "2026-05-24T18:10:00.500Z",
  },
  {
    eventId: "evt_pr_opened_blocked_effect_requested",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 3,
    type: "EffectRequested",
    payload: {
      effectRequest: prOpenedBlockedEffectRequest,
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333335",
    causationId: "evt_pr_opened_blocked_tool_proposed",
    correlationId: "corr_pr_opened_blocked",
    occurredAt: prOpenedBlockedEffectRequest.requestedAt,
  },
  {
    eventId: "evt_pr_opened_blocked_receipt_recorded",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 4,
    type: "EffectReceiptRecorded",
    payload: {
      receipt: prOpenedBlockedEffectReceipt,
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333336",
    causationId: "evt_pr_opened_blocked_effect_requested",
    correlationId: "corr_pr_opened_blocked",
    occurredAt: prOpenedBlockedEffectReceipt.observedAt,
  },
  {
    eventId: "evt_pr_opened_blocked_final_proposed",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 5,
    type: "ProposalReceived",
    payload: {
      proposal: prOpenedBlockedFinalCandidate,
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333337",
    causationId: "evt_pr_opened_blocked_receipt_recorded",
    correlationId: "corr_pr_opened_blocked",
    occurredAt: "2026-05-24T18:10:02.500Z",
  },
];

const prOpenedBlockedExpectedEvents: RunEvent[] = [
  {
    eventId: "evt_pr_opened_blocked_proof_generated",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 6,
    type: "ProofGenerated",
    payload: {
      proof: prOpenedBlockedProof,
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333338",
    causationId: "evt_pr_opened_blocked_final_proposed",
    correlationId: "corr_pr_opened_blocked",
    occurredAt: prOpenedBlockedProof.generatedAt,
  },
  {
    eventId: "evt_pr_opened_blocked_mismatch_detected",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 7,
    type: "MismatchDetected",
    payload: {
      mismatch: prOpenedBlockedMismatch,
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333339",
    causationId: "evt_pr_opened_blocked_proof_generated",
    correlationId: "corr_pr_opened_blocked",
    occurredAt: "2026-05-24T18:10:03.100Z",
  },
  {
    eventId: "evt_pr_opened_blocked_release_decided",
    runId: prOpenedBlockedToolCommand.runId,
    sequence: 8,
    type: "ReleaseDecided",
    payload: {
      decision: prOpenedBlockedReleaseDecision,
    },
    payloadHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333340",
    causationId: "evt_pr_opened_blocked_proof_generated",
    correlationId: "corr_pr_opened_blocked",
    occurredAt: "2026-05-24T18:10:03.200Z",
  },
];

const prOpenedReleasedReceiptEvidence: EvidenceRef = {
  evidenceId: "ev_pr_opened_released_receipt",
  kind: "effect_receipt",
  sourceEventId: "evt_pr_opened_released_receipt_recorded",
  hash: "sha256:ecea8ee714fe71e98c42a5c76da2bc9f32e467699f8ef0e278bfed2d33deb606",
  observedAt: "2026-05-24T18:15:02.000Z",
  sensitivity: "internal",
  metadata: {
    targetId: "pr-215",
  },
};

const prOpenedReleasedToolCommand: ToolCommandRequest = {
  kind: "tool_command_request",
  commandId: "cmd_pr_opened_released",
  runId: "run_pr_opened_released",
  capabilityId: "vcs.pull_request.open",
  toolId: "vcs.openPullRequest",
  args: {
    repository: "amca",
    branch: "phase/testing-fixtures",
    targetBranch: "main",
    title: "AMCA testing fixtures",
  },
  sideEffectClass: "idempotent_write",
  idempotencyKey: "idem_pr_opened_released",
};

const prOpenedReleasedEffectRequest: EffectRequest = {
  effectId: "effect_pr_opened_released",
  commandId: prOpenedReleasedToolCommand.commandId,
  runId: prOpenedReleasedToolCommand.runId,
  capabilityId: prOpenedReleasedToolCommand.capabilityId,
  toolId: prOpenedReleasedToolCommand.toolId,
  args: prOpenedReleasedToolCommand.args,
  sideEffectClass: prOpenedReleasedToolCommand.sideEffectClass,
  requestedAt: "2026-05-24T18:15:01.000Z",
  idempotencyKey: "idem_pr_opened_released",
};

const prOpenedReleasedEffectReceipt: EffectReceipt = {
  receiptId: "receipt_pr_opened_released",
  effectId: prOpenedReleasedEffectRequest.effectId,
  runId: prOpenedReleasedToolCommand.runId,
  capabilityId: prOpenedReleasedToolCommand.capabilityId,
  receiptType: "pull_request_opened",
  status: "succeeded",
  payload: {
    actionVerb: "opened",
    subjectType: "agent_run",
    subjectId: prOpenedReleasedToolCommand.runId,
    targetType: "pull_request",
    targetId: "pr-215",
    status: "opened",
    url: "https://example.invalid/amca/pull/215",
  },
  payloadHash:
    "sha256:ecea8ee714fe71e98c42a5c76da2bc9f32e467699f8ef0e278bfed2d33deb606",
  evidence: [prOpenedReleasedReceiptEvidence],
  observedAt: prOpenedReleasedReceiptEvidence.observedAt,
  externalRef: "https://example.invalid/amca/pull/215",
};

const prOpenedReleasedClaim: Claim = {
  claimId: "claim_pr_opened_released",
  type: "historical_action",
  statement: "A pull request was opened.",
  predicate: {
    kind: "historical_action",
    actionVerb: "opened",
    subjectType: "agent_run",
    subjectId: prOpenedReleasedToolCommand.runId,
    targetType: "pull_request",
    targetId: "pr-215",
    capabilityId: prOpenedReleasedToolCommand.capabilityId,
    requiredReceiptType: "pull_request_opened",
  },
  evidenceRefs: [prOpenedReleasedReceiptEvidence],
  criticality: "high",
};

const prOpenedReleasedFinalCandidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_pr_opened_released",
  runId: prOpenedReleasedToolCommand.runId,
  claims: [prOpenedReleasedClaim],
  narrativeDraft: "A pull request was opened.",
};

const prOpenedReleasedProof: ProofObject = {
  proofId: "proof_pr_opened_released",
  runId: prOpenedReleasedToolCommand.runId,
  candidateId: prOpenedReleasedFinalCandidate.candidateId,
  generatedAt: "2026-05-24T18:15:03.000Z",
  verdict: "pass",
  claims: [
    {
      claimId: prOpenedReleasedClaim.claimId,
      supported: true,
      evidenceRefs: [prOpenedReleasedReceiptEvidence],
      mismatchIds: [],
    },
  ],
  approvedClaimIds: [prOpenedReleasedClaim.claimId],
  rejectedClaimIds: [],
  blockingMismatches: [],
  evaluatedClaims: [prOpenedReleasedClaim],
};

const prOpenedReleasedReleaseDecision: ReleaseDecision = {
  status: "released",
  runId: prOpenedReleasedToolCommand.runId,
  proofId: prOpenedReleasedProof.proofId,
  approvedClaimIds: [prOpenedReleasedClaim.claimId],
  blockingMismatchIds: [],
  finalMessage: "Pull request pr-215 was opened.",
};

const prOpenedReleasedRunEvents: RunEvent[] = [
  {
    eventId: "evt_pr_opened_released_run_started",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 1,
    type: "RunStarted",
    payload: {
      runId: prOpenedReleasedToolCommand.runId,
      profile: "standard",
      metadata: {
        scenarioId: "pr-opened-released",
      },
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444443",
    causationId: null,
    correlationId: "corr_pr_opened_released",
    occurredAt: "2026-05-24T18:15:00.000Z",
  },
  {
    eventId: "evt_pr_opened_released_tool_proposed",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 2,
    type: "ProposalReceived",
    payload: {
      proposal: prOpenedReleasedToolCommand,
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    causationId: "evt_pr_opened_released_run_started",
    correlationId: "corr_pr_opened_released",
    occurredAt: "2026-05-24T18:15:00.500Z",
  },
  {
    eventId: "evt_pr_opened_released_effect_requested",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 3,
    type: "EffectRequested",
    payload: {
      effectRequest: prOpenedReleasedEffectRequest,
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444445",
    causationId: "evt_pr_opened_released_tool_proposed",
    correlationId: "corr_pr_opened_released",
    occurredAt: prOpenedReleasedEffectRequest.requestedAt,
  },
  {
    eventId: "evt_pr_opened_released_receipt_recorded",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 4,
    type: "EffectReceiptRecorded",
    payload: {
      receipt: prOpenedReleasedEffectReceipt,
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444446",
    causationId: "evt_pr_opened_released_effect_requested",
    correlationId: "corr_pr_opened_released",
    occurredAt: prOpenedReleasedEffectReceipt.observedAt,
  },
  {
    eventId: "evt_pr_opened_released_final_proposed",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 5,
    type: "ProposalReceived",
    payload: {
      proposal: prOpenedReleasedFinalCandidate,
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444447",
    causationId: "evt_pr_opened_released_receipt_recorded",
    correlationId: "corr_pr_opened_released",
    occurredAt: "2026-05-24T18:15:02.500Z",
  },
];

const prOpenedReleasedExpectedEvents: RunEvent[] = [
  {
    eventId: "evt_pr_opened_released_proof_generated",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 6,
    type: "ProofGenerated",
    payload: {
      proof: prOpenedReleasedProof,
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444448",
    causationId: "evt_pr_opened_released_final_proposed",
    correlationId: "corr_pr_opened_released",
    occurredAt: prOpenedReleasedProof.generatedAt,
  },
  {
    eventId: "evt_pr_opened_released_release_decided",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 7,
    type: "ReleaseDecided",
    payload: {
      decision: prOpenedReleasedReleaseDecision,
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444449",
    causationId: "evt_pr_opened_released_proof_generated",
    correlationId: "corr_pr_opened_released",
    occurredAt: "2026-05-24T18:15:03.100Z",
  },
  {
    eventId: "evt_pr_opened_released_final_released",
    runId: prOpenedReleasedToolCommand.runId,
    sequence: 8,
    type: "FinalReleased",
    payload: {
      decision: prOpenedReleasedReleaseDecision,
      candidate: prOpenedReleasedFinalCandidate,
    },
    payloadHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444450",
    causationId: "evt_pr_opened_released_release_decided",
    correlationId: "corr_pr_opened_released",
    occurredAt: "2026-05-24T18:15:03.200Z",
  },
];

const prCurrentStateStaleObservationEvidence: EvidenceRef = {
  evidenceId: "ev_pr_current_state_stale_observation",
  kind: "external_observation",
  sourceEventId: "evt_pr_current_state_stale_observed",
  hash: "sha256:809d591c417f243c6845330c3afc1e1583f492e908d034b2e03754473ce6e771",
  observedAt: "2026-05-24T18:20:00.000Z",
  sensitivity: "internal",
  expiresAt: "2026-05-24T18:25:00.000Z",
  metadata: {
    observationType: "pull_request_state",
  },
};

const prCurrentStateStaleToolCommand: ToolCommandRequest = {
  kind: "tool_command_request",
  commandId: "cmd_pr_current_state_stale",
  runId: "run_pr_current_state_stale",
  capabilityId: "vcs.pull_request.read",
  toolId: "vcs.getPullRequest",
  args: {
    repository: "amca",
    pullRequestId: "pr-216",
  },
  sideEffectClass: "read",
  idempotencyKey: "idem_pr_current_state_stale",
};

const prCurrentStateStaleEffectRequest: EffectRequest = {
  effectId: "effect_pr_current_state_stale",
  commandId: prCurrentStateStaleToolCommand.commandId,
  runId: prCurrentStateStaleToolCommand.runId,
  capabilityId: prCurrentStateStaleToolCommand.capabilityId,
  toolId: prCurrentStateStaleToolCommand.toolId,
  args: prCurrentStateStaleToolCommand.args,
  sideEffectClass: prCurrentStateStaleToolCommand.sideEffectClass,
  requestedAt: "2026-05-24T18:20:00.000Z",
  idempotencyKey: "idem_pr_current_state_stale",
};

const prCurrentStateStaleObservation: ExternalStateObservation = {
  observationId: "obs_pr_current_state_stale",
  runId: prCurrentStateStaleToolCommand.runId,
  observationType: "pull_request_state",
  subjectType: "pull_request",
  subjectId: "pr-216",
  observedState: {
    state: "open",
    head: "phase/testing-fixtures",
  },
  observedAt: prCurrentStateStaleObservationEvidence.observedAt,
  expiresAt: "2026-05-24T18:25:00.000Z",
  payloadHash:
    "sha256:809d591c417f243c6845330c3afc1e1583f492e908d034b2e03754473ce6e771",
  evidence: [prCurrentStateStaleObservationEvidence],
};

const prCurrentStateStaleClaim: Claim = {
  claimId: "claim_pr_current_state_stale",
  type: "current_state",
  statement: "Pull request pr-216 is open.",
  predicate: {
    kind: "current_state",
    subjectType: "pull_request",
    subjectId: "pr-216",
    property: "state",
    operator: "equals",
    expectedValue: "open",
    observationType: "pull_request_state",
    freshnessRequirementMs: 300000,
  },
  evidenceRefs: [prCurrentStateStaleObservationEvidence],
  criticality: "high",
};

const prCurrentStateStaleFinalCandidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_pr_current_state_stale",
  runId: prCurrentStateStaleToolCommand.runId,
  claims: [prCurrentStateStaleClaim],
  narrativeDraft: "Pull request pr-216 is open.",
};

const prCurrentStateStaleMismatch: Mismatch = {
  mismatchId: "mismatch_pr_current_state_stale",
  runId: prCurrentStateStaleToolCommand.runId,
  type: "stale_external_state",
  blocking: true,
  message:
    "The current_state claim depends on an expired external observation.",
  claimId: prCurrentStateStaleClaim.claimId,
  expected: {
    freshnessRequirementMs: 300000,
    latestAllowedObservedAt: "2026-05-24T18:27:00.000Z",
  },
  actual: {
    observedAt: prCurrentStateStaleObservation.observedAt,
    evaluatedAt: "2026-05-24T18:32:00.000Z",
  },
};

const prCurrentStateStaleProof: ProofObject = {
  proofId: "proof_pr_current_state_stale",
  runId: prCurrentStateStaleToolCommand.runId,
  candidateId: prCurrentStateStaleFinalCandidate.candidateId,
  generatedAt: "2026-05-24T18:32:00.000Z",
  verdict: "fail",
  claims: [
    {
      claimId: prCurrentStateStaleClaim.claimId,
      supported: false,
      evidenceRefs: [prCurrentStateStaleObservationEvidence],
      mismatchIds: [prCurrentStateStaleMismatch.mismatchId],
    },
  ],
  approvedClaimIds: [],
  rejectedClaimIds: [prCurrentStateStaleClaim.claimId],
  blockingMismatches: [prCurrentStateStaleMismatch],
  evaluatedClaims: [prCurrentStateStaleClaim],
};

const prCurrentStateStaleReleaseDecision: ReleaseDecision = {
  status: "blocked",
  runId: prCurrentStateStaleToolCommand.runId,
  proofId: prCurrentStateStaleProof.proofId,
  approvedClaimIds: [],
  blockingMismatchIds: [prCurrentStateStaleMismatch.mismatchId],
  repairHints: ["Refresh the pull request state observation before release."],
};

const prCurrentStateStaleRunEvents: RunEvent[] = [
  {
    eventId: "evt_pr_current_state_stale_run_started",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 1,
    type: "RunStarted",
    payload: {
      runId: prCurrentStateStaleToolCommand.runId,
      profile: "standard",
      metadata: {
        scenarioId: "pr-current-state-stale-blocked",
      },
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555553",
    causationId: null,
    correlationId: "corr_pr_current_state_stale",
    occurredAt: "2026-05-24T18:20:00.000Z",
  },
  {
    eventId: "evt_pr_current_state_stale_tool_proposed",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 2,
    type: "ProposalReceived",
    payload: {
      proposal: prCurrentStateStaleToolCommand,
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555554",
    causationId: "evt_pr_current_state_stale_run_started",
    correlationId: "corr_pr_current_state_stale",
    occurredAt: "2026-05-24T18:20:00.100Z",
  },
  {
    eventId: "evt_pr_current_state_stale_effect_requested",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 3,
    type: "EffectRequested",
    payload: {
      effectRequest: prCurrentStateStaleEffectRequest,
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    causationId: "evt_pr_current_state_stale_tool_proposed",
    correlationId: "corr_pr_current_state_stale",
    occurredAt: prCurrentStateStaleEffectRequest.requestedAt,
  },
  {
    eventId: "evt_pr_current_state_stale_observed",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 4,
    type: "ExternalStateObserved",
    payload: {
      observation: prCurrentStateStaleObservation,
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555556",
    causationId: "evt_pr_current_state_stale_effect_requested",
    correlationId: "corr_pr_current_state_stale",
    occurredAt: prCurrentStateStaleObservation.observedAt,
  },
  {
    eventId: "evt_pr_current_state_stale_final_proposed",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 5,
    type: "ProposalReceived",
    payload: {
      proposal: prCurrentStateStaleFinalCandidate,
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555557",
    causationId: "evt_pr_current_state_stale_observed",
    correlationId: "corr_pr_current_state_stale",
    occurredAt: "2026-05-24T18:32:00.000Z",
  },
];

const prCurrentStateStaleExpectedEvents: RunEvent[] = [
  {
    eventId: "evt_pr_current_state_stale_proof_generated",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 6,
    type: "ProofGenerated",
    payload: {
      proof: prCurrentStateStaleProof,
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555558",
    causationId: "evt_pr_current_state_stale_final_proposed",
    correlationId: "corr_pr_current_state_stale",
    occurredAt: prCurrentStateStaleProof.generatedAt,
  },
  {
    eventId: "evt_pr_current_state_stale_mismatch_detected",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 7,
    type: "MismatchDetected",
    payload: {
      mismatch: prCurrentStateStaleMismatch,
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555559",
    causationId: "evt_pr_current_state_stale_proof_generated",
    correlationId: "corr_pr_current_state_stale",
    occurredAt: "2026-05-24T18:32:00.100Z",
  },
  {
    eventId: "evt_pr_current_state_stale_release_decided",
    runId: prCurrentStateStaleToolCommand.runId,
    sequence: 8,
    type: "ReleaseDecided",
    payload: {
      decision: prCurrentStateStaleReleaseDecision,
    },
    payloadHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555560",
    causationId: "evt_pr_current_state_stale_proof_generated",
    correlationId: "corr_pr_current_state_stale",
    occurredAt: "2026-05-24T18:32:00.200Z",
  },
];

const prCurrentStateFreshObservationEvidence: EvidenceRef = {
  evidenceId: "ev_pr_current_state_fresh_observation",
  kind: "external_observation",
  sourceEventId: "evt_pr_current_state_fresh_observed",
  hash: "sha256:809d591c417f243c6845330c3afc1e1583f492e908d034b2e03754473ce6e771",
  observedAt: "2026-05-24T18:35:00.000Z",
  sensitivity: "internal",
  expiresAt: "2026-05-24T18:40:00.000Z",
  metadata: {
    observationType: "pull_request_state",
  },
};

const prCurrentStateFreshToolCommand: ToolCommandRequest = {
  kind: "tool_command_request",
  commandId: "cmd_pr_current_state_fresh",
  runId: "run_pr_current_state_fresh",
  capabilityId: "vcs.pull_request.read",
  toolId: "vcs.getPullRequest",
  args: {
    repository: "amca",
    pullRequestId: "pr-217",
  },
  sideEffectClass: "read",
  idempotencyKey: "idem_pr_current_state_fresh",
};

const prCurrentStateFreshEffectRequest: EffectRequest = {
  effectId: "effect_pr_current_state_fresh",
  commandId: prCurrentStateFreshToolCommand.commandId,
  runId: prCurrentStateFreshToolCommand.runId,
  capabilityId: prCurrentStateFreshToolCommand.capabilityId,
  toolId: prCurrentStateFreshToolCommand.toolId,
  args: prCurrentStateFreshToolCommand.args,
  sideEffectClass: prCurrentStateFreshToolCommand.sideEffectClass,
  requestedAt: "2026-05-24T18:35:00.000Z",
  idempotencyKey: "idem_pr_current_state_fresh",
};

const prCurrentStateFreshObservation: ExternalStateObservation = {
  observationId: "obs_pr_current_state_fresh",
  runId: prCurrentStateFreshToolCommand.runId,
  observationType: "pull_request_state",
  subjectType: "pull_request",
  subjectId: "pr-217",
  observedState: {
    state: "open",
    head: "phase/testing-fixtures",
  },
  observedAt: prCurrentStateFreshObservationEvidence.observedAt,
  expiresAt: "2026-05-24T18:40:00.000Z",
  payloadHash:
    "sha256:809d591c417f243c6845330c3afc1e1583f492e908d034b2e03754473ce6e771",
  evidence: [prCurrentStateFreshObservationEvidence],
};

const prCurrentStateFreshClaim: Claim = {
  claimId: "claim_pr_current_state_fresh",
  type: "current_state",
  statement: "Pull request pr-217 is open.",
  predicate: {
    kind: "current_state",
    subjectType: "pull_request",
    subjectId: "pr-217",
    property: "state",
    operator: "equals",
    expectedValue: "open",
    observationType: "pull_request_state",
    freshnessRequirementMs: 300000,
  },
  evidenceRefs: [prCurrentStateFreshObservationEvidence],
  criticality: "high",
};

const prCurrentStateFreshFinalCandidate: FinalCandidate = {
  kind: "final_candidate",
  candidateId: "candidate_pr_current_state_fresh",
  runId: prCurrentStateFreshToolCommand.runId,
  claims: [prCurrentStateFreshClaim],
  narrativeDraft: "Pull request pr-217 is open.",
};

const prCurrentStateFreshProof: ProofObject = {
  proofId: "proof_pr_current_state_fresh",
  runId: prCurrentStateFreshToolCommand.runId,
  candidateId: prCurrentStateFreshFinalCandidate.candidateId,
  generatedAt: "2026-05-24T18:37:00.000Z",
  verdict: "pass",
  claims: [
    {
      claimId: prCurrentStateFreshClaim.claimId,
      supported: true,
      evidenceRefs: [prCurrentStateFreshObservationEvidence],
      mismatchIds: [],
    },
  ],
  approvedClaimIds: [prCurrentStateFreshClaim.claimId],
  rejectedClaimIds: [],
  blockingMismatches: [],
  evaluatedClaims: [prCurrentStateFreshClaim],
};

const prCurrentStateFreshReleaseDecision: ReleaseDecision = {
  status: "released",
  runId: prCurrentStateFreshToolCommand.runId,
  proofId: prCurrentStateFreshProof.proofId,
  approvedClaimIds: [prCurrentStateFreshClaim.claimId],
  blockingMismatchIds: [],
  finalMessage: "Pull request pr-217 is currently open.",
};

const prCurrentStateFreshRunEvents: RunEvent[] = [
  {
    eventId: "evt_pr_current_state_fresh_run_started",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 1,
    type: "RunStarted",
    payload: {
      runId: prCurrentStateFreshToolCommand.runId,
      profile: "standard",
      metadata: {
        scenarioId: "pr-current-state-fresh-released",
      },
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666663",
    causationId: null,
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: "2026-05-24T18:35:00.000Z",
  },
  {
    eventId: "evt_pr_current_state_fresh_tool_proposed",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 2,
    type: "ProposalReceived",
    payload: {
      proposal: prCurrentStateFreshToolCommand,
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666664",
    causationId: "evt_pr_current_state_fresh_run_started",
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: "2026-05-24T18:35:00.100Z",
  },
  {
    eventId: "evt_pr_current_state_fresh_effect_requested",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 3,
    type: "EffectRequested",
    payload: {
      effectRequest: prCurrentStateFreshEffectRequest,
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666665",
    causationId: "evt_pr_current_state_fresh_tool_proposed",
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: prCurrentStateFreshEffectRequest.requestedAt,
  },
  {
    eventId: "evt_pr_current_state_fresh_observed",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 4,
    type: "ExternalStateObserved",
    payload: {
      observation: prCurrentStateFreshObservation,
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    causationId: "evt_pr_current_state_fresh_effect_requested",
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: prCurrentStateFreshObservation.observedAt,
  },
  {
    eventId: "evt_pr_current_state_fresh_final_proposed",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 5,
    type: "ProposalReceived",
    payload: {
      proposal: prCurrentStateFreshFinalCandidate,
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666667",
    causationId: "evt_pr_current_state_fresh_observed",
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: "2026-05-24T18:37:00.000Z",
  },
];

const prCurrentStateFreshExpectedEvents: RunEvent[] = [
  {
    eventId: "evt_pr_current_state_fresh_proof_generated",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 6,
    type: "ProofGenerated",
    payload: {
      proof: prCurrentStateFreshProof,
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666668",
    causationId: "evt_pr_current_state_fresh_final_proposed",
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: prCurrentStateFreshProof.generatedAt,
  },
  {
    eventId: "evt_pr_current_state_fresh_release_decided",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 7,
    type: "ReleaseDecided",
    payload: {
      decision: prCurrentStateFreshReleaseDecision,
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666669",
    causationId: "evt_pr_current_state_fresh_proof_generated",
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: "2026-05-24T18:37:00.100Z",
  },
  {
    eventId: "evt_pr_current_state_fresh_final_released",
    runId: prCurrentStateFreshToolCommand.runId,
    sequence: 8,
    type: "FinalReleased",
    payload: {
      decision: prCurrentStateFreshReleaseDecision,
      candidate: prCurrentStateFreshFinalCandidate,
    },
    payloadHash:
      "sha256:6666666666666666666666666666666666666666666666666666666666666670",
    causationId: "evt_pr_current_state_fresh_release_decided",
    correlationId: "corr_pr_current_state_fresh",
    occurredAt: "2026-05-24T18:37:00.200Z",
  },
];

export const testsPassedBlockedScenario: ScenarioFixture = {
  id: "tests-passed-blocked",
  title: "Tests passed claim blocked without receipt evidence",
  case: "negative",
  profile: "standard",
  description:
    "A final candidate claims tests passed, but no first-class test_run receipt supports the claim.",
  runtimeScope: staticRuntimeScope,
  given: {
    toolCommandRequest: testsPassedBlockedToolCommand,
    effectRequest: testsPassedBlockedEffectRequest,
    finalCandidate: testsPassedBlockedFinalCandidate,
    runEvents: withEventPayloadHashes(testsPassedBlockedRunEvents),
  },
  expected: {
    proof: testsPassedBlockedProof,
    mismatches: [testsPassedBlockedMismatch],
    releaseDecision: testsPassedBlockedReleaseDecision,
    emittedEvents: withEventPayloadHashes(testsPassedBlockedExpectedEvents),
  },
};

export const testsPassedReleasedScenario: ScenarioFixture = {
  id: "tests-passed-released",
  title: "Tests passed claim released with receipt evidence",
  case: "positive",
  profile: "standard",
  description:
    "A final candidate claims tests passed and references a succeeded test_run receipt.",
  runtimeScope: staticRuntimeScope,
  given: {
    toolCommandRequest: testsPassedReleasedToolCommand,
    effectRequest: testsPassedReleasedEffectRequest,
    effectReceipt: testsPassedReleasedEffectReceipt,
    finalCandidate: testsPassedReleasedFinalCandidate,
    runEvents: withEventPayloadHashes(testsPassedReleasedRunEvents),
  },
  expected: {
    proof: testsPassedReleasedProof,
    mismatches: [],
    releaseDecision: testsPassedReleasedReleaseDecision,
    emittedEvents: withEventPayloadHashes(testsPassedReleasedExpectedEvents),
  },
};

export const statementPredicateMismatchSafeRenderedScenario: ScenarioFixture = {
  id: "statement-predicate-mismatch-blocked-or-safely-rendered",
  title: "Statement/predicate mismatch releases only deterministic text",
  case: "positive",
  profile: "standard",
  description:
    "A final candidate supplies a malicious statement, but AMCA releases only the deterministic predicate-rendered message.",
  runtimeScope: staticRuntimeScope,
  given: {
    toolCommandRequest: statementPredicateMismatchToolCommand,
    effectRequest: statementPredicateMismatchEffectRequest,
    effectReceipt: statementPredicateMismatchEffectReceipt,
    finalCandidate: statementPredicateMismatchFinalCandidate,
    runEvents: withEventPayloadHashes(statementPredicateMismatchRunEvents),
  },
  expected: {
    proof: statementPredicateMismatchProof,
    mismatches: [],
    releaseDecision: statementPredicateMismatchReleaseDecision,
    emittedEvents: withEventPayloadHashes(
      statementPredicateMismatchExpectedEvents,
    ),
  },
};

export const prOpenedBlockedScenario: ScenarioFixture = {
  id: "pr-opened-blocked",
  title: "Pull request opened claim blocked with failed receipt",
  case: "negative",
  profile: "standard",
  description:
    "A final candidate claims a pull request was opened, but the matching receipt is failed.",
  runtimeScope: staticRuntimeScope,
  given: {
    toolCommandRequest: prOpenedBlockedToolCommand,
    effectRequest: prOpenedBlockedEffectRequest,
    effectReceipt: prOpenedBlockedEffectReceipt,
    finalCandidate: prOpenedBlockedFinalCandidate,
    runEvents: withEventPayloadHashes(prOpenedBlockedRunEvents),
  },
  expected: {
    proof: prOpenedBlockedProof,
    mismatches: [prOpenedBlockedMismatch],
    releaseDecision: prOpenedBlockedReleaseDecision,
    emittedEvents: withEventPayloadHashes(prOpenedBlockedExpectedEvents),
  },
};

export const prOpenedReleasedScenario: ScenarioFixture = {
  id: "pr-opened-released",
  title: "Pull request opened claim released with succeeded receipt",
  case: "positive",
  profile: "standard",
  description:
    "A final candidate claims a pull request was opened and references a succeeded receipt.",
  runtimeScope: staticRuntimeScope,
  given: {
    toolCommandRequest: prOpenedReleasedToolCommand,
    effectRequest: prOpenedReleasedEffectRequest,
    effectReceipt: prOpenedReleasedEffectReceipt,
    finalCandidate: prOpenedReleasedFinalCandidate,
    runEvents: withEventPayloadHashes(prOpenedReleasedRunEvents),
  },
  expected: {
    proof: prOpenedReleasedProof,
    mismatches: [],
    releaseDecision: prOpenedReleasedReleaseDecision,
    emittedEvents: withEventPayloadHashes(prOpenedReleasedExpectedEvents),
  },
};

export const prCurrentStateStaleBlockedScenario: ScenarioFixture = {
  id: "pr-current-state-stale-blocked",
  title: "Pull request current-state claim blocked with stale observation",
  case: "negative",
  profile: "standard",
  description:
    "A final candidate claims current pull request state using an observation outside its freshness window.",
  runtimeScope: staticRuntimeScope,
  given: {
    toolCommandRequest: prCurrentStateStaleToolCommand,
    effectRequest: prCurrentStateStaleEffectRequest,
    externalStateObservation: prCurrentStateStaleObservation,
    finalCandidate: prCurrentStateStaleFinalCandidate,
    runEvents: withEventPayloadHashes(prCurrentStateStaleRunEvents),
  },
  expected: {
    proof: prCurrentStateStaleProof,
    mismatches: [prCurrentStateStaleMismatch],
    releaseDecision: prCurrentStateStaleReleaseDecision,
    emittedEvents: withEventPayloadHashes(prCurrentStateStaleExpectedEvents),
  },
};

export const prCurrentStateFreshReleasedScenario: ScenarioFixture = {
  id: "pr-current-state-fresh-released",
  title: "Pull request current-state claim released with fresh observation",
  case: "positive",
  profile: "standard",
  description:
    "A final candidate claims current pull request state using an observation inside its freshness window.",
  runtimeScope: staticRuntimeScope,
  given: {
    toolCommandRequest: prCurrentStateFreshToolCommand,
    effectRequest: prCurrentStateFreshEffectRequest,
    externalStateObservation: prCurrentStateFreshObservation,
    finalCandidate: prCurrentStateFreshFinalCandidate,
    runEvents: withEventPayloadHashes(prCurrentStateFreshRunEvents),
  },
  expected: {
    proof: prCurrentStateFreshProof,
    mismatches: [],
    releaseDecision: prCurrentStateFreshReleaseDecision,
    emittedEvents: withEventPayloadHashes(prCurrentStateFreshExpectedEvents),
  },
};

export const scenarioFixtures: ScenarioFixture[] = [
  testsPassedBlockedScenario,
  testsPassedReleasedScenario,
  statementPredicateMismatchSafeRenderedScenario,
  prOpenedBlockedScenario,
  prOpenedReleasedScenario,
  prCurrentStateStaleBlockedScenario,
  prCurrentStateFreshReleasedScenario,
];

export const scenarioFixturesById: Record<ScenarioId, ScenarioFixture> = {
  "tests-passed-blocked": testsPassedBlockedScenario,
  "tests-passed-released": testsPassedReleasedScenario,
  "statement-predicate-mismatch-blocked-or-safely-rendered":
    statementPredicateMismatchSafeRenderedScenario,
  "pr-opened-blocked": prOpenedBlockedScenario,
  "pr-opened-released": prOpenedReleasedScenario,
  "pr-current-state-stale-blocked": prCurrentStateStaleBlockedScenario,
  "pr-current-state-fresh-released": prCurrentStateFreshReleasedScenario,
};
