import { canonicalObjectHash } from "@amca/contracts";
import { LocalRunHarness, type LocalRunHarnessOptions } from "@amca/harness";
import {
  createOpenCodeCompatibleLocalProviderConfig,
  normalizeProviderCompletion,
  OpenAICompatibleLocalProvider,
  type ProviderToolBinding,
} from "@amca/provider-harness";
import type {
  Claim,
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  Proposal,
  ReceiptCandidate,
  RunEventType,
  ToolCommandRequest,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

const liveDescribe =
  process.env.AMCA_PROVIDER_LIVE === "1" ? describe : describe.skip;

const STARTED_AT = "2026-05-24T11:58:00.000Z";
const NOW = "2026-05-24T12:00:00.000Z";
const CAPABILITY_ID = "amca.test.run_tests";
const TOOL_ID = "amca.test.run_tests";
const TEST_SUITE_ID = "phase63";
const RECEIPT_TYPE = "test_run";

type BrokerOptions = NonNullable<LocalRunHarnessOptions["brokerOptions"]>;
type Capability = NonNullable<BrokerOptions["capabilities"]>[number];
type Adapter = NonNullable<BrokerOptions["adapters"]>[number];

liveDescribe("Mission Phase 63 live provider E2E loop certification", () => {
  it("live-provider-e2e-tool-to-evidence-to-release", async () => {
    const provider = liveProvider();
    const runId = "run_phase63_live_e2e";
    const fixture = testResultFixture(runId);
    const harness = startedHarness(fixture);

    const toolProposalCompletion = await provider.complete({
      runId,
      messages: [
        {
          role: "system",
          content:
            "Return only JSON matching AMCA ToolCommandRequest. Do not include markdown, commentary, proof, release, receipt, tool-result, mutation, approval, or final-event fields. Do not execute the tool.",
        },
        {
          role: "user",
          content: exactJsonPrompt({
            kind: "tool_command_request",
            commandId: fixture.command.commandId,
            runId,
            capabilityId: CAPABILITY_ID,
            toolId: TOOL_ID,
            args: { testSuiteId: TEST_SUITE_ID },
            sideEffectClass: "compute",
          }),
        },
      ],
      tools: [testRunToolBinding()],
    });
    const toolProposalResult = normalizeProviderCompletion({
      runId,
      completion: toolProposalCompletion,
      tools: [testRunToolBinding()],
    });

    expect(toolProposalResult.status).toBe("accepted");
    if (toolProposalResult.status !== "accepted") {
      throw new Error("expected live provider tool proposal to be accepted");
    }
    expect(toolProposalResult.metadata.proofUsable).toBe(false);
    expect(
      toolProposalResult.emissions.map((emission) => emission.kind),
    ).not.toContain("effect_receipt");
    expect(
      toolProposalResult.emissions.map((emission) => emission.kind),
    ).not.toContain("release_decision");
    expect(fixture.calls).toHaveLength(0);

    const toolCommand = expectProposalKind(
      toolProposalResult.proposalCandidates,
      "tool_command_request",
    );
    const dispatch = await harness.dispatchToolCommand(toolCommand, {
      effectReceiptEvent: {
        eventId: `evt_${toolCommand.commandId}_receipt_recorded`,
      },
    });
    const admittedEvidence = dispatch.recordedReceipt.evidence[0];
    if (admittedEvidence === undefined) {
      throw new Error("expected admitted effect evidence");
    }
    const safeContext = providerEvidenceContext({
      evidenceRef: admittedEvidence,
      receiptType: dispatch.recordedReceipt.receiptType,
      result: "passed",
      testSuiteId: TEST_SUITE_ID,
    });

    expect(fixture.calls).toHaveLength(1);
    expect(dispatch.effectRequestEvent.causationId).toBe(
      dispatch.proposalEvent.eventId,
    );
    expect(dispatch.effectReceiptEvent.causationId).toBe(
      dispatch.effectRequestEvent.eventId,
    );
    expect(admittedEvidence.sourceEventId).toBe(
      dispatch.effectReceiptEvent.eventId,
    );
    expect(safeContext).not.toHaveProperty("proof");
    expect(safeContext).not.toHaveProperty("releaseDecision");
    expect(safeContext).not.toHaveProperty("effectReceipt");
    expect(safeContext).not.toHaveProperty("apiKey");
    expect(safeContext).not.toHaveProperty("authorization");

    const expectedFinalCandidate = finalCandidateForEvidence({
      runId,
      evidenceRef: admittedEvidence,
      candidateId: "candidate_phase63_supported",
      claimId: "claim_phase63_supported_tests_passed",
    });
    const finalCompletion = await provider.complete({
      runId,
      messages: [
        {
          role: "system",
          content:
            "Return only JSON matching AMCA FinalCandidate. Use only the provided admitted evidence reference. Do not include markdown, commentary, proof, release, receipt, tool-result, mutation, approval, or final-event fields.",
        },
        {
          role: "user",
          content: [
            "Safe AMCA evidence context:",
            JSON.stringify(safeContext, null, 2),
            "",
            exactJsonPrompt(expectedFinalCandidate),
          ].join("\n"),
        },
      ],
    });
    const finalProposalResult = normalizeProviderCompletion({
      runId,
      completion: finalCompletion,
    });

    expect(finalProposalResult.status).toBe("accepted");
    if (finalProposalResult.status !== "accepted") {
      throw new Error("expected live provider final candidate to be accepted");
    }
    expect(finalProposalResult.metadata.proofUsable).toBe(false);
    const finalCandidate = expectProposalKind(
      finalProposalResult.proposalCandidates,
      "final_candidate",
    );
    const release = harness.submitFinalCandidate(finalCandidate, {
      occurredAt: NOW,
      generatedAt: NOW,
      causationId: dispatch.effectReceiptEvent.eventId,
    });

    expect(release.proof.verdict).toBe("pass");
    expect(release.decision.status).toBe("released");
    expect(release.finalReleasedEvent).toBeDefined();
    expect(release.finalReleasedEvent?.causationId).toBe(
      release.releaseEvent.eventId,
    );
    expect(release.finalReleasedEvent?.payload.decision.status).toBe(
      "released",
    );
    expect(release.proof.approvedClaimIds).toContain(
      "claim_phase63_supported_tests_passed",
    );
    expect(finalCandidate.claims[0]?.evidenceRefs[0]?.sourceEventId).toBe(
      dispatch.effectReceiptEvent.eventId,
    );
    expect(eventTypes(harness)).toEqual([
      "RunStarted",
      "ProposalReceived",
      "EffectRequested",
      "EffectReceiptRecorded",
      "ProposalReceived",
      "ProofGenerated",
      "ReleaseDecided",
      "FinalReleased",
    ]);
    expect(eventTypes(harness).indexOf("EffectReceiptRecorded")).toBeLessThan(
      eventTypes(harness).indexOf("ProofGenerated"),
    );
    expect(eventTypes(harness).indexOf("ReleaseDecided")).toBeLessThan(
      eventTypes(harness).indexOf("FinalReleased"),
    );
  }, 300_000);

  it("blocks a live provider unsupported final candidate before release", async () => {
    const provider = liveProvider();
    const runId = "run_phase63_live_blocked";
    const harness = new LocalRunHarness({
      runId,
      clock: () => NOW,
    });
    harness.startRun({
      occurredAt: STARTED_AT,
      profile: "standard",
    });
    const unsupportedCandidate: FinalCandidate = {
      kind: "final_candidate",
      candidateId: "candidate_phase63_unsupported",
      runId,
      claims: [
        {
          claimId: "claim_phase63_unsupported_tests_passed",
          type: "test_result",
          statement: "Tests passed.",
          predicate: {
            kind: "test_result",
            capabilityId: CAPABILITY_ID,
            expectedStatus: "passed",
            requiredReceiptType: RECEIPT_TYPE,
            testSuiteId: TEST_SUITE_ID,
          },
          evidenceRefs: [],
          criticality: "medium",
        },
      ],
    };
    const completion = await provider.complete({
      runId,
      messages: [
        {
          role: "system",
          content:
            "Return only JSON matching AMCA FinalCandidate. Do not include proof, release, receipt, tool-result, mutation, approval, or final-event fields.",
        },
        {
          role: "user",
          content: exactJsonPrompt(unsupportedCandidate),
        },
      ],
    });
    const normalized = normalizeProviderCompletion({
      runId,
      completion,
    });

    expect(normalized.status).toBe("accepted");
    if (normalized.status !== "accepted") {
      throw new Error(
        "expected live provider unsupported final candidate to normalize",
      );
    }
    const finalCandidate = expectProposalKind(
      normalized.proposalCandidates,
      "final_candidate",
    );
    const result = harness.submitFinalCandidate(finalCandidate, {
      occurredAt: NOW,
      generatedAt: NOW,
    });

    expect(result.decision.status).toBe("blocked");
    expect(result.proof.verdict).toBe("fail");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "missing_evidence",
        claimId: "claim_phase63_unsupported_tests_passed",
        blocking: true,
      }),
    );
    expect(result.finalReleasedEvent).toBeUndefined();
    expect(eventTypes(harness)).not.toContain("FinalReleased");
  }, 300_000);
});

function liveProvider(): OpenAICompatibleLocalProvider {
  return new OpenAICompatibleLocalProvider({
    config: createOpenCodeCompatibleLocalProviderConfig({
      baseUrl: requireEnv("AMCA_PROVIDER_BASE_URL"),
      model: requireEnv("AMCA_PROVIDER_MODEL"),
      apiKeyEnv: "AMCA_PROVIDER_API_KEY",
      request: {
        stream: process.env.AMCA_PROVIDER_STREAM !== "0",
      },
    }),
  });
}

function testRunToolBinding(): ProviderToolBinding {
  return {
    name: "RunTests",
    capabilityId: CAPABILITY_ID,
    toolId: TOOL_ID,
    sideEffectClass: "compute",
    inputJSONSchema: {
      type: "object",
      properties: {
        testSuiteId: { type: "string" },
      },
      required: ["testSuiteId"],
      additionalProperties: false,
    },
  };
}

function startedHarness(fixture: TestResultFixture): LocalRunHarness {
  const harness = new LocalRunHarness({
    runId: fixture.command.runId,
    brokerOptions: {
      adapters: [fixture.adapter],
      capabilities: [fixture.capability],
    },
    clock: () => NOW,
  });
  harness.startRun({
    occurredAt: STARTED_AT,
    profile: "standard",
  });
  return harness;
}

interface TestResultFixture {
  readonly command: ToolCommandRequest;
  readonly capability: Capability;
  readonly adapter: Adapter;
  readonly calls: ToolCommandRequest[];
}

function testResultFixture(runId: string): TestResultFixture {
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId: "cmd_phase63_run_tests",
    runId,
    capabilityId: CAPABILITY_ID,
    toolId: TOOL_ID,
    args: {
      testSuiteId: TEST_SUITE_ID,
    },
    sideEffectClass: "compute",
  };
  const calls: ToolCommandRequest[] = [];
  return {
    command,
    calls,
    capability: {
      schemaVersion: 1,
      capabilityId: CAPABILITY_ID,
      profile: "standard",
      sideEffectClass: "compute",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
      receiptSchema: {
        type: "object",
        additionalProperties: true,
      },
      evidence: [
        {
          evidenceKind: "effect_receipt",
          receiptType: RECEIPT_TYPE,
        },
      ],
      supportedClaims: [
        {
          claimType: "test_result",
          predicateKind: "test_result",
          requiredReceiptType: RECEIPT_TYPE,
          expectedStatuses: ["passed"],
        },
      ],
      proofRules: [],
    },
    adapter: {
      adapterId: "adapter.phase63.run_tests",
      capabilityId: CAPABILITY_ID,
      toolId: TOOL_ID,
      certification: {
        certificationVersion: 1,
        adapterId: "adapter.phase63.run_tests",
        adapterKind: "deterministic_fake",
        capabilityId: CAPABILITY_ID,
        toolId: TOOL_ID,
        sideEffectClass: "compute",
        declaredReceiptTypes: [RECEIPT_TYPE],
        idempotency: "not_required",
        riskProfile: "standard",
      },
      execute: (request) => {
        calls.push(request.toolCommand);
        const payload = {
          result: "passed",
          testSuiteId: TEST_SUITE_ID,
        };
        const payloadHash = canonicalObjectHash(payload);
        const receiptCandidate: ReceiptCandidate = {
          receiptId: `receipt_${request.effectRequest.effectId}`,
          effectId: request.effectRequest.effectId,
          runId: request.effectRequest.runId,
          capabilityId: request.effectRequest.capabilityId,
          receiptType: RECEIPT_TYPE,
          status: "succeeded",
          payload,
          payloadHash,
          evidence: [
            {
              evidenceId: `ev_${request.toolCommand.commandId}`,
              kind: "effect_receipt",
              admissionStatus: "pending",
              pendingAdmissionToken: `pending_ev_${request.toolCommand.commandId}`,
              hash: payloadHash,
              observedAt: NOW,
              sensitivity: "internal",
            },
          ],
          observedAt: NOW,
        };
        return { receiptCandidate };
      },
    },
  };
}

function finalCandidateForEvidence(input: {
  readonly runId: string;
  readonly evidenceRef: EvidenceRef;
  readonly candidateId: string;
  readonly claimId: string;
}): FinalCandidate {
  const claim: Claim = {
    claimId: input.claimId,
    type: "test_result",
    statement: "Tests passed.",
    predicate: {
      kind: "test_result",
      capabilityId: CAPABILITY_ID,
      expectedStatus: "passed",
      requiredReceiptType: RECEIPT_TYPE,
      testSuiteId: TEST_SUITE_ID,
    },
    evidenceRefs: [input.evidenceRef],
    criticality: "medium",
  };
  return {
    kind: "final_candidate",
    candidateId: input.candidateId,
    runId: input.runId,
    claims: [claim],
  };
}

function providerEvidenceContext(input: {
  readonly evidenceRef: EvidenceRef;
  readonly receiptType: string;
  readonly result: "passed" | "failed";
  readonly testSuiteId: string;
}): JsonObject {
  return {
    evidence: {
      evidenceId: input.evidenceRef.evidenceId,
      kind: input.evidenceRef.kind,
      sourceEventId: input.evidenceRef.sourceEventId,
      hash: input.evidenceRef.hash,
      observedAt: input.evidenceRef.observedAt,
      sensitivity: input.evidenceRef.sensitivity,
    },
    receiptType: input.receiptType,
    summary: {
      result: input.result,
      testSuiteId: input.testSuiteId,
    },
    redaction: "minimal_non_secret_context",
  };
}

function expectProposalKind<TKind extends Proposal["kind"]>(
  proposals: readonly Proposal[],
  kind: TKind,
): Extract<Proposal, { readonly kind: TKind }> {
  const proposal = proposals.find((candidate) => candidate.kind === kind);
  if (proposal === undefined) {
    throw new Error(`expected provider proposal of kind ${kind}`);
  }
  return proposal as Extract<Proposal, { readonly kind: TKind }>;
}

function exactJsonPrompt(value: unknown): string {
  return [
    "Return exactly this JSON object and no other text:",
    JSON.stringify(value, null, 2),
  ].join("\n");
}

function eventTypes(harness: LocalRunHarness): RunEventType[] {
  return harness.kernel.events().map((event) => event.type);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for AMCA_PROVIDER_LIVE=1`);
  }
  return value;
}
