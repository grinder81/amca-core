import { describe, expect, it } from "vitest";

import { validateCertificationManifest } from "@amca/adapters-conformance";
import {
  normalizeProviderCompletion,
  PROVIDER_HARNESS_CERTIFICATION,
  PROVIDER_HARNESS_MATURITY,
  type ProviderChatCompletion,
  type ProviderToolBinding,
} from "@amca/provider-harness";
import { hashRunEventPayload } from "@amca/kernel";
import type {
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  Mismatch,
} from "@amca/protocol";

import {
  FRESH_OBSERVED_AT,
  GENERATED_AT,
  candidateWith,
  effectEvidenceRef,
  eventTypes,
  observationEvidenceRef,
  pullRequestStateObservation,
  startedKernel,
  testResultClaim,
  testRunEffectRequest,
  testRunPayload,
  testRunReceipt,
} from "./mission-helpers.js";

const runId = "mission_provider_harness";

const readTool: ProviderToolBinding = {
  name: "Read",
  capabilityId: "local_readonly.file_read",
  toolId: "local.read_file",
  sideEffectClass: "read",
};

describe("Mission P8/P9 provider harness containment", () => {
  it("treats provider output as proposal candidates, not AMCA authority", () => {
    const result = normalizeProviderCompletion({
      runId,
      completion: {
        content: "",
        toolCalls: [
          {
            id: "call_provider_read",
            name: "Read",
            arguments: { path: "README.md" },
          },
        ],
        metadata: providerMetadata(["call_provider_read"]),
      },
      tools: [readTool],
    });

    expect(result.status).toBe("accepted");
    expect(result.toolCommandCandidates).toHaveLength(1);
    expect(result.emissions.map((emission) => emission.kind)).toContain(
      "tool_call",
    );
    expect(result.emissions.map((emission) => emission.kind)).not.toContain(
      "effect_receipt",
    );
    expect(result.emissions.map((emission) => emission.kind)).not.toContain(
      "proof_object",
    );
    expect(result.emissions.map((emission) => emission.kind)).not.toContain(
      "release_decision",
    );
    expect(result.metadata.proofUsable).toBe(false);
  });

  it("blocks raw final text and provider traces as release or proof paths", () => {
    const result = normalizeProviderCompletion({
      runId,
      completion: {
        content: "I ran the tests and they passed.",
        toolCalls: [],
        metadata: providerMetadata([]),
      },
      tools: [readTool],
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "provider_invalid_json",
          "raw_final_text_forbidden",
        ]),
      );
      expect(
        result.emissions.some(
          (emission) =>
            emission.kind === "substrate_state" &&
            emission.usedAsEvidence === true,
        ),
      ).toBe(false);
    }
  });

  it("blocks provider attempts to emit proof, receipt, or release authority", () => {
    for (const content of [
      JSON.stringify({ kind: "tool_result", status: "succeeded" }),
      JSON.stringify({
        kind: "final_candidate",
        candidateId: "candidate_bad",
        runId,
        claims: [],
        proofObject: { verdict: "pass" },
      }),
      JSON.stringify({ releaseDecision: { status: "released" } }),
    ]) {
      const result = normalizeProviderCompletion({
        runId,
        completion: {
          content,
          toolCalls: [],
          metadata: providerMetadata([]),
        },
        tools: [readTool],
      });

      expect(result.status).toBe("blocked");
    }
  });

  it("provider-final-candidate-references-nonexistent-evidence-blocked", () => {
    const runId = "mission_phase63_provider_nonexistent_evidence";
    const evidenceRef = effectEvidenceRef(
      "ev_phase63_nonexistent",
      hashRunEventPayload({ result: "passed", testSuiteId: "unit" }),
      {
        sourceEventId: "evt_phase63_nonexistent_receipt",
      },
    );

    expectProviderFinalCandidateBlockedByKernel({
      runId,
      candidate: candidateWith(
        runId,
        testResultClaim({ evidenceRefs: [evidenceRef], testSuiteId: "unit" }),
      ),
      expectedMismatchType: "unverified_receipt",
    });
  });

  it("provider-final-candidate-references-wrong-run-evidence-blocked", () => {
    const runId = "mission_phase63_provider_wrong_run_evidence";
    const foreignRunId = `${runId}_foreign`;
    const payload = testRunPayload({ testSuiteId: "unit" });
    const evidenceRef = effectEvidenceRef(
      "ev_phase63_foreign_receipt",
      hashRunEventPayload(payload),
      {
        sourceEventId: "evt_phase63_foreign_receipt",
      },
    );
    const foreignKernel = startedKernel(foreignRunId);
    foreignKernel.recordEffectRequest(testRunEffectRequest(foreignRunId));
    foreignKernel.recordEffectReceipt(
      testRunReceipt(foreignRunId, {
        evidence: [evidenceRef],
        payload,
      }),
      {
        eventId: evidenceRef.sourceEventId,
        occurredAt: FRESH_OBSERVED_AT,
      },
    );

    expect(eventTypes(foreignKernel)).toContain("EffectReceiptRecorded");
    expectProviderFinalCandidateBlockedByKernel({
      runId,
      candidate: candidateWith(
        runId,
        testResultClaim({ evidenceRefs: [evidenceRef], testSuiteId: "unit" }),
      ),
      expectedMismatchType: "unverified_receipt",
    });
  });

  it("provider-final-candidate-references-evidence-with-wrong-kind-blocked", () => {
    const runId = "mission_phase63_provider_wrong_kind_evidence";
    const observedState = { state: "open" };
    const evidenceRef = observationEvidenceRef(
      "ev_phase63_observation_not_receipt",
      hashRunEventPayload(observedState),
      {
        sourceEventId: "evt_phase63_observation_not_receipt",
      },
    );

    const { kernel } = expectProviderFinalCandidateBlockedByKernel({
      runId,
      candidate: candidateWith(
        runId,
        testResultClaim({ evidenceRefs: [evidenceRef], testSuiteId: "unit" }),
      ),
      expectedMismatchType: "missing_evidence",
      configureKernel(kernel) {
        kernel.recordExternalStateObservation(
          pullRequestStateObservation(runId, {
            evidence: [evidenceRef],
            observedState,
          }),
          {
            eventId: evidenceRef.sourceEventId,
            occurredAt: FRESH_OBSERVED_AT,
          },
        );
      },
    });

    expect(eventTypes(kernel)).toContain("ExternalStateObserved");
  });

  it("provider-final-candidate-references-valid-evidence-for-wrong-claim-blocked", () => {
    const runId = "mission_phase63_provider_valid_evidence_wrong_claim";
    const payload = testRunPayload({ testSuiteId: "integration" });
    const evidenceRef = effectEvidenceRef(
      "ev_phase63_integration_receipt",
      hashRunEventPayload(payload),
      {
        sourceEventId: "evt_phase63_integration_receipt",
      },
    );

    expectProviderFinalCandidateBlockedByKernel({
      runId,
      candidate: candidateWith(
        runId,
        testResultClaim({ evidenceRefs: [evidenceRef], testSuiteId: "unit" }),
      ),
      expectedMismatchType: "unsupported_claim",
      configureKernel(kernel) {
        admitTestReceipt(kernel, runId, evidenceRef, payload);
      },
    });
  });

  it("provider-final-candidate-omits-evidence-ref-blocked", () => {
    const runId = "mission_phase63_provider_omits_evidence_ref";

    expectProviderFinalCandidateBlockedByKernel({
      runId,
      candidate: candidateWith(
        runId,
        testResultClaim({ evidenceRefs: [], testSuiteId: "unit" }),
      ),
      expectedMismatchType: "missing_evidence",
    });
  });

  it("provider-final-candidate-uses-provider-response-id-as-evidence-blocked", () => {
    const runId = "mission_phase63_provider_response_id_evidence";
    const responseId = "chatcmpl_phase63_not_evidence";
    const result = normalizeProviderCompletion({
      runId,
      completion: providerCompletion({
        content: JSON.stringify(
          candidateWith(
            runId,
            testResultClaim({
              evidenceRefs: [providerIdEvidenceRef(responseId)],
              testSuiteId: "unit",
            }),
          ),
        ),
        metadata: { responseId },
      }),
      tools: [readTool],
    });

    expectBlockedWithIssue(result, "provider_metadata_evidence_ref_forbidden");
    expectProviderMetadataNotEvidence(result);
    expect(result.proposalCandidates).toEqual([]);
  });

  it("provider-final-candidate-uses-tool-call-id-as-evidence-blocked", () => {
    const runId = "mission_phase63_provider_tool_call_id_evidence";
    const toolCallId = "call_phase63_not_evidence";
    const result = normalizeProviderCompletion({
      runId,
      completion: providerCompletion({
        content: JSON.stringify(
          candidateWith(
            runId,
            testResultClaim({
              evidenceRefs: [providerIdEvidenceRef(toolCallId)],
              testSuiteId: "unit",
            }),
          ),
        ),
        metadata: { toolCallIds: [toolCallId] },
        toolCalls: [
          {
            id: toolCallId,
            name: "Read",
            arguments: { path: "README.md" },
          },
        ],
      }),
      tools: [readTool],
    });

    expectBlockedWithIssue(result, "provider_metadata_evidence_ref_forbidden");
    expectProviderMetadataNotEvidence(result);
    expect(result.toolCommandCandidates).toHaveLength(1);
    expect(result.emissions.map((emission) => emission.kind)).toContain(
      "tool_call",
    );
    expect(result.emissions.map((emission) => emission.kind)).not.toContain(
      "effect_receipt",
    );
  });

  it("declares provider harness certification without live-certification overclaiming", () => {
    expect(
      validateCertificationManifest(PROVIDER_HARNESS_CERTIFICATION).success,
    ).toBe(true);
    expect(PROVIDER_HARNESS_CERTIFICATION.adapterKind).toBe("model_adapter");
    expect(PROVIDER_HARNESS_MATURITY.liveProviderCertified).toBe(false);
    expect(PROVIDER_HARNESS_MATURITY.proofAuthority).toBe(false);
    expect(PROVIDER_HARNESS_MATURITY.receiptAdmissionAuthority).toBe(false);
    expect(PROVIDER_HARNESS_MATURITY.releaseAuthority).toBe(false);
  });
});

function expectProviderFinalCandidateBlockedByKernel(input: {
  readonly runId: string;
  readonly candidate: FinalCandidate;
  readonly expectedMismatchType: Mismatch["type"];
  readonly configureKernel?: (kernel: ReturnType<typeof startedKernel>) => void;
}): {
  readonly kernel: ReturnType<typeof startedKernel>;
} {
  const normalized = normalizeProviderCompletion({
    runId: input.runId,
    completion: providerCompletion({
      content: JSON.stringify(input.candidate),
    }),
    tools: [readTool],
  });
  expect(normalized.status).toBe("accepted");
  expectProviderMetadataNotEvidence(normalized);

  if (normalized.status !== "accepted") {
    throw new Error("Expected provider final candidate proposal to normalize.");
  }

  const candidate = normalized.proposalCandidates.find(
    (proposal): proposal is FinalCandidate =>
      proposal.kind === "final_candidate",
  );
  if (candidate === undefined) {
    throw new Error("Expected a normalized FinalCandidate proposal.");
  }

  const kernel = startedKernel(input.runId);
  input.configureKernel?.(kernel);

  const submission = kernel.submitFinalCandidate(candidate, {
    occurredAt: GENERATED_AT,
    generatedAt: GENERATED_AT,
  });

  expect(submission.proof.verdict).toBe("fail");
  expect(submission.decision.status).toBe("blocked");
  expect(submission.proof.blockingMismatches).toContainEqual(
    expect.objectContaining({
      type: input.expectedMismatchType,
      blocking: true,
    }),
  );
  expect(submission.finalReleasedEvent).toBeUndefined();
  expect(eventTypes(kernel)).not.toContain("FinalReleased");

  return { kernel };
}

function admitTestReceipt(
  kernel: ReturnType<typeof startedKernel>,
  runId: string,
  evidenceRef: EvidenceRef,
  payload: JsonObject,
): void {
  kernel.recordEffectRequest(testRunEffectRequest(runId));
  kernel.recordEffectReceipt(
    testRunReceipt(runId, {
      evidence: [evidenceRef],
      payload,
    }),
    {
      eventId: evidenceRef.sourceEventId,
      occurredAt: FRESH_OBSERVED_AT,
    },
  );
}

function providerCompletion(input: {
  readonly content: string;
  readonly metadata?: Partial<ProviderChatCompletion["metadata"]>;
  readonly toolCalls?: ProviderChatCompletion["toolCalls"];
}): ProviderChatCompletion {
  const toolCalls = input.toolCalls ?? [];
  const toolCallIds =
    input.metadata?.toolCallIds ?? toolCalls.map((toolCall) => toolCall.id);

  return {
    content: input.content,
    toolCalls,
    metadata: {
      provider: "openai-compatible",
      model: "code",
      toolCallIds,
      proofUsable: false,
      ...input.metadata,
    },
  };
}

function providerIdEvidenceRef(providerId: string): EvidenceRef {
  return effectEvidenceRef(providerId, hashRunEventPayload({ providerId }), {
    sourceEventId: providerId,
  });
}

function expectBlockedWithIssue(
  result: ReturnType<typeof normalizeProviderCompletion>,
  code: string,
): void {
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") {
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  }
}

function expectProviderMetadataNotEvidence(
  result: ReturnType<typeof normalizeProviderCompletion>,
): void {
  expect(result.metadata.proofUsable).toBe(false);
  expect(
    result.emissions.some(
      (emission) =>
        emission.kind === "substrate_state" && emission.usedAsEvidence === true,
    ),
  ).toBe(false);
}

function providerMetadata(
  toolCallIds: readonly string[],
): ProviderChatCompletion["metadata"] {
  return {
    provider: "openai-compatible",
    model: "code",
    toolCallIds,
    proofUsable: false,
  };
}
