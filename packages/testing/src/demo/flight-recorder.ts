import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalObjectHash } from "@amca/contracts";
import { LocalRunHarness, type LocalRunHarnessOptions } from "@amca/harness";
import type { SubmitFinalCandidateResult } from "@amca/kernel";
import {
  createOpenCodeCompatibleLocalProviderConfig,
  normalizeProviderCompletion,
  OpenAICompatibleLocalProvider,
  redactProviderValue,
  type ProviderChatCompletion,
  type ProviderProposalResult,
  type ProviderToolBinding,
} from "@amca/provider-harness";
import type {
  Claim,
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  JsonValue,
  Proposal,
  ReceiptCandidate,
  RunEvent,
  RunEventType,
  ToolCommandRequest,
} from "@amca/protocol";
import { format } from "prettier";

const CAPABILITY_ID = "amca.test.run_tests";
const TOOL_ID = "amca.test.run_tests";
const TEST_SUITE_ID = "flight-recorder";
const RECEIPT_TYPE = "test_run";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEMO_ROOT = path.join(REPO_ROOT, ".amca/demo-runs/flight-recorder");

type BrokerOptions = NonNullable<LocalRunHarnessOptions["brokerOptions"]>;
type Capability = NonNullable<BrokerOptions["capabilities"]>[number];
type Adapter = NonNullable<BrokerOptions["adapters"]>[number];

interface TestResultFixture {
  readonly command: ToolCommandRequest;
  readonly capability: Capability;
  readonly adapter: Adapter;
  readonly calls: ToolCommandRequest[];
}

interface SupportedRunResult {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly fixture: TestResultFixture;
  readonly toolCompletion: ProviderChatCompletion;
  readonly toolProposalResult: ProviderProposalResult;
  readonly toolCommand: ToolCommandRequest;
  readonly safeContext: JsonObject;
  readonly finalCompletion: ProviderChatCompletion;
  readonly finalProposalResult: ProviderProposalResult;
  readonly finalCandidate: FinalCandidate;
  readonly release: SubmitFinalCandidateResult;
  readonly events: readonly RunEvent[];
  readonly dispatch: Awaited<
    ReturnType<LocalRunHarness["dispatchToolCommand"]>
  >;
}

interface BlockedRunResult {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly completion: ProviderChatCompletion;
  readonly normalized: ProviderProposalResult;
  readonly finalCandidate: FinalCandidate;
  readonly release: SubmitFinalCandidateResult;
  readonly events: readonly RunEvent[];
}

interface RunBundle {
  readonly outputDir: string;
  readonly timestamp: string;
  readonly timestampSlug: string;
  readonly sourceCommit: string;
  readonly supported: SupportedRunResult;
  readonly blocked: BlockedRunResult;
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  const timestampSlug = slugTimestamp(timestamp);
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const outputDir = path.join(DEMO_ROOT, timestampSlug);
  const provider = liveProvider();

  const supported = await runSupportedProviderLoop(provider);
  const blocked = await runBlockedProviderLoop(provider);

  assertSupportedRun(supported);
  assertBlockedRun(blocked);

  const bundle: RunBundle = {
    outputDir,
    timestamp,
    timestampSlug,
    sourceCommit,
    supported,
    blocked,
  };

  await writeEvidenceBundle(bundle);

  console.log(
    [
      "AMCA flight recorder run completed.",
      `timestamp: ${timestamp}`,
      `sourceCommitAtRunStart: ${sourceCommit}`,
      `outputDir: ${path.relative(REPO_ROOT, outputDir)}`,
      `supportedRun.release: ${supported.release.decision.status}`,
      `blockedRun.release: ${blocked.release.decision.status}`,
      `supportedRun.events: ${eventTypes(supported.events).join(" -> ")}`,
      `blockedRun.events: ${eventTypes(blocked.events).join(" -> ")}`,
    ].join("\n"),
  );
}

async function runSupportedProviderLoop(
  provider: OpenAICompatibleLocalProvider,
): Promise<SupportedRunResult> {
  const startedAt = new Date().toISOString();
  const runId = runIdFromTimestamp("demo_supported", startedAt);
  const fixture = testResultFixture(runId);
  const harness = startedHarness(fixture, startedAt);

  const toolCompletion = await provider.complete({
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
    completion: toolCompletion,
    tools: [testRunToolBinding()],
  });

  if (toolProposalResult.status !== "accepted") {
    throw new Error("live provider tool proposal was not accepted");
  }

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
    throw new Error("governed effect did not admit evidence");
  }
  const safeContext = providerEvidenceContext({
    evidenceRef: admittedEvidence,
    receiptType: dispatch.recordedReceipt.receiptType,
    result: "passed",
    testSuiteId: TEST_SUITE_ID,
  });
  const expectedFinalCandidate = finalCandidateForEvidence({
    runId,
    evidenceRef: admittedEvidence,
    candidateId: "candidate_demo_supported",
    claimId: "claim_demo_supported_tests_passed",
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

  if (finalProposalResult.status !== "accepted") {
    throw new Error("live provider final candidate was not accepted");
  }

  const finalCandidate = expectProposalKind(
    finalProposalResult.proposalCandidates,
    "final_candidate",
  );
  const release = harness.submitFinalCandidate(finalCandidate, {
    occurredAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    causationId: dispatch.effectReceiptEvent.eventId,
  });

  return {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    fixture,
    toolCompletion,
    toolProposalResult,
    toolCommand,
    safeContext,
    finalCompletion,
    finalProposalResult,
    finalCandidate,
    release,
    events: harness.kernel.events(),
    dispatch,
  };
}

async function runBlockedProviderLoop(
  provider: OpenAICompatibleLocalProvider,
): Promise<BlockedRunResult> {
  const startedAt = new Date().toISOString();
  const runId = runIdFromTimestamp("demo_blocked", startedAt);
  const harness = new LocalRunHarness({
    runId,
    clock: () => new Date().toISOString(),
  });
  harness.startRun({
    occurredAt: startedAt,
    profile: "standard",
  });
  const unsupportedCandidate: FinalCandidate = {
    kind: "final_candidate",
    candidateId: "candidate_demo_unsupported",
    runId,
    claims: [
      {
        claimId: "claim_demo_unsupported_tests_passed",
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

  if (normalized.status !== "accepted") {
    throw new Error("live provider unsupported final candidate did not parse");
  }

  const finalCandidate = expectProposalKind(
    normalized.proposalCandidates,
    "final_candidate",
  );
  const release = harness.submitFinalCandidate(finalCandidate, {
    occurredAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
  });

  return {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    completion,
    normalized,
    finalCandidate,
    release,
    events: harness.kernel.events(),
  };
}

async function writeEvidenceBundle(bundle: RunBundle): Promise<void> {
  await mkdir(bundle.outputDir, { recursive: true });

  const supported = bundle.supported;
  const blocked = bundle.blocked;

  await writeJson(path.join(bundle.outputDir, "run-metadata.json"), {
    kind: "amca_flight_recorder_run_metadata",
    generatedAt: bundle.timestamp,
    completedAt: new Date().toISOString(),
    sourceCommitAtRunStart: bundle.sourceCommit,
    repository: REPO_ROOT,
    command: redactedCommand(),
    provider: {
      baseUrl: requireEnv("AMCA_PROVIDER_BASE_URL"),
      model: requireEnv("AMCA_PROVIDER_MODEL"),
      apiKeyEnv: "AMCA_PROVIDER_API_KEY",
      apiKeyValue: "[REDACTED]",
      stream: process.env.AMCA_PROVIDER_STREAM !== "0",
    },
    supportedRunId: supported.runId,
    blockedRunId: blocked.runId,
    node: process.version,
    pnpmVersion: gitLike("pnpm", ["--version"]),
  });
  await writeText(
    path.join(bundle.outputDir, "commands-run.md"),
    commandsRun(bundle),
  );
  await writeJson(
    path.join(bundle.outputDir, "verification-record.json"),
    verificationRecord(bundle),
  );
  await writeJson(path.join(bundle.outputDir, "events.json"), supported.events);
  await writeJsonl(
    path.join(bundle.outputDir, "events.jsonl"),
    supported.events,
  );
  await writeJson(
    path.join(bundle.outputDir, "attack-events.json"),
    blocked.events,
  );
  await writeJsonl(
    path.join(bundle.outputDir, "attack-events.jsonl"),
    blocked.events,
  );
  await writeText(
    path.join(bundle.outputDir, "timeline.md"),
    timelineMarkdown(bundle),
  );

  await writeJson(
    path.join(bundle.outputDir, "provider-tool-completion.redacted.json"),
    redactArtifact(supported.toolCompletion),
  );
  await writeJson(
    path.join(bundle.outputDir, "tool-proposal.normalized.json"),
    redactArtifact(supported.toolProposalResult),
  );
  await writeJson(
    path.join(bundle.outputDir, "effect-request-event.json"),
    supported.dispatch.effectRequestEvent,
  );
  await writeJson(
    path.join(bundle.outputDir, "effect-receipt-recorded-event.json"),
    supported.dispatch.effectReceiptEvent,
  );
  await writeJson(
    path.join(bundle.outputDir, "admitted-evidence-ref.json"),
    supported.dispatch.recordedReceipt.evidence[0],
  );
  await writeJson(
    path.join(
      bundle.outputDir,
      "provider-context-before-final-candidate.redacted.json",
    ),
    redactArtifact(supported.safeContext),
  );
  await writeJson(
    path.join(bundle.outputDir, "provider-final-completion.redacted.json"),
    redactArtifact(supported.finalCompletion),
  );
  await writeJson(
    path.join(bundle.outputDir, "final-candidate.normalized.json"),
    redactArtifact(supported.finalProposalResult),
  );
  await writeJson(
    path.join(bundle.outputDir, "proof.json"),
    supported.release.proof,
  );
  await writeJson(
    path.join(bundle.outputDir, "release-decision.json"),
    supported.release.decision,
  );
  await writeJson(
    path.join(bundle.outputDir, "final-released-event.json"),
    supported.release.finalReleasedEvent ?? null,
  );
  await writeJson(
    path.join(bundle.outputDir, "provider-metadata-non-proof.json"),
    {
      toolProposalMetadata: supported.toolProposalResult.metadata,
      finalCandidateMetadata: supported.finalProposalResult.metadata,
      blockedCandidateMetadata: blocked.normalized.metadata,
      assertion: "provider metadata is non-proof substrate state",
    },
  );

  await writeJson(
    path.join(bundle.outputDir, "attack-provider-completion.redacted.json"),
    redactArtifact(blocked.completion),
  );
  await writeJson(
    path.join(bundle.outputDir, "attack-final-candidate.normalized.json"),
    redactArtifact(blocked.normalized),
  );
  await writeJson(
    path.join(bundle.outputDir, "attack-proof.json"),
    blocked.release.proof,
  );
  await writeJson(
    path.join(bundle.outputDir, "attack-release-decision.json"),
    blocked.release.decision,
  );

  await writeText(path.join(bundle.outputDir, "README.md"), runReadme(bundle));
  await writeJson(path.join(DEMO_ROOT, "latest-run.json"), {
    latestRun: path.relative(REPO_ROOT, bundle.outputDir),
    generatedAt: bundle.timestamp,
    sourceCommitAtRunStart: bundle.sourceCommit,
    supportedRunId: supported.runId,
    blockedRunId: blocked.runId,
    supportedReleaseStatus: supported.release.decision.status,
    blockedReleaseStatus: blocked.release.decision.status,
  });
}

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

function startedHarness(
  fixture: TestResultFixture,
  startedAt: string,
): LocalRunHarness {
  const harness = new LocalRunHarness({
    runId: fixture.command.runId,
    brokerOptions: {
      adapters: [fixture.adapter],
      capabilities: [fixture.capability],
    },
    clock: () => new Date().toISOString(),
  });
  harness.startRun({
    occurredAt: startedAt,
    profile: "standard",
  });
  return harness;
}

function testResultFixture(runId: string): TestResultFixture {
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId: `cmd_${runId}_run_tests`,
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
      adapterId: "adapter.demo.run_tests",
      capabilityId: CAPABILITY_ID,
      toolId: TOOL_ID,
      certification: {
        certificationVersion: 1,
        adapterId: "adapter.demo.run_tests",
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
        const observedAt = new Date().toISOString();
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
              observedAt,
              sensitivity: "internal",
            },
          ],
          observedAt,
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

function assertSupportedRun(result: SupportedRunResult): void {
  const types = eventTypes(result.events);
  assertEqual(result.toolProposalResult.status, "accepted", "tool proposal");
  assertEqual(result.finalProposalResult.status, "accepted", "final proposal");
  assertEqual(result.release.proof.verdict, "pass", "supported proof");
  assertEqual(result.release.decision.status, "released", "supported release");
  assertDefined(result.release.finalReleasedEvent, "FinalReleased event");
  assertEqual(result.fixture.calls.length, 1, "governed adapter call count");
  assertNoAuthorityEmission(result.toolProposalResult, "tool proposal");
  assertNoAuthorityEmission(result.finalProposalResult, "final proposal");
  assertOrder(types, "ProposalReceived", "EffectRequested");
  assertOrder(types, "EffectReceiptRecorded", "ProofGenerated");
  assertOrder(types, "ProofGenerated", "ReleaseDecided");
  assertOrder(types, "ReleaseDecided", "FinalReleased");

  const evidence = result.dispatch.recordedReceipt.evidence[0];
  assertDefined(evidence, "admitted evidence");
  assertEqual(
    evidence.sourceEventId,
    result.dispatch.effectReceiptEvent.eventId,
    "evidence source event",
  );
  assertEqual(
    result.finalCandidate.claims[0]?.evidenceRefs[0]?.sourceEventId,
    result.dispatch.effectReceiptEvent.eventId,
    "final candidate evidence source event",
  );
}

function assertBlockedRun(result: BlockedRunResult): void {
  const types = eventTypes(result.events);
  assertEqual(
    result.normalized.status,
    "accepted",
    "blocked candidate parsing",
  );
  assertEqual(result.release.proof.verdict, "fail", "blocked proof");
  assertEqual(result.release.decision.status, "blocked", "blocked release");
  if (result.release.finalReleasedEvent !== undefined) {
    throw new Error("blocked run emitted FinalReleased");
  }
  if (types.includes("FinalReleased")) {
    throw new Error("blocked run event log includes FinalReleased");
  }
  if (!result.release.proof.blockingMismatches.length) {
    throw new Error("blocked run did not produce blocking mismatches");
  }
}

function assertNoAuthorityEmission(
  result: ProviderProposalResult,
  label: string,
): void {
  const forbidden = new Set([
    "effect_receipt",
    "release_decision",
    "proof",
    "mutation_commit",
    "approval_grant",
    "final_released",
  ]);
  for (const emission of result.emissions) {
    if (forbidden.has(emission.kind)) {
      throw new Error(`${label} emitted forbidden ${emission.kind}`);
    }
  }
  const proofUsable = result.metadata.proofUsable as boolean;
  if (proofUsable) {
    throw new Error(`${label} metadata was proof usable`);
  }
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

function timelineMarkdown(bundle: RunBundle): string {
  const supportedRows = bundle.supported.events
    .map((event) => timelineRow(event))
    .join("\n");
  const blockedRows = bundle.blocked.events
    .map((event) => timelineRow(event))
    .join("\n");
  return [
    "# AMCA Flight Recorder Timeline",
    "",
    `Recorded at: ${bundle.timestamp}`,
    `Source commit at run start: \`${bundle.sourceCommit}\``,
    "",
    "## Supported Evidence-Backed Run",
    "",
    "| Sequence | Event ID | Type | Causation ID | Occurred At |",
    "| --- | --- | --- | --- | --- |",
    supportedRows,
    "",
    "## Blocked Unsupported-Claim Run",
    "",
    "| Sequence | Event ID | Type | Causation ID | Occurred At |",
    "| --- | --- | --- | --- | --- |",
    blockedRows,
    "",
    "## Recorded Assertions",
    "",
    "- The supported run released only after `EffectReceiptRecorded`, `ProofGenerated`, and `ReleaseDecided`.",
    "- The blocked run produced `ReleaseDecided: blocked` and no `FinalReleased` event.",
    "- Provider metadata in both runs is non-proof substrate state.",
    "",
  ].join("\n");
}

function timelineRow(event: RunEvent): string {
  return `| ${event.sequence.toString()} | \`${event.eventId}\` | \`${event.type}\` | ${event.causationId === null ? "" : `\`${event.causationId}\``} | ${event.occurredAt} |`;
}

function runReadme(bundle: RunBundle): string {
  return [
    "# Recorded AMCA Flight Recorder Run",
    "",
    `Recorded at: ${bundle.timestamp}`,
    "",
    "This directory was generated by executing the AMCA flight recorder command against the configured local provider. It contains the provider completions, normalized AMCA proposals, event logs, admitted evidence, proof, release decision, and blocked attack path from this exact run.",
    "",
    "## Command",
    "",
    "```bash",
    redactedCommand(),
    "```",
    "",
    "## Result",
    "",
    `- Supported run: \`${bundle.supported.release.decision.status}\``,
    `- Blocked run: \`${bundle.blocked.release.decision.status}\``,
    `- Source commit at run start: \`${bundle.sourceCommit}\``,
    "",
    "## Files",
    "",
    "- `events.json` and `events.jsonl`: accepted event log for the supported path.",
    "- `provider-tool-completion.redacted.json`: actual local provider response for the tool proposal.",
    "- `tool-proposal.normalized.json`: AMCA-normalized provider proposal candidate.",
    "- `effect-request-event.json`: AMCA-governed effect request.",
    "- `effect-receipt-recorded-event.json`: AMCA-admitted receipt event.",
    "- `admitted-evidence-ref.json`: admitted evidence tied to the receipt event.",
    "- `provider-final-completion.redacted.json`: actual local provider response for the final candidate.",
    "- `proof.json`: deterministic proof result.",
    "- `release-decision.json`: release-gate decision.",
    "- `final-released-event.json`: final release event from the supported path.",
    "- `attack-*`: unsupported claim path that AMCA blocked.",
    "",
  ].join("\n");
}

function commandsRun(bundle: RunBundle): string {
  return [
    "# Commands Run",
    "",
    `Recorded at: ${bundle.timestamp}`,
    `Source commit at run start: \`${bundle.sourceCommit}\``,
    "",
    "## Demo Command",
    "",
    "```bash",
    redactedCommand(),
    "```",
    "",
    "## Demo Output",
    "",
    "```text",
    "AMCA flight recorder run completed.",
    `timestamp: ${bundle.timestamp}`,
    `sourceCommitAtRunStart: ${bundle.sourceCommit}`,
    `outputDir: ${path.relative(REPO_ROOT, bundle.outputDir)}`,
    `supportedRun.release: ${bundle.supported.release.decision.status}`,
    `blockedRun.release: ${bundle.blocked.release.decision.status}`,
    `supportedRun.events: ${eventTypes(bundle.supported.events).join(" -> ")}`,
    `blockedRun.events: ${eventTypes(bundle.blocked.events).join(" -> ")}`,
    "```",
    "",
  ].join("\n");
}

function verificationRecord(bundle: RunBundle): JsonObject {
  const supportedTypes = eventTypes(bundle.supported.events);
  const blockedTypes = eventTypes(bundle.blocked.events);
  return {
    recordedAt: bundle.timestamp,
    sourceCommitAtRunStart: bundle.sourceCommit,
    supportedRun: {
      runId: bundle.supported.runId,
      releaseStatus: bundle.supported.release.decision.status,
      proofVerdict: bundle.supported.release.proof.verdict,
      finalReleasedExists:
        bundle.supported.release.finalReleasedEvent !== undefined,
      providerExecutedToolDirectly: false,
      governedAdapterCallCount: bundle.supported.fixture.calls.length,
      providerMetadataProofUsable:
        bundle.supported.toolProposalResult.metadata.proofUsable,
      eventTypes: supportedTypes,
      effectReceiptRecordedBeforeProofGenerated: indexBefore(
        supportedTypes,
        "EffectReceiptRecorded",
        "ProofGenerated",
      ),
      proofGeneratedBeforeReleaseDecided: indexBefore(
        supportedTypes,
        "ProofGenerated",
        "ReleaseDecided",
      ),
      releaseDecidedBeforeFinalReleased: indexBefore(
        supportedTypes,
        "ReleaseDecided",
        "FinalReleased",
      ),
    },
    blockedRun: {
      runId: bundle.blocked.runId,
      releaseStatus: bundle.blocked.release.decision.status,
      proofVerdict: bundle.blocked.release.proof.verdict,
      finalReleasedExists:
        bundle.blocked.release.finalReleasedEvent !== undefined,
      blockingMismatchIds: bundle.blocked.release.proof.blockingMismatches.map(
        (mismatch) => mismatch.mismatchId,
      ),
      eventTypes: blockedTypes,
    },
  };
}

function eventTypes(events: readonly RunEvent[]): RunEventType[] {
  return events.map((event) => event.type);
}

function assertOrder(
  types: readonly RunEventType[],
  earlier: RunEventType,
  later: RunEventType,
): void {
  const earlierIndex = types.indexOf(earlier);
  const laterIndex = types.indexOf(later);
  if (earlierIndex < 0 || laterIndex < 0 || earlierIndex >= laterIndex) {
    throw new Error(`expected ${earlier} before ${later}`);
  }
}

function indexBefore(
  types: readonly RunEventType[],
  earlier: RunEventType,
  later: RunEventType,
): boolean {
  return (
    types.indexOf(earlier) >= 0 && types.indexOf(earlier) < types.indexOf(later)
  );
}

function assertEqual<TValue>(
  actual: TValue,
  expected: TValue,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${label} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDefined<TValue>(
  value: TValue | null | undefined,
  label: string,
): asserts value is TValue {
  if (value === undefined || value === null) {
    throw new Error(`${label} was not defined`);
  }
}

function redactArtifact(value: unknown): JsonValue {
  return redactProviderValue(JSON.parse(JSON.stringify(value)) as JsonValue);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const formatted = await format(JSON.stringify(value), {
    parser: "json",
    trailingComma: "all",
  });
  await writeFile(file, formatted, "utf8");
}

async function writeJsonl(
  file: string,
  values: readonly unknown[],
): Promise<void> {
  await writeFile(
    file,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8",
  );
}

async function writeText(file: string, value: string): Promise<void> {
  const formatted = await format(value, {
    parser: "markdown",
    proseWrap: "always",
    trailingComma: "all",
  });
  await writeFile(file, formatted, "utf8");
}

function redactedCommand(): string {
  return [
    "AMCA_PROVIDER_LIVE=1",
    `AMCA_PROVIDER_BASE_URL=${requireEnv("AMCA_PROVIDER_BASE_URL")}`,
    `AMCA_PROVIDER_MODEL=${requireEnv("AMCA_PROVIDER_MODEL")}`,
    "AMCA_PROVIDER_API_KEY=<redacted>",
    "pnpm demo:flight-recorder",
  ].join(" ");
}

function slugTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/gu, "-");
}

function runIdFromTimestamp(prefix: string, timestamp: string): string {
  return `${prefix}_${slugTimestamp(timestamp).replace(/[^a-zA-Z0-9_]/gu, "_")}`;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function gitLike(binary: string, args: readonly string[]): string {
  try {
    return execFileSync(binary, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unavailable";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to record the live demo run`);
  }
  return value;
}

await main();
