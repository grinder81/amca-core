#!/usr/bin/env node
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  type CapabilityContract,
  formatCapabilityValidationIssue,
  validateCapabilityContract,
  type CapabilityValidationIssue,
} from "@amca/capabilities";
import {
  canonicalObjectHash,
  parseFinalCandidate as parseFinalCandidateContract,
  parseToolCommandRequest,
} from "@amca/contracts";
import { LocalRunHarness, type LocalRunHarnessOptions } from "@amca/harness";
import {
  InMemoryRunKernel,
  type KernelEventOptions,
  type StartRunOptions,
} from "@amca/kernel";
import type {
  ExternalStateObservationCandidate,
  FinalCandidate,
  ISODateTimeString,
  JsonObject,
  PendingEvidenceRef,
  ReleaseDecision,
  ReceiptCandidate,
  RunEvent,
  SideEffectClass,
  ToolCommandRequest,
} from "@amca/protocol";
import {
  replayRunEvents,
  type ReplayResult,
  type ReplaySuccess,
} from "@amca/replay";
import type { ScenarioFixture } from "@amca/testing";

import {
  buildRunArtifactsFromEvents,
  readRunArtifacts,
  writeRunArtifacts,
  type RunArtifacts,
} from "./artifacts/run-artifacts.js";

type Writable = Pick<NodeJS.WriteStream, "write">;
type HarnessAdapter = NonNullable<
  NonNullable<LocalRunHarnessOptions["brokerOptions"]>["adapters"]
>[number];

export interface CliEnvironment {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

interface ParsedArgs {
  readonly command: string | undefined;
  readonly positional: readonly string[];
  readonly storeDir: string;
  readonly storeExplicit: boolean;
}

interface ScenarioRunResult {
  readonly scenario: ScenarioFixture;
  readonly artifacts: RunArtifacts;
  readonly expectationPassed: boolean;
  readonly expectationNotes: readonly string[];
  readonly runDir: string;
}

interface HarnessScenario {
  readonly id: string;
  readonly runId: string;
  readonly profile: StartRunOptions["profile"];
  readonly startedAt: ISODateTimeString;
  readonly clock: ISODateTimeString;
  readonly toolCommand: ToolCommandRequest;
  readonly capability: CapabilityContract;
  readonly fakeAdapter: HarnessFakeAdapterSpec;
  readonly finalCandidate: FinalCandidate;
  readonly expected?: HarnessScenarioExpectation | undefined;
}

interface HarnessFakeAdapterSpec {
  readonly adapterId: string;
  readonly receiptType: string;
  readonly status: ReceiptCandidate["status"];
  readonly payload: JsonObject;
  readonly observedAt?: ISODateTimeString | undefined;
  readonly evidenceId?: string | undefined;
  readonly sensitivity?: PendingEvidenceRef["sensitivity"];
  readonly externalStateObservation?: HarnessExternalStateObservationSpec;
}

interface HarnessExternalStateObservationSpec {
  readonly observationType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly observedState: JsonObject;
  readonly observedAt: ISODateTimeString;
  readonly expiresAt: ISODateTimeString;
  readonly evidenceId: string;
  readonly sensitivity: PendingEvidenceRef["sensitivity"];
}

interface HarnessScenarioExpectation {
  readonly releaseStatus?: ReleaseDecision["status"] | undefined;
  readonly mismatchTypes?: readonly string[] | undefined;
  readonly approvedClaimIds?: readonly string[] | undefined;
}

interface HarnessRunResult {
  readonly scenario: HarnessScenario;
  readonly artifacts: RunArtifacts;
  readonly expectationPassed: boolean;
  readonly expectationNotes: readonly string[];
  readonly runDir: string;
  readonly adapterCallCount: number;
}

interface CapabilityFileValidationResult {
  readonly filePath: string;
  readonly valid: boolean;
  readonly capabilityId?: string;
  readonly issues: readonly CapabilityValidationIssue[];
}

const defaultRunStore = ".amca/runs";
const defaultTestStore = ".amca/tmp/test-runs";

export async function runCli(
  environment: CliEnvironment = {},
): Promise<number> {
  const cwd = environment.cwd ?? process.cwd();
  const stdout = environment.stdout ?? process.stdout;
  const stderr = environment.stderr ?? process.stderr;
  const args = parseArgs(environment.argv ?? process.argv.slice(2), cwd);

  try {
    switch (args.command) {
      case "run":
        return await runCommand(args, cwd, stdout, stderr);
      case "inspect":
        return await inspectCommand(args, stdout, stderr);
      case "replay":
        return await replayCommand(args, stdout, stderr);
      case "test":
        return await testCommand(args, cwd, stdout, stderr);
      case "validate":
        return await validateCommand(args, cwd, stdout, stderr);
      case "harness":
        return await harnessCommand(args, cwd, stdout, stderr);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        write(stdout, usage());
        return 0;
      default:
        write(stderr, `Unknown command: ${args.command}\n\n${usage()}`);
        return 1;
    }
  } catch (error) {
    write(stderr, `${formatError(error)}\n`);
    return 1;
  }
}

async function validateCommand(
  args: ParsedArgs,
  cwd: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const [capabilitiesDirArg] = args.positional;
  if (capabilitiesDirArg === undefined) {
    write(stderr, "Usage: amca validate <capabilities_dir>\n");
    return 1;
  }

  const capabilitiesDir = resolvePath(cwd, capabilitiesDirArg);
  const capabilityFiles = await findJsonFiles(capabilitiesDir);

  if (capabilityFiles.length === 0) {
    write(stderr, `No capability JSON files found in ${capabilitiesDir}\n`);
    return 1;
  }

  const results: CapabilityFileValidationResult[] = [];
  for (const capabilityFile of capabilityFiles) {
    results.push(await validateCapabilityFile(capabilityFile));
  }

  write(stdout, formatCapabilityValidationSummary(results, capabilitiesDir));
  return results.every((result) => result.valid) ? 0 : 1;
}

async function harnessCommand(
  args: ParsedArgs,
  cwd: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const [subcommand, scenarioPath] = args.positional;
  if (subcommand !== "run" || scenarioPath === undefined) {
    write(stderr, "Usage: amca harness run <scenario.json> [--store <dir>]\n");
    return 1;
  }

  const scenario = await readHarnessScenarioFile(
    resolvePath(cwd, scenarioPath),
  );
  const result = await executeAndPersistHarnessScenario(
    scenario,
    args.storeDir,
  );
  write(stdout, formatHarnessRunSummary(result));
  return result.expectationPassed ? 0 : 1;
}

async function runCommand(
  args: ParsedArgs,
  cwd: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const [scenarioPath] = args.positional;
  if (scenarioPath === undefined) {
    write(stderr, "Usage: amca run <scenario.json> [--store <dir>]\n");
    return 1;
  }

  const scenario = await readScenarioFile(resolvePath(cwd, scenarioPath));
  const result = await executeAndPersistScenario(scenario, args.storeDir);
  write(stdout, formatRunSummary(result));
  return result.expectationPassed ? 0 : 1;
}

async function inspectCommand(
  args: ParsedArgs,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const [runId] = args.positional;
  if (runId === undefined) {
    write(stderr, "Usage: amca inspect <run_id> [--store <dir>]\n");
    return 1;
  }

  const artifacts = await readRunArtifacts(args.storeDir, runId);
  write(
    stdout,
    formatInspectSummary(artifacts, path.join(args.storeDir, runId)),
  );
  return 0;
}

async function replayCommand(
  args: ParsedArgs,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const [runId] = args.positional;
  if (runId === undefined) {
    write(stderr, "Usage: amca replay <run_id> [--store <dir>]\n");
    return 1;
  }

  const artifacts = await readRunArtifacts(args.storeDir, runId);
  const replay = replayArtifacts(artifacts);
  write(stdout, formatReplaySummary(artifacts, replay));
  return replay.passed ? 0 : 1;
}

async function testCommand(
  args: ParsedArgs,
  cwd: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const [scenarioDirArg] = args.positional;
  const scenarioDir = resolvePath(cwd, scenarioDirArg ?? "scenarios");
  const storeDir = args.storeExplicit
    ? args.storeDir
    : path.resolve(cwd, defaultTestStore);

  await rm(storeDir, { force: true, recursive: true });

  const scenarioPaths = (await readdir(scenarioDir))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(scenarioDir, name));

  if (scenarioPaths.length === 0) {
    write(stderr, `No scenario JSON files found in ${scenarioDir}\n`);
    return 1;
  }

  const results: ScenarioRunResult[] = [];
  for (const scenarioPath of scenarioPaths) {
    const scenario = await readScenarioFile(scenarioPath);
    results.push(await executeAndPersistScenario(scenario, storeDir));
  }

  const failed = results.filter((result) => !result.expectationPassed);
  write(stdout, formatTestSummary(results, storeDir));
  return failed.length === 0 ? 0 : 1;
}

async function executeAndPersistScenario(
  scenario: ScenarioFixture,
  storeDir: string,
): Promise<ScenarioRunResult> {
  const kernel = executeScenario(scenario);
  const events = kernel.events();
  const artifacts = buildRunArtifactsFromEvents({
    runId: scenario.given.finalCandidate.runId,
    events,
    scenarioId: scenario.id,
  });

  const expectation = compareWithScenarioExpectation(scenario, artifacts);
  const runDir = await writeRunArtifacts(storeDir, artifacts);
  return {
    scenario,
    artifacts,
    expectationPassed: expectation.passed,
    expectationNotes: expectation.notes,
    runDir,
  };
}

async function executeAndPersistHarnessScenario(
  scenario: HarnessScenario,
  storeDir: string,
): Promise<HarnessRunResult> {
  const adapterCalls: ToolCommandRequest[] = [];
  const harness = new LocalRunHarness({
    runId: scenario.runId,
    clock: () => scenario.clock,
    brokerOptions: {
      capabilities: [scenario.capability],
      adapters: [
        fakeHarnessAdapter({
          scenario,
          calls: adapterCalls,
        }),
      ],
      clock: () => scenario.clock,
    },
  });

  harness.startRun({
    occurredAt: scenario.startedAt,
    metadata: {
      runner: "amca_cli_harness",
      scenarioId: scenario.id,
    },
    ...optionalProfile(scenario.profile),
  });

  await harness.runToRelease({
    toolCommand: scenario.toolCommand,
    finalCandidate: scenario.finalCandidate,
    options: {
      finalCandidate: {
        generatedAt: scenario.clock,
        occurredAt: scenario.clock,
      },
    },
  });
  const events = harness.kernel.events();
  const artifacts = buildRunArtifactsFromEvents({
    runId: scenario.runId,
    events,
    scenarioId: scenario.id,
  });

  const expectation = compareWithHarnessExpectation(scenario, artifacts);
  const runDir = await writeRunArtifacts(storeDir, artifacts);
  return {
    scenario,
    artifacts,
    expectationPassed: expectation.passed,
    expectationNotes: expectation.notes,
    runDir,
    adapterCallCount: adapterCalls.length,
  };
}

function executeScenario(scenario: ScenarioFixture): InMemoryRunKernel {
  const runId = scenario.given.finalCandidate.runId;
  const kernel = new InMemoryRunKernel({ runId });
  const runStarted = requiredEvent(scenario.given.runEvents, "RunStarted");
  const toolProposal = requiredProposalEvent(
    scenario.given.runEvents,
    "tool_command_request",
  );
  const effectRequested = requiredEvent(
    scenario.given.runEvents,
    "EffectRequested",
  );
  const receiptRecorded = eventOfType(
    scenario.given.runEvents,
    "EffectReceiptRecorded",
  );
  const observationRecorded = eventOfType(
    scenario.given.runEvents,
    "ExternalStateObserved",
  );
  const finalProposal = requiredProposalEvent(
    scenario.given.runEvents,
    "final_candidate",
  );
  const proofGenerated = requiredEvent(
    scenario.expected.emittedEvents,
    "ProofGenerated",
  );
  const mismatchEventIds = scenario.expected.emittedEvents
    .filter((event) => event.type === "MismatchDetected")
    .map((event) => event.eventId);
  const releaseDecided = requiredEvent(
    scenario.expected.emittedEvents,
    "ReleaseDecided",
  );
  const finalReleased = eventOfType(
    scenario.expected.emittedEvents,
    "FinalReleased",
  );

  kernel.startRun({
    ...eventOptionsFrom(runStarted),
    profile: scenario.profile,
    metadata: metadataFromRunStarted(runStarted),
  });
  kernel.submitToolCommand(
    scenario.given.toolCommandRequest,
    eventOptionsFrom(toolProposal),
  );
  kernel.recordEffectRequest(
    scenario.given.effectRequest,
    eventOptionsFrom(effectRequested),
  );

  if (scenario.given.effectReceipt !== undefined) {
    if (receiptRecorded === undefined) {
      throw new Error(`Scenario ${scenario.id} has a receipt but no event.`);
    }

    kernel.recordEffectReceipt(
      scenario.given.effectReceipt,
      eventOptionsFrom(receiptRecorded),
    );
  }

  if (scenario.given.externalStateObservation !== undefined) {
    if (observationRecorded === undefined) {
      throw new Error(
        `Scenario ${scenario.id} has an observation but no event.`,
      );
    }

    kernel.recordExternalStateObservation(
      scenario.given.externalStateObservation,
      eventOptionsFrom(observationRecorded),
    );
  }

  kernel.submitFinalCandidate(scenario.given.finalCandidate, {
    ...eventOptionsFrom(finalProposal),
    generatedAt: proofGenerated.occurredAt,
    proofId: scenario.expected.proof.proofId,
    proofEventId: proofGenerated.eventId,
    mismatchEventIds,
    releaseEventId: releaseDecided.eventId,
    ...(finalReleased === undefined
      ? {}
      : { finalReleasedEventId: finalReleased.eventId }),
  });

  return kernel;
}

function fakeHarnessAdapter(input: {
  readonly scenario: HarnessScenario;
  readonly calls: ToolCommandRequest[];
}): HarnessAdapter {
  return {
    adapterId: input.scenario.fakeAdapter.adapterId,
    capabilityId: input.scenario.toolCommand.capabilityId,
    toolId: input.scenario.toolCommand.toolId,
    certification: {
      certificationVersion: 1,
      adapterId: input.scenario.fakeAdapter.adapterId,
      adapterKind: "deterministic_fake",
      capabilityId: input.scenario.toolCommand.capabilityId,
      toolId: input.scenario.toolCommand.toolId,
      sideEffectClass: input.scenario.toolCommand.sideEffectClass,
      declaredReceiptTypes: [input.scenario.fakeAdapter.receiptType],
      ...(input.scenario.fakeAdapter.externalStateObservation === undefined
        ? {}
        : {
            declaredObservationTypes: [
              input.scenario.fakeAdapter.externalStateObservation
                .observationType,
            ],
          }),
      idempotency:
        input.scenario.toolCommand.sideEffectClass === "read" ||
        input.scenario.toolCommand.sideEffectClass === "compute"
          ? "not_required"
          : "required_for_writes",
      ...writeLifecycleFor(input.scenario.toolCommand.sideEffectClass),
      riskProfile: "standard",
    },
    execute: (request) => {
      input.calls.push(request.toolCommand);

      const observedAt =
        input.scenario.fakeAdapter.observedAt ?? input.scenario.clock;
      const payloadHash = canonicalObjectHash(
        input.scenario.fakeAdapter.payload,
      );
      const externalStateObservationSpec =
        input.scenario.fakeAdapter.externalStateObservation;
      const externalStateObservationCandidate =
        externalStateObservationSpec === undefined
          ? undefined
          : buildHarnessExternalStateObservation({
              runId: request.effectRequest.runId,
              commandId: request.toolCommand.commandId,
              spec: externalStateObservationSpec,
            });

      return {
        receiptCandidate: {
          receiptId: `receipt_${request.effectRequest.effectId}`,
          effectId: request.effectRequest.effectId,
          runId: request.effectRequest.runId,
          capabilityId: request.effectRequest.capabilityId,
          receiptType: input.scenario.fakeAdapter.receiptType,
          status: input.scenario.fakeAdapter.status,
          payload: input.scenario.fakeAdapter.payload,
          payloadHash,
          evidence: [
            pendingEvidenceRef({
              evidenceId:
                input.scenario.fakeAdapter.evidenceId ??
                `ev_${request.toolCommand.commandId}`,
              kind: "effect_receipt",
              hash: payloadHash,
              observedAt,
              sensitivity: input.scenario.fakeAdapter.sensitivity ?? "internal",
            }),
          ],
          observedAt,
        },
        ...(externalStateObservationCandidate === undefined
          ? {}
          : { externalStateObservationCandidate }),
      };
    },
  };
}

function writeLifecycleFor(sideEffectClass: SideEffectClass) {
  if (
    sideEffectClass === "read" ||
    sideEffectClass === "compute" ||
    sideEffectClass === "critical_write"
  ) {
    return {};
  }

  return {
    writeLifecycle: {
      preflight: "required_before_dispatch",
      idempotencyKey: "tool_command_required",
      dispatch: "broker_governed",
      outcome: "receipt_candidate_or_quarantine_required",
      forbiddenAuthority: [
        "receipt_admission",
        "proof_authority",
        "release_authority",
      ],
    },
  } as const;
}

function buildHarnessExternalStateObservation(input: {
  readonly runId: string;
  readonly commandId: string;
  readonly spec: HarnessExternalStateObservationSpec;
}): ExternalStateObservationCandidate {
  const payloadHash = canonicalObjectHash(input.spec.observedState);

  return {
    observationId: `obs_${sanitizeIdPart(input.commandId)}`,
    runId: input.runId,
    observationType: input.spec.observationType,
    subjectType: input.spec.subjectType,
    subjectId: input.spec.subjectId,
    observedState: input.spec.observedState,
    observedAt: input.spec.observedAt,
    expiresAt: input.spec.expiresAt,
    payloadHash,
    evidence: [
      pendingEvidenceRef({
        evidenceId: input.spec.evidenceId,
        kind: "external_observation",
        hash: payloadHash,
        observedAt: input.spec.observedAt,
        sensitivity: input.spec.sensitivity,
        expiresAt: input.spec.expiresAt,
      }),
    ],
  };
}

function pendingEvidenceRef(
  input: Omit<PendingEvidenceRef, "admissionStatus" | "pendingAdmissionToken">,
): PendingEvidenceRef {
  return {
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${sanitizeIdPart(input.evidenceId)}`,
    ...input,
  };
}

function replayArtifacts(artifacts: RunArtifacts): {
  readonly passed: boolean;
  readonly decision: ReleaseDecision | undefined;
  readonly mismatchTypes: readonly string[];
  readonly notes: readonly string[];
} {
  const replay = replayRunEvents({
    runId: artifacts.runId,
    events: artifacts.events,
  });

  return replayArtifactsResult(replay);
}

function replayArtifactsResult(replay: ReplayResult): {
  readonly passed: boolean;
  readonly decision: ReleaseDecision | undefined;
  readonly mismatchTypes: readonly string[];
  readonly notes: readonly string[];
} {
  if (replay.status === "failed") {
    return {
      passed: false,
      decision: undefined,
      mismatchTypes: [],
      notes: replay.notes,
    };
  }

  return {
    passed: true,
    decision: replay.replayedDecision,
    mismatchTypes: replayMismatchTypes(replay),
    notes: replay.notes,
  };
}

function replayMismatchTypes(replay: ReplaySuccess): string[] {
  return replay.replayedEvents
    .filter(
      (event): event is RunEvent<"MismatchDetected"> =>
        event.type === "MismatchDetected",
    )
    .map((event) => mismatchType(event.payload.mismatch));
}

async function readScenarioFile(filePath: string): Promise<ScenarioFixture> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  assertScenarioFixture(parsed, filePath);
  return parsed;
}

async function readHarnessScenarioFile(
  filePath: string,
): Promise<HarnessScenario> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  return parseHarnessScenario(parsed, filePath);
}

function parseHarnessScenario(
  value: unknown,
  filePath: string,
): HarnessScenario {
  if (!isRecord(value)) {
    throw new Error(`Harness scenario file ${filePath} must be a JSON object.`);
  }

  assertAllowedKeys(
    value,
    [
      "kind",
      "id",
      "runId",
      "profile",
      "startedAt",
      "clock",
      "toolCommand",
      "capability",
      "fakeAdapter",
      "finalCandidate",
      "expected",
    ],
    `Harness scenario ${filePath}`,
  );

  if (
    value.kind !== undefined &&
    value.kind !== "governed_harness_run_scenario"
  ) {
    throw new Error(
      `Harness scenario ${filePath} kind must be governed_harness_run_scenario.`,
    );
  }

  const id = requiredString(value, "id", filePath);
  const runId = requiredString(value, "runId", filePath);
  const clock = requiredString(value, "clock", filePath);
  const startedAt = optionalString(value.startedAt) ?? clock;
  const profile = parseProfile(value.profile, filePath);
  const toolCommand = parseToolCommand(
    requiredRecord(value, "toolCommand", filePath),
    filePath,
  );
  const capability = parseCapability(
    requiredRecord(value, "capability", filePath),
    filePath,
  );
  const fakeAdapter = parseHarnessFakeAdapter(
    requiredRecord(value, "fakeAdapter", filePath),
    filePath,
  );
  const finalCandidate = parseFinalCandidate(
    requiredRecord(value, "finalCandidate", filePath),
    filePath,
  );
  const expected =
    value.expected === undefined
      ? undefined
      : parseHarnessExpectation(
          assertRecordValue(value.expected, `${filePath} expected`),
          filePath,
        );

  if (toolCommand.runId !== runId) {
    throw new Error(
      `Harness scenario ${filePath} toolCommand.runId does not match runId.`,
    );
  }

  if (finalCandidate.runId !== runId) {
    throw new Error(
      `Harness scenario ${filePath} finalCandidate.runId does not match runId.`,
    );
  }

  if (capability.capabilityId !== toolCommand.capabilityId) {
    throw new Error(
      `Harness scenario ${filePath} capabilityId does not match tool command.`,
    );
  }

  return {
    id,
    runId,
    profile,
    startedAt,
    clock,
    toolCommand,
    capability,
    fakeAdapter,
    finalCandidate,
    ...(expected === undefined ? {} : { expected }),
  };
}

function assertScenarioFixture(
  value: unknown,
  filePath: string,
): asserts value is ScenarioFixture {
  if (!isRecord(value)) {
    throw new Error(`Scenario file ${filePath} must contain a JSON object.`);
  }

  if (typeof value.id !== "string") {
    throw new Error(`Scenario file ${filePath} is missing id.`);
  }

  if (!isRecord(value.given) || !isRecord(value.expected)) {
    throw new Error(`Scenario ${value.id} is missing given/expected blocks.`);
  }

  if (!isRecord(value.given.finalCandidate)) {
    throw new Error(`Scenario ${value.id} is missing given.finalCandidate.`);
  }
}

function parseToolCommand(
  value: Record<string, unknown>,
  filePath: string,
): ToolCommandRequest {
  try {
    return parseToolCommandRequest(value);
  } catch (error) {
    throw new Error(
      `Harness scenario ${filePath} toolCommand is invalid: ${formatError(error)}`,
      { cause: error },
    );
  }
}

function parseCapability(
  value: Record<string, unknown>,
  filePath: string,
): CapabilityContract {
  const validation = validateCapabilityContract(value);
  if (!validation.success) {
    throw new Error(
      [
        `Harness scenario ${filePath} capability contract is invalid.`,
        ...validation.issues.map(
          (issue) => `  - ${formatCapabilityValidationIssue(issue)}`,
        ),
      ].join("\n"),
    );
  }

  return validation.data;
}

function parseHarnessFakeAdapter(
  value: Record<string, unknown>,
  filePath: string,
): HarnessFakeAdapterSpec {
  assertAllowedKeys(
    value,
    [
      "adapterId",
      "receiptType",
      "status",
      "payload",
      "observedAt",
      "evidenceId",
      "sensitivity",
      "externalStateObservation",
    ],
    `Harness scenario ${filePath} fakeAdapter`,
  );

  const payload = parseJsonObject(
    requiredRecord(value, "payload", filePath),
    `${filePath} fakeAdapter.payload`,
  );
  const observedAt = optionalString(value.observedAt);
  const evidenceId = optionalString(value.evidenceId);
  const sensitivity = parseSensitivity(value.sensitivity, filePath);
  const externalStateObservation =
    value.externalStateObservation === undefined
      ? undefined
      : parseHarnessExternalStateObservation(
          assertRecordValue(
            value.externalStateObservation,
            `Harness scenario ${filePath} fakeAdapter.externalStateObservation`,
          ),
          filePath,
        );

  return {
    adapterId: requiredString(value, "adapterId", filePath),
    receiptType: requiredString(value, "receiptType", filePath),
    status: parseReceiptStatus(value.status, filePath),
    payload,
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(evidenceId === undefined ? {} : { evidenceId }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(externalStateObservation === undefined
      ? {}
      : { externalStateObservation }),
  };
}

function parseHarnessExternalStateObservation(
  value: Record<string, unknown>,
  filePath: string,
): HarnessExternalStateObservationSpec {
  assertAllowedKeys(
    value,
    [
      "observationType",
      "subjectType",
      "subjectId",
      "observedState",
      "observedAt",
      "expiresAt",
      "evidenceId",
      "sensitivity",
    ],
    `Harness scenario ${filePath} fakeAdapter.externalStateObservation`,
  );

  return {
    observationType: requiredString(value, "observationType", filePath),
    subjectType: requiredString(value, "subjectType", filePath),
    subjectId: requiredString(value, "subjectId", filePath),
    observedState: parseJsonObject(
      requiredRecord(value, "observedState", filePath),
      `${filePath} fakeAdapter.externalStateObservation.observedState`,
    ),
    observedAt: requiredString(value, "observedAt", filePath),
    expiresAt: requiredString(value, "expiresAt", filePath),
    evidenceId: requiredString(value, "evidenceId", filePath),
    sensitivity: requiredSensitivity(
      value.sensitivity,
      filePath,
      "fakeAdapter.externalStateObservation.sensitivity",
    ),
  };
}

function parseFinalCandidate(
  value: Record<string, unknown>,
  filePath: string,
): FinalCandidate {
  try {
    return parseFinalCandidateContract(value);
  } catch (error) {
    throw new Error(
      `Harness scenario ${filePath} finalCandidate is invalid: ${formatError(error)}`,
      { cause: error },
    );
  }
}

function parseHarnessExpectation(
  value: Record<string, unknown>,
  filePath: string,
): HarnessScenarioExpectation {
  assertAllowedKeys(
    value,
    ["releaseStatus", "mismatchTypes", "approvedClaimIds"],
    `Harness scenario ${filePath} expected`,
  );

  const releaseStatus =
    value.releaseStatus === undefined
      ? undefined
      : parseReleaseStatus(value.releaseStatus, filePath);
  const mismatchTypes =
    value.mismatchTypes === undefined
      ? undefined
      : parseStringArray(value.mismatchTypes, "mismatchTypes", filePath);
  const approvedClaimIds =
    value.approvedClaimIds === undefined
      ? undefined
      : parseStringArray(value.approvedClaimIds, "approvedClaimIds", filePath);

  return {
    ...(releaseStatus === undefined ? {} : { releaseStatus }),
    ...(mismatchTypes === undefined ? {} : { mismatchTypes }),
    ...(approvedClaimIds === undefined ? {} : { approvedClaimIds }),
  };
}

function compareWithScenarioExpectation(
  scenario: ScenarioFixture,
  artifacts: RunArtifacts,
): { readonly passed: boolean; readonly notes: readonly string[] } {
  const notes: string[] = [];
  const actualStatus = artifacts.releaseDecision.status;
  const expectedStatus = scenario.expected.releaseDecision.status;
  const actualMismatchTypes = artifacts.mismatches.map((mismatch) =>
    mismatchType(mismatch),
  );
  const expectedMismatchTypes = scenario.expected.mismatches.map(
    (mismatch) => mismatch.type,
  );

  if (actualStatus !== expectedStatus) {
    notes.push(
      `status expected ${expectedStatus} but received ${actualStatus}`,
    );
  }

  if (!sameValues(actualMismatchTypes, expectedMismatchTypes)) {
    notes.push(
      `mismatch types expected ${expectedMismatchTypes.join(",")} but received ${actualMismatchTypes.join(",")}`,
    );
  }

  if (
    !sameValues(
      artifacts.releaseDecision.approvedClaimIds,
      scenario.expected.releaseDecision.approvedClaimIds,
    )
  ) {
    notes.push("approved claim IDs did not match expected scenario outcome");
  }

  return {
    passed: notes.length === 0,
    notes,
  };
}

function compareWithHarnessExpectation(
  scenario: HarnessScenario,
  artifacts: RunArtifacts,
): { readonly passed: boolean; readonly notes: readonly string[] } {
  const expected = scenario.expected;
  if (expected === undefined) {
    return {
      passed: true,
      notes: [],
    };
  }

  const notes: string[] = [];
  if (
    expected.releaseStatus !== undefined &&
    artifacts.releaseDecision.status !== expected.releaseStatus
  ) {
    notes.push(
      `status expected ${expected.releaseStatus} but received ${artifacts.releaseDecision.status}`,
    );
  }

  if (expected.mismatchTypes !== undefined) {
    const actualMismatchTypes = artifacts.mismatches.map((mismatch) =>
      mismatchType(mismatch),
    );
    if (!sameValues(actualMismatchTypes, expected.mismatchTypes)) {
      notes.push(
        `mismatch types expected ${expected.mismatchTypes.join(",")} but received ${actualMismatchTypes.join(",")}`,
      );
    }
  }

  if (
    expected.approvedClaimIds !== undefined &&
    !sameValues(
      artifacts.releaseDecision.approvedClaimIds,
      expected.approvedClaimIds,
    )
  ) {
    notes.push("approved claim IDs did not match expected harness outcome");
  }

  return {
    passed: notes.length === 0,
    notes,
  };
}

function formatRunSummary(result: ScenarioRunResult): string {
  return [
    `AMCA scenario: ${result.scenario.id}`,
    `runId: ${result.artifacts.runId}`,
    `status: ${result.artifacts.releaseDecision.status}`,
    `proofId: ${result.artifacts.releaseDecision.proofId ?? "none"}`,
    `events: ${String(result.artifacts.events.length)}`,
    `mismatches: ${result.artifacts.mismatches.map(mismatchType).join(",") || "none"}`,
    `artifacts: ${result.runDir}`,
    `expectation: ${result.expectationPassed ? "pass" : "fail"}`,
    ...result.expectationNotes.map((note) => `note: ${note}`),
    "",
  ].join("\n");
}

function formatHarnessRunSummary(result: HarnessRunResult): string {
  return [
    `AMCA harness scenario: ${result.scenario.id}`,
    `runId: ${result.artifacts.runId}`,
    `status: ${result.artifacts.releaseDecision.status}`,
    `proofId: ${result.artifacts.releaseDecision.proofId ?? "none"}`,
    `events: ${String(result.artifacts.events.length)}`,
    `adapterCalls: ${String(result.adapterCallCount)}`,
    `mismatches: ${result.artifacts.mismatches.map(mismatchType).join(",") || "none"}`,
    `artifacts: ${result.runDir}`,
    `expectation: ${result.expectationPassed ? "pass" : "fail"}`,
    ...result.expectationNotes.map((note) => `note: ${note}`),
    "",
  ].join("\n");
}

function formatInspectSummary(artifacts: RunArtifacts, runDir: string): string {
  const finalCandidate = lastFinalCandidate(artifacts.events);
  const claimIds =
    finalCandidate?.claims.map((claim) => claim.claimId).join(",") ?? "none";
  return [
    `AMCA run: ${artifacts.runId}`,
    `status: ${artifacts.releaseDecision.status}`,
    `proofId: ${artifacts.releaseDecision.proofId ?? "none"}`,
    `events: ${String(artifacts.events.length)}`,
    `effectRequests: ${String(artifacts.effectRequests.length)}`,
    `receipts: ${String(artifacts.receipts.length)}`,
    `observations: ${String(artifacts.observations.length)}`,
    `claims: ${claimIds}`,
    `proofVerdict: ${artifacts.proof.verdict}`,
    `mismatches: ${artifacts.mismatches.map(mismatchType).join(",") || "none"}`,
    `artifacts: ${runDir}`,
    "",
  ].join("\n");
}

function formatReplaySummary(
  artifacts: RunArtifacts,
  replay: ReturnType<typeof replayArtifacts>,
): string {
  return [
    `AMCA replay: ${artifacts.runId}`,
    `status: ${replay.passed ? "pass" : "fail"}`,
    `storedDecision: ${artifacts.releaseDecision.status}`,
    `replayedDecision: ${replay.decision?.status ?? "unavailable"}`,
    `replayedMismatches: ${replay.mismatchTypes.join(",") || "none"}`,
    ...replay.notes.map((note) => `note: ${note}`),
    "",
  ].join("\n");
}

function formatTestSummary(
  results: readonly ScenarioRunResult[],
  storeDir: string,
): string {
  const failed = results.filter((result) => !result.expectationPassed);
  return [
    "AMCA scenario test",
    `scenarios: ${String(results.length)}`,
    `passed: ${String(results.length - failed.length)}`,
    `failed: ${String(failed.length)}`,
    `artifacts: ${storeDir}`,
    ...failed.flatMap((result) => [
      `failedScenario: ${result.scenario.id}`,
      ...result.expectationNotes.map((note) => `note: ${note}`),
    ]),
    "",
  ].join("\n");
}

function formatCapabilityValidationSummary(
  results: readonly CapabilityFileValidationResult[],
  capabilitiesDir: string,
): string {
  const invalid = results.filter((result) => !result.valid);
  return [
    "AMCA capability validation",
    `directory: ${capabilitiesDir}`,
    `files: ${String(results.length)}`,
    `valid: ${String(results.length - invalid.length)}`,
    `invalid: ${String(invalid.length)}`,
    ...results.flatMap((result) => {
      const relativePath = path.relative(capabilitiesDir, result.filePath);
      if (result.valid) {
        return [`VALID ${result.capabilityId ?? "<unknown>"} ${relativePath}`];
      }

      return [
        `INVALID ${relativePath}`,
        ...result.issues.map(
          (issue) => `  - ${formatCapabilityValidationIssue(issue)}`,
        ),
      ];
    }),
    "",
  ].join("\n");
}

function parseArgs(argv: readonly string[], cwd: string): ParsedArgs {
  const positional: string[] = [];
  let storeDir = path.resolve(cwd, defaultRunStore);
  let storeExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--store") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--store requires a directory path.");
      }

      storeDir = resolvePath(cwd, value);
      storeExplicit = true;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--store=") === true) {
      storeDir = resolvePath(cwd, arg.slice("--store=".length));
      storeExplicit = true;
      continue;
    }

    if (arg !== undefined) {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    positional: positional.slice(1),
    storeDir,
    storeExplicit,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  amca run <scenario.json> [--store <dir>]",
    "  amca harness run <scenario.json> [--store <dir>]",
    "  amca inspect <run_id> [--store <dir>]",
    "  amca replay <run_id> [--store <dir>]",
    "  amca test [scenarios_dir] [--store <dir>]",
    "  amca validate <capabilities_dir>",
    "",
  ].join("\n");
}

async function findJsonFiles(directory: string): Promise<string[]> {
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Capability path is not a directory: ${directory}`);
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const jsonFiles: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      jsonFiles.push(...(await findJsonFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      jsonFiles.push(entryPath);
    }
  }

  return jsonFiles.sort();
}

async function validateCapabilityFile(
  filePath: string,
): Promise<CapabilityFileValidationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    return {
      filePath,
      valid: false,
      issues: [
        {
          code: "invalid_json",
          message: formatError(error),
          path: [],
        },
      ],
    };
  }

  const result = validateCapabilityContract(parsed);
  if (result.success) {
    return {
      filePath,
      valid: true,
      capabilityId: result.data.capabilityId,
      issues: [],
    };
  }

  return {
    filePath,
    valid: false,
    issues: result.issues,
  };
}

function eventOptionsFrom(event: RunEvent): KernelEventOptions {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    causationId: event.causationId,
    correlationId: event.correlationId,
  };
}

function metadataFromRunStarted(event: RunEvent<"RunStarted">): JsonObject {
  return event.payload.metadata ?? {};
}

function optionalProfile(
  profile: StartRunOptions["profile"],
): Pick<StartRunOptions, "profile"> {
  return profile === undefined ? {} : { profile };
}

function requiredEvent<TType extends RunEvent["type"]>(
  events: readonly RunEvent[],
  type: TType,
): RunEvent<TType> {
  const event = eventOfType(events, type);
  if (event === undefined) {
    throw new Error(`Expected event type ${type}.`);
  }

  return event;
}

function eventOfType<TType extends RunEvent["type"]>(
  events: readonly RunEvent[],
  type: TType,
): RunEvent<TType> | undefined {
  return events.find((event): event is RunEvent<TType> => event.type === type);
}

function requiredProposalEvent(
  events: readonly RunEvent[],
  kind: "final_candidate" | "tool_command_request",
): RunEvent<"ProposalReceived"> {
  const event = events.find((candidate) => {
    if (candidate.type !== "ProposalReceived") {
      return false;
    }

    const proposalEvent = candidate as RunEvent<"ProposalReceived">;
    return proposalEvent.payload.proposal.kind === kind;
  }) as RunEvent<"ProposalReceived"> | undefined;

  if (event === undefined) {
    throw new Error(`Expected ${kind} proposal event.`);
  }

  return event;
}

function lastFinalCandidate(
  events: readonly RunEvent[],
): FinalCandidate | undefined {
  let finalCandidate: FinalCandidate | undefined;
  for (const event of events) {
    if (event.type === "ProposalReceived") {
      const proposalEvent = event as RunEvent<"ProposalReceived">;
      if (proposalEvent.payload.proposal.kind === "final_candidate") {
        finalCandidate = proposalEvent.payload.proposal;
      }
    }
  }

  return finalCandidate;
}

function mismatchType(mismatch: unknown): string {
  if (isRecord(mismatch) && typeof mismatch.type === "string") {
    return mismatch.type;
  }

  return "unknown";
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function resolvePath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  filePath: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Harness scenario ${filePath} ${key} must be a string.`);
  }

  return field;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Optional harness scenario string fields must be strings.");
  }

  return value;
}

function requiredRecord(
  value: Record<string, unknown>,
  key: string,
  filePath: string,
): Record<string, unknown> {
  return assertRecordValue(value[key], `Harness scenario ${filePath} ${key}`);
}

function assertRecordValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label} has unknown field(s): ${unknownKeys.sort().join(",")}.`,
    );
  }
}

function parseProfile(
  value: unknown,
  filePath: string,
): StartRunOptions["profile"] {
  if (value === undefined) {
    return "standard";
  }

  if (
    value === "light" ||
    value === "standard" ||
    value === "critical" ||
    value === "regulated"
  ) {
    return value;
  }

  throw new Error(`Harness scenario ${filePath} profile is invalid.`);
}

function parseReceiptStatus(
  value: unknown,
  filePath: string,
): ReceiptCandidate["status"] {
  if (value === "succeeded" || value === "failed" || value === "unknown") {
    return value;
  }

  throw new Error(
    `Harness scenario ${filePath} fakeAdapter.status is invalid.`,
  );
}

function parseReleaseStatus(
  value: unknown,
  filePath: string,
): ReleaseDecision["status"] {
  if (
    value === "released" ||
    value === "blocked" ||
    value === "needs_repair" ||
    value === "quarantined"
  ) {
    return value;
  }

  throw new Error(
    `Harness scenario ${filePath} expected.releaseStatus is invalid.`,
  );
}

function parseSensitivity(
  value: unknown,
  filePath: string,
  fieldLabel = "fakeAdapter.sensitivity",
): PendingEvidenceRef["sensitivity"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted"
  ) {
    return value;
  }

  throw new Error(`Harness scenario ${filePath} ${fieldLabel} is invalid.`);
}

function requiredSensitivity(
  value: unknown,
  filePath: string,
  fieldLabel: string,
): PendingEvidenceRef["sensitivity"] {
  const sensitivity = parseSensitivity(value, filePath, fieldLabel);
  if (sensitivity === undefined) {
    throw new Error(`Harness scenario ${filePath} ${fieldLabel} is required.`);
  }

  return sensitivity;
}

function parseStringArray(
  value: unknown,
  key: string,
  filePath: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Harness scenario ${filePath} ${key} must be strings.`);
  }

  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`Harness scenario ${filePath} ${key} must be strings.`);
    }

    strings.push(item);
  }

  return strings;
}

function parseJsonObject(
  value: Record<string, unknown>,
  label: string,
): JsonObject {
  if (!isJsonValue(value)) {
    throw new Error(`${label} must contain JSON-serializable values.`);
  }

  return value;
}

function isJsonValue(value: unknown): value is JsonObject[keyof JsonObject] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function write(writer: Writable, value: string): void {
  writer.write(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}
