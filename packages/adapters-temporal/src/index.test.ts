import { describe, expect, it } from "vitest";

import { validateCertificationManifest } from "@amca/adapters-conformance";
import type {
  EffectReceipt,
  EffectRequest,
  FinalCandidate,
  RunEvent,
  ToolCommandRequest,
} from "@amca/protocol";
import { validateEvidenceRef } from "@amca/contracts";

import {
  TEMPORAL_ADAPTER_CERTIFICATION,
  TemporalBoundaryError,
  TEMPORAL_LIVE_WORKER_CERTIFICATION_GAP,
  type TemporalWorkflowRawTextOutput,
  assessTemporalHistoryAuthority,
  assessTemporalRetryMetadataAuthority,
  buildTemporalActivityEnvelope,
  buildTemporalActivityRetryEnvelope,
  correlateTemporalActivityReceipt,
  createTemporalAdapterBoundaryContract,
  createTemporalConformanceReport,
  temporalActivityEnvelopeToEffectCandidate,
  temporalHistoryPayload,
  temporalRetryMetadataPayload,
  temporalRetryPreservesIdempotency,
  translateTemporalWorkflowOutputToFinalCandidate,
  TemporalWorkflowBoundary,
  TemporalWorkerBoundary,
} from "./index.js";
import * as temporalExports from "./index.js";

const runId = "run_temporal_adapter";
const now = "2026-05-25T12:00:00.000Z";
const boundary = {
  adapterId: "adapter.temporal.test",
  substrate: "temporal" as const,
  runId,
  workflowId: "workflow_temporal_test",
  workflowRunId: "temporal_run_001",
};

describe("Temporal activity boundary envelopes", () => {
  it("includes AMCA effect identity, run identity, and idempotency key", () => {
    const envelope = buildTemporalActivityEnvelope({
      boundary,
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
      scheduledAt: now,
      temporalActivityOptions: {
        activityId: "activity_run_tests",
        taskQueue: "amca-test",
      },
    });

    expect(envelope).toMatchObject({
      boundaryKind: "temporal_activity_effect_envelope",
      envelopeVersion: 1,
      adapterId: boundary.adapterId,
      substrate: "temporal",
      runId,
      workflowId: boundary.workflowId,
      workflowRunId: boundary.workflowRunId,
      activityId: "activity_run_tests",
      attempt: 1,
      effectId: "effect_temporal_test",
      idempotencyKey: "idem-temporal-test",
      idempotencyKeySource: "effect_request",
      temporalSdk: {
        packageName: "@temporalio/common",
        integrationKind: "type_only",
      },
    });
    expect(envelope.effectRequestHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("temporal-activity-envelope-becomes-effect-candidate", () => {
    const envelope = buildTemporalActivityEnvelope({
      boundary,
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
    });
    const candidate = temporalActivityEnvelopeToEffectCandidate(envelope);

    expect(candidate).toMatchObject({
      candidateKind: "temporal_activity_effect_candidate",
      authority: "amca_effect_request_candidate",
      admissionRequired: "kernel_effect_request_admission",
      canExecuteDirectly: false,
      canEmitReceiptDirectly: false,
      canSupportClaimDirectly: false,
      effectRequest: {
        effectId: envelope.effectId,
      },
    });
  });

  it("preserves idempotency when Temporal retries an activity", () => {
    const firstAttempt = buildTemporalActivityEnvelope({
      boundary,
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
    });
    const retry = buildTemporalActivityRetryEnvelope({
      previousEnvelope: firstAttempt,
      attempt: 2,
      scheduledAt: "2026-05-25T12:00:05.000Z",
    });

    expect(retry.attempt).toBe(2);
    expect(retry.idempotencyKey).toBe(firstAttempt.idempotencyKey);
    expect(retry.effectId).toBe(firstAttempt.effectId);
    expect(retry.runId).toBe(firstAttempt.runId);
    expect(temporalRetryPreservesIdempotency(firstAttempt, retry)).toBe(true);
  });

  it("temporal-retry-metadata-as-current-state-blocked", () => {
    const firstAttempt = buildTemporalActivityEnvelope({
      boundary,
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
    });
    const retry = buildTemporalActivityRetryEnvelope({
      previousEnvelope: firstAttempt,
      attempt: 2,
      scheduledAt: "2026-05-25T12:00:05.000Z",
    });

    expect(assessTemporalRetryMetadataAuthority(retry)).toMatchObject({
      sourceKind: "temporal_retry_metadata",
      status: "temporal_retry_metadata_only",
      canSupportClaimDirectly: false,
      canBeEvidenceRefDirectly: false,
      canBeProofDirectly: false,
      eligibleForKernelProof: false,
    });
    expect(
      validateEvidenceRef(temporalRetryMetadataPayload(retry)).success,
    ).toBe(false);
  });

  it("flags Temporal activity results as non-authoritative without an AMCA receipt event", () => {
    const envelope = buildTemporalActivityEnvelope({
      boundary,
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
    });
    const correlation = correlateTemporalActivityReceipt({
      envelope,
      activityResult: {
        status: "completed",
        completedAt: now,
        attempt: 1,
        result: {
          result: "passed",
        },
      },
    });

    expect(correlation.authority).toBe("activity_result_only");
    expect(correlation.assessment).toMatchObject({
      canSupportClaimDirectly: false,
      canBeEvidenceRefDirectly: false,
      canBeProofDirectly: false,
      eligibleForKernelProof: false,
      requiredAmcaEventType: "EffectReceiptRecorded",
    });
  });

  it("correlates a Temporal activity to AMCA evidence only after EffectReceiptRecorded exists", () => {
    const envelope = buildTemporalActivityEnvelope({
      boundary,
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
    });
    const receipt = effectReceipt(envelope.effectId);
    const correlation = correlateTemporalActivityReceipt({
      envelope,
      activityResult: {
        status: "completed",
        completedAt: now,
        attempt: 1,
        result: receipt.payload,
      },
      effectReceiptRecordedEvent: effectReceiptRecorded(receipt),
    });

    expect(correlation).toMatchObject({
      authority: "amca_effect_receipt_recorded",
      effectReceiptRecordedEventId: "evt_temporal_receipt_recorded",
      receiptId: receipt.receiptId,
      receiptPayloadHash: receipt.payloadHash,
      assessment: {
        canSupportClaimDirectly: false,
        eligibleForKernelProof: true,
      },
    });
  });

  it("keeps Temporal history out of EvidenceRef and proof authority", () => {
    const history = {
      workflowId: boundary.workflowId,
      workflowRunId: boundary.workflowRunId,
      events: [
        {
          eventId: "1",
          eventType: "WorkflowExecutionStarted",
          attributes: {
            taskQueue: "amca-test",
          },
        },
        {
          eventId: "2",
          eventType: "ActivityTaskCompleted",
          attributes: {
            activityId: "activity_run_tests",
          },
        },
      ],
    };

    expect(assessTemporalHistoryAuthority(history)).toMatchObject({
      status: "temporal_history_only",
      canSupportClaimDirectly: false,
      canBeEvidenceRefDirectly: false,
      canBeProofDirectly: false,
      eligibleForKernelProof: false,
    });
    expect(validateEvidenceRef(temporalHistoryPayload(history)).success).toBe(
      false,
    );
    expect(JSON.stringify(temporalHistoryPayload(history))).toContain(
      "ActivityTaskCompleted",
    );
  });

  it("temporal-workflow-output-becomes-final-candidate", () => {
    const workflowBoundary = new TemporalWorkflowBoundary(boundary);
    const translated = translateTemporalWorkflowOutputToFinalCandidate({
      boundary,
      workflowOutput: {
        kind: "structured_final_candidate",
        workflowId: boundary.workflowId,
        workflowRunId: boundary.workflowRunId,
        finalCandidate: finalCandidate(),
      },
    });
    const emitted = workflowBoundary.workflowOutputEmission({
      kind: "structured_final_candidate",
      emissionId: "emission_temporal_workflow_final",
      workflowId: boundary.workflowId,
      workflowRunId: boundary.workflowRunId,
      finalCandidate: finalCandidate(),
    });

    expect(translated).toMatchObject({
      kind: "final_candidate",
      candidateId: "candidate_temporal",
      runId,
    });
    expect(emitted).toMatchObject({
      kind: "final_output",
      substrate: "temporal",
      finalCandidate: {
        candidateId: "candidate_temporal",
      },
      metadata: {
        workflowId: boundary.workflowId,
        metadataOnly: true,
        proofRole: "none",
      },
    });
  });

  it("temporal-raw-workflow-output-bypass-blocked", () => {
    const workflowBoundary = new TemporalWorkflowBoundary(boundary);
    const rawOutput: TemporalWorkflowRawTextOutput = {
      kind: "raw_text",
      workflowId: boundary.workflowId,
      workflowRunId: boundary.workflowRunId,
      text: "Temporal workflow completed; release this raw answer.",
    };
    const report = workflowBoundary.conformanceReport([
      workflowBoundary.rawWorkflowOutputEmission({
        ...rawOutput,
        emissionId: "emission_temporal_raw_final",
      }),
    ]);

    expect(() =>
      translateTemporalWorkflowOutputToFinalCandidate({
        boundary,
        workflowOutput: rawOutput,
      }),
    ).toThrow(TemporalBoundaryError);
    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "raw_final_text_forbidden",
    );
  });
});

describe("Temporal adapter conformance helper", () => {
  it("passes the shared adapter conformance contract for governed emissions", () => {
    const report = createTemporalConformanceReport({
      adapterId: boundary.adapterId,
      runId,
      emissions: [
        {
          kind: "tool_call",
          emissionId: "emission_temporal_tool",
          adapterId: boundary.adapterId,
          substrate: "temporal",
          runId,
          toolCommand: toolCommandRequest(),
        },
        {
          kind: "final_output",
          emissionId: "emission_temporal_final",
          adapterId: boundary.adapterId,
          substrate: "temporal",
          runId,
          finalCandidate: finalCandidate(),
        },
      ],
    });

    expect(report).toMatchObject({
      status: "pass",
      toolCommandCount: 1,
      finalCandidateCount: 1,
      issues: [],
    });
  });

  it("exposes a deterministic workflow boundary helper", () => {
    const workflowBoundary = new TemporalWorkflowBoundary(boundary);
    const envelope = workflowBoundary.buildActivityEnvelope({
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
    });
    const contract = createTemporalAdapterBoundaryContract({
      adapterId: boundary.adapterId,
      runId,
    });

    expect(workflowBoundary.descriptor()).toMatchObject(boundary);
    expect(envelope.runId).toBe(runId);
    expect(contract.substrate).toBe("temporal");
  });

  it("temporal-worker-execution-unavailable-before-certification", () => {
    expect(
      validateCertificationManifest(TEMPORAL_ADAPTER_CERTIFICATION).success,
    ).toBe(true);
    expect(TEMPORAL_ADAPTER_CERTIFICATION).toMatchObject({
      currentLevel: "level_1_proposal_adapter",
      targetLevel: "level_2_tool_intercepting",
    });
    expect(TEMPORAL_ADAPTER_CERTIFICATION.forbiddenAuthority).toContain(
      "worker runtime execution",
    );
    expect(temporalExports).not.toHaveProperty("createTemporalWorker");
    expect(temporalExports).not.toHaveProperty("runTemporalWorker");
    expect(temporalExports).not.toHaveProperty("executeTemporalWorkflow");
    expect(temporalExports).not.toHaveProperty("startTemporalActivity");
    expect(temporalExports).not.toHaveProperty("admitTemporalReceipt");
    expect(temporalExports).not.toHaveProperty("releaseTemporalDecision");
  });

  it("temporal-worker-wrapper-remains-non-executing-without-approved-service", () => {
    const workerBoundary = new TemporalWorkerBoundary(boundary);
    const candidate = workerBoundary.activityExecutionCandidate({
      effectRequest: effectRequest(),
      activityId: "activity_run_tests",
    });

    expect(workerBoundary.descriptor()).toMatchObject({
      wrapperKind: "temporal_worker_wrapper_boundary",
      canStartWorker: false,
      canExecuteWorkflow: false,
      canEmitReceiptDirectly: false,
      canSupportClaimDirectly: false,
    });
    expect(candidate).toMatchObject({
      candidateKind: "temporal_activity_execution_candidate",
      executionStatus: "not_started",
      requiresApprovedTemporalService: true,
      canStartWorker: false,
      canEmitReceiptDirectly: false,
      canSupportClaimDirectly: false,
      effectCandidate: {
        canExecuteDirectly: false,
        canEmitReceiptDirectly: false,
        canSupportClaimDirectly: false,
      },
    });
    expect(workerBoundary.liveCertificationGap()).toEqual(
      TEMPORAL_LIVE_WORKER_CERTIFICATION_GAP,
    );
    expect(TEMPORAL_LIVE_WORKER_CERTIFICATION_GAP).toMatchObject({
      status: "blocked_without_approved_temporal_service",
      workerRuntimeReady: false,
      liveTemporalServiceUsed: false,
    });
  });
});

function effectRequest(): EffectRequest {
  return {
    effectId: "effect_temporal_test",
    commandId: "command_temporal_test",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    requestedAt: now,
    idempotencyKey: "idem-temporal-test",
  };
}

function toolCommandRequest(): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: "command_temporal_test",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    idempotencyKey: "idem-temporal-test",
  };
}

function finalCandidate(): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: "candidate_temporal",
    runId,
    claims: [
      {
        claimId: "claim_temporal_tests",
        type: "test_result",
        statement: "Tests passed.",
        predicate: {
          kind: "test_result",
          capabilityId: "shell.run_tests",
          expectedStatus: "passed",
          requiredReceiptType: "test_run",
        },
        evidenceRefs: [],
        criticality: "medium",
      },
    ],
  };
}

function effectReceipt(effectId: string): EffectReceipt {
  return {
    receiptId: "receipt_temporal_test",
    effectId,
    runId,
    capabilityId: "shell.run_tests",
    receiptType: "test_run",
    status: "succeeded",
    payload: {
      result: "passed",
    },
    payloadHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    evidence: [
      {
        evidenceId: "ev_temporal_receipt",
        kind: "effect_receipt",
        sourceEventId: "evt_temporal_receipt_recorded",
        hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        observedAt: now,
        sensitivity: "internal",
      },
    ],
    observedAt: now,
  };
}

function effectReceiptRecorded(
  receipt: EffectReceipt,
): RunEvent<"EffectReceiptRecorded"> {
  return {
    eventId: "evt_temporal_receipt_recorded",
    runId,
    sequence: 3,
    type: "EffectReceiptRecorded",
    payload: {
      receipt,
    },
    payloadHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    causationId: "evt_temporal_effect_requested",
    correlationId: null,
    occurredAt: now,
  };
}
