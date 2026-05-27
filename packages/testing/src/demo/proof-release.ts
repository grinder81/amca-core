import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalObjectHash } from "@amca/contracts";
import { LocalRunHarness, type LocalRunHarnessOptions } from "@amca/harness";
import type { SubmitFinalCandidateResult } from "@amca/kernel";
import type {
  Claim,
  EvidenceRef,
  FinalCandidate,
  ReceiptCandidate,
  RunEvent,
  RunEventType,
  ToolCommandRequest,
} from "@amca/protocol";
import { format } from "prettier";

const CAPABILITY_ID = "amca.demo.run_tests";
const TOOL_ID = "amca.demo.run_tests";
const TEST_SUITE_ID = "public-proof-release-demo";
const RECEIPT_TYPE = "test_run";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEMO_ROOT = path.join(REPO_ROOT, ".amca/demo-runs/proof-release");

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
  readonly toolCommand: ToolCommandRequest;
  readonly dispatch: Awaited<
    ReturnType<LocalRunHarness["dispatchToolCommand"]>
  >;
  readonly finalCandidate: FinalCandidate;
  readonly release: SubmitFinalCandidateResult;
  readonly events: readonly RunEvent[];
}

interface BlockedRunResult {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
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

  const supported = await runSupportedProofReleasePath();
  const blocked = runBlockedUnsupportedClaimPath();

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
      "AMCA proof-release demo completed.",
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

async function runSupportedProofReleasePath(): Promise<SupportedRunResult> {
  const startedAt = new Date().toISOString();
  const runId = runIdFromTimestamp("demo_supported", startedAt);
  const fixture = testResultFixture(runId);
  const harness = startedHarness(fixture, startedAt);

  const dispatch = await harness.dispatchToolCommand(fixture.command, {
    effectReceiptEvent: {
      eventId: `evt_${fixture.command.commandId}_receipt_recorded`,
    },
  });
  const admittedEvidence = dispatch.recordedReceipt.evidence[0];
  assertDefined(admittedEvidence, "admitted evidence");

  const finalCandidate = finalCandidateForEvidence({
    runId,
    evidenceRef: admittedEvidence,
    candidateId: "candidate_demo_supported",
    claimId: "claim_demo_supported_tests_passed",
  });
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
    toolCommand: fixture.command,
    dispatch,
    finalCandidate,
    release,
    events: harness.kernel.events(),
  };
}

function runBlockedUnsupportedClaimPath(): BlockedRunResult {
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

  const finalCandidate = unsupportedFinalCandidate(runId);
  const release = harness.submitFinalCandidate(finalCandidate, {
    occurredAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
  });

  return {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
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
    kind: "amca_proof_release_demo_run_metadata",
    generatedAt: bundle.timestamp,
    completedAt: new Date().toISOString(),
    sourceCommitAtRunStart: bundle.sourceCommit,
    command: "pnpm demo:proof-release",
    networkRequired: false,
    providerRequired: false,
    databaseRequired: false,
    supportedRunId: supported.runId,
    blockedRunId: blocked.runId,
    node: process.version,
    pnpmVersion: commandLike("pnpm", ["--version"]),
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
    path.join(bundle.outputDir, "tool-command.json"),
    supported.toolCommand,
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
    path.join(bundle.outputDir, "final-candidate.json"),
    supported.finalCandidate,
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
    path.join(bundle.outputDir, "blocked-events.json"),
    blocked.events,
  );
  await writeJsonl(
    path.join(bundle.outputDir, "blocked-events.jsonl"),
    blocked.events,
  );
  await writeJson(
    path.join(bundle.outputDir, "blocked-final-candidate.json"),
    blocked.finalCandidate,
  );
  await writeJson(
    path.join(bundle.outputDir, "blocked-proof.json"),
    blocked.release.proof,
  );
  await writeJson(
    path.join(bundle.outputDir, "blocked-release-decision.json"),
    blocked.release.decision,
  );
  await writeText(path.join(bundle.outputDir, "timeline.md"), timeline(bundle));
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
        adapterKind: "deterministic_in_memory",
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

function unsupportedFinalCandidate(runId: string): FinalCandidate {
  return {
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
}

function assertSupportedRun(result: SupportedRunResult): void {
  const types = eventTypes(result.events);
  assertEqual(result.release.proof.verdict, "pass", "supported proof");
  assertEqual(result.release.decision.status, "released", "supported release");
  assertDefined(result.release.finalReleasedEvent, "FinalReleased event");
  assertEqual(result.fixture.calls.length, 1, "governed adapter call count");
  assertOrder(types, "ProposalReceived", "EffectRequested");
  assertOrder(types, "EffectRequested", "EffectReceiptRecorded");
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

function timeline(bundle: RunBundle): string {
  const supportedRows = bundle.supported.events
    .map((event) => timelineRow(event))
    .join("\n");
  const blockedRows = bundle.blocked.events
    .map((event) => timelineRow(event))
    .join("\n");
  return [
    "# AMCA Proof-Release Demo Timeline",
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
    "- The supported run admitted an `EvidenceRef` whose `sourceEventId` is the receipt event.",
    "- The blocked run produced `ReleaseDecided: blocked` and no `FinalReleased` event.",
    "",
  ].join("\n");
}

function timelineRow(event: RunEvent): string {
  return `| ${event.sequence.toString()} | \`${event.eventId}\` | \`${event.type}\` | ${event.causationId === null ? "" : `\`${event.causationId}\``} | ${event.occurredAt} |`;
}

function runReadme(bundle: RunBundle): string {
  return [
    "# Recorded AMCA Proof-Release Demo Run",
    "",
    `Recorded at: ${bundle.timestamp}`,
    "",
    "This directory was generated by executing `pnpm demo:proof-release`. It contains the event logs, governed effect request, admitted evidence, proof, release decision, final release event, and blocked unsupported-claim path from this exact run.",
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
    "- `tool-command.json`: proposal input for the governed deterministic effect.",
    "- `effect-request-event.json`: AMCA-governed effect request.",
    "- `effect-receipt-recorded-event.json`: AMCA-admitted receipt event.",
    "- `admitted-evidence-ref.json`: admitted evidence tied to the receipt event.",
    "- `final-candidate.json`: structured final claims referencing admitted evidence.",
    "- `proof.json`: deterministic proof result.",
    "- `release-decision.json`: release-gate decision.",
    "- `final-released-event.json`: final release event from the supported path.",
    "- `blocked-*`: unsupported claim path that AMCA blocked.",
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
    "pnpm demo:proof-release",
    "```",
    "",
    "## Demo Output",
    "",
    "```text",
    "AMCA proof-release demo completed.",
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

function verificationRecord(bundle: RunBundle): unknown {
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
      governedAdapterCallCount: bundle.supported.fixture.calls.length,
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
      admittedEvidenceSourceEventId:
        bundle.supported.dispatch.recordedReceipt.evidence[0]?.sourceEventId ??
        null,
      receiptEventId: bundle.supported.dispatch.effectReceiptEvent.eventId,
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

function slugTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/gu, "-");
}

function runIdFromTimestamp(prefix: string, timestamp: string): string {
  return `${prefix}_${slugTimestamp(timestamp).replace(/[^a-zA-Z0-9_]/gu, "_")}`;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function commandLike(binary: string, args: readonly string[]): string {
  try {
    return execFileSync(binary, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unavailable";
  }
}

await main();
