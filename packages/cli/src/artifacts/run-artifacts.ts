import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseEffectReceipt,
  parseEffectRequest,
  parseExternalStateObservation,
  parseFinalCandidate,
  parseMismatch,
  parseProofObject,
  parseReleaseDecision,
  parseRunEvent,
} from "@amca/contracts";
import { orderAndValidateRunEvents } from "@amca/kernel";
import { LocalJsonlSemanticLedger } from "@amca/ledger-local";
import type {
  EffectReceipt,
  EffectRequest,
  ExternalStateObservation,
  FinalCandidate,
  Mismatch,
  ProofObject,
  ReleaseDecision,
  RunEvent,
} from "@amca/protocol";

export class RunArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunArtifactError";
  }
}

export interface RunArtifacts {
  readonly runId: string;
  readonly events: readonly RunEvent[];
  readonly effectRequests: readonly EffectRequest[];
  readonly receipts: readonly EffectReceipt[];
  readonly observations: readonly ExternalStateObservation[];
  readonly finalCandidate: FinalCandidate;
  readonly proof: ProofObject;
  readonly mismatches: readonly Mismatch[];
  readonly releaseDecision: ReleaseDecision;
  readonly summary: string;
}

export interface BuildRunArtifactsInput {
  readonly runId: string;
  readonly scenarioId?: string;
  readonly events: readonly RunEvent[];
}

export function buildRunArtifactsFromEvents(
  input: BuildRunArtifactsInput,
): RunArtifacts {
  const events = orderAndValidateRunEvents(
    input.events.map((event) => parseRunEvent(event)),
    input.runId,
  );
  const finalCandidate = lastFinalCandidate(events);
  const proofEvent = lastEventOfType(events, "ProofGenerated");
  const releaseEvent = lastEventOfType(events, "ReleaseDecided");

  if (finalCandidate === undefined) {
    throw new RunArtifactError(
      `Run ${input.runId} cannot be serialized without a final candidate event.`,
    );
  }

  if (proofEvent === undefined) {
    throw new RunArtifactError(
      `Run ${input.runId} cannot be serialized without a proof event.`,
    );
  }

  if (releaseEvent === undefined) {
    throw new RunArtifactError(
      `Run ${input.runId} cannot be serialized without a release decision event.`,
    );
  }

  const proof = parseProofObject(proofEvent.payload.proof);
  const releaseDecision = parseReleaseDecision(releaseEvent.payload.decision);
  const mismatches = mismatchEventsFromEvents(events).map((event) =>
    parseMismatch(event.payload.mismatch),
  );
  const effectRequests = effectRequestEventsFromEvents(events).map((event) =>
    parseEffectRequest(event.payload.effectRequest),
  );
  const receipts = receiptEventsFromEvents(events).map((event) =>
    parseEffectReceipt(event.payload.receipt),
  );
  const observations = observationEventsFromEvents(events).map((event) =>
    parseExternalStateObservation(event.payload.observation),
  );

  assertRunId(input.runId, finalCandidate.runId, "final candidate");
  assertRunId(input.runId, proof.runId, "proof");
  assertRunId(input.runId, releaseDecision.runId, "release decision");
  for (const mismatch of mismatches) {
    assertRunId(input.runId, mismatch.runId, "mismatch");
  }
  for (const effectRequest of effectRequests) {
    assertRunId(input.runId, effectRequest.runId, "effect request");
  }
  for (const receipt of receipts) {
    assertRunId(input.runId, receipt.runId, "receipt");
  }
  for (const observation of observations) {
    assertRunId(input.runId, observation.runId, "observation");
  }

  return {
    runId: input.runId,
    events,
    effectRequests,
    receipts,
    observations,
    finalCandidate,
    proof,
    mismatches,
    releaseDecision,
    summary: buildSummary({
      runId: input.runId,
      eventCount: events.length,
      releaseDecision,
      mismatchTypes: mismatches.map((mismatch) => mismatch.type),
      ...(input.scenarioId === undefined
        ? {}
        : { scenarioId: input.scenarioId }),
    }),
  };
}

export async function writeRunArtifacts(
  storeDir: string,
  artifacts: RunArtifacts,
): Promise<string> {
  const normalizedArtifacts = buildRunArtifactsFromEvents({
    runId: artifacts.runId,
    events: artifacts.events,
  });
  assertArtifactsMatchEvents(artifacts, normalizedArtifacts);

  const runDir = path.join(storeDir, normalizedArtifacts.runId);
  await mkdir(runDir, { recursive: true });
  const ledger = new LocalJsonlSemanticLedger({ rootDir: storeDir });
  for (const event of normalizedArtifacts.events) {
    await ledger.appendAcceptedEvent(event);
  }
  await writeJson(
    path.join(runDir, "effect-requests.json"),
    normalizedArtifacts.effectRequests,
  );
  await writeJson(
    path.join(runDir, "receipts.json"),
    normalizedArtifacts.receipts,
  );
  await writeJson(
    path.join(runDir, "observations.json"),
    normalizedArtifacts.observations,
  );
  await writeJson(
    path.join(runDir, "final-candidate.json"),
    normalizedArtifacts.finalCandidate,
  );
  await writeJson(path.join(runDir, "proof.json"), normalizedArtifacts.proof);
  await writeJson(
    path.join(runDir, "mismatches.json"),
    normalizedArtifacts.mismatches,
  );
  await writeJson(
    path.join(runDir, "release-decision.json"),
    normalizedArtifacts.releaseDecision,
  );
  await writeFile(path.join(runDir, "summary.md"), artifacts.summary);
  return runDir;
}

export async function readRunArtifacts(
  storeDir: string,
  runId: string,
): Promise<RunArtifacts> {
  const runDir = path.join(storeDir, runId);
  const ledger = new LocalJsonlSemanticLedger({ rootDir: storeDir });
  const events = orderAndValidateRunEvents(
    await ledger.readRunEvents(runId),
    runId,
  );
  const effectRequests = await readArrayArtifact(
    path.join(runDir, "effect-requests.json"),
    parseEffectRequest,
    "effect requests",
  );
  const receipts = await readArrayArtifact(
    path.join(runDir, "receipts.json"),
    parseEffectReceipt,
    "receipts",
  );
  const observations = await readArrayArtifact(
    path.join(runDir, "observations.json"),
    parseExternalStateObservation,
    "observations",
  );
  const finalCandidate = await readObjectArtifact(
    path.join(runDir, "final-candidate.json"),
    parseFinalCandidate,
    "final candidate",
  );
  const proof = await readObjectArtifact(
    path.join(runDir, "proof.json"),
    parseProofObject,
    "proof",
  );
  const mismatches = await readArrayArtifact(
    path.join(runDir, "mismatches.json"),
    parseMismatch,
    "mismatches",
  );
  const releaseDecision = await readObjectArtifact(
    path.join(runDir, "release-decision.json"),
    parseReleaseDecision,
    "release decision",
  );
  const summary = await readRequiredFile(path.join(runDir, "summary.md"));

  const artifacts: RunArtifacts = {
    runId,
    events,
    effectRequests,
    receipts,
    observations,
    finalCandidate,
    proof,
    mismatches,
    releaseDecision,
    summary,
  };

  assertArtifactsMatchEvents(
    artifacts,
    buildRunArtifactsFromEvents({ runId, events }),
  );
  return artifacts;
}

export function effectRequestsFromArtifacts(
  artifacts: RunArtifacts,
): readonly EffectRequest[] {
  return artifacts.effectRequests;
}

export function receiptsFromArtifacts(
  artifacts: RunArtifacts,
): readonly EffectReceipt[] {
  return artifacts.receipts;
}

export function observationsFromArtifacts(
  artifacts: RunArtifacts,
): readonly ExternalStateObservation[] {
  return artifacts.observations;
}

function buildSummary(input: {
  readonly runId: string;
  readonly scenarioId?: string;
  readonly eventCount: number;
  readonly releaseDecision: ReleaseDecision;
  readonly mismatchTypes: readonly string[];
}): string {
  return [
    `# AMCA Run ${input.runId}`,
    "",
    ...(input.scenarioId === undefined
      ? []
      : [`- scenario: ${input.scenarioId}`]),
    `- status: ${input.releaseDecision.status}`,
    `- proofId: ${input.releaseDecision.proofId ?? "none"}`,
    `- events: ${String(input.eventCount)}`,
    `- approvedClaimIds: ${input.releaseDecision.approvedClaimIds.join(",") || "none"}`,
    `- blockingMismatchIds: ${input.releaseDecision.blockingMismatchIds.join(",") || "none"}`,
    `- mismatchTypes: ${input.mismatchTypes.join(",") || "none"}`,
    "",
  ].join("\n");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readArrayArtifact<TValue>(
  filePath: string,
  parse: (value: unknown) => TValue,
  label: string,
): Promise<TValue[]> {
  const parsed = await readJsonArtifact(filePath, label);
  if (!Array.isArray(parsed)) {
    throw new RunArtifactError(
      `${filePath} ${label} artifact must be an array.`,
    );
  }

  return parsed.map((value, index) => {
    try {
      return parse(value);
    } catch (error) {
      throw new RunArtifactError(
        `${filePath} ${label}[${String(index)}] is invalid: ${formatError(error)}`,
      );
    }
  });
}

async function readObjectArtifact<TValue>(
  filePath: string,
  parse: (value: unknown) => TValue,
  label: string,
): Promise<TValue> {
  const parsed = await readJsonArtifact(filePath, label);
  try {
    return parse(parsed);
  } catch (error) {
    throw new RunArtifactError(
      `${filePath} ${label} artifact is invalid: ${formatError(error)}`,
    );
  }
}

async function readJsonArtifact(
  filePath: string,
  label: string,
): Promise<unknown> {
  try {
    return JSON.parse(await readRequiredFile(filePath));
  } catch (error) {
    throw new RunArtifactError(
      `${filePath} ${label} artifact is missing or malformed: ${formatError(error)}`,
    );
  }
}

async function readRequiredFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new RunArtifactError(
      `${filePath} is required but could not be read: ${formatError(error)}`,
    );
  }
}

function assertArtifactsMatchEvents(
  artifacts: RunArtifacts,
  eventDerived: RunArtifacts,
): void {
  assertDeepEqualArtifact("events", artifacts.events, eventDerived.events);
  assertDeepEqualArtifact(
    "effect-requests",
    artifacts.effectRequests,
    eventDerived.effectRequests,
  );
  assertDeepEqualArtifact(
    "receipts",
    artifacts.receipts,
    eventDerived.receipts,
  );
  assertDeepEqualArtifact(
    "observations",
    artifacts.observations,
    eventDerived.observations,
  );
  assertDeepEqualArtifact(
    "final-candidate",
    artifacts.finalCandidate,
    eventDerived.finalCandidate,
  );
  assertDeepEqualArtifact("proof", artifacts.proof, eventDerived.proof);
  assertDeepEqualArtifact(
    "mismatches",
    artifacts.mismatches,
    eventDerived.mismatches,
  );
  assertDeepEqualArtifact(
    "release-decision",
    artifacts.releaseDecision,
    eventDerived.releaseDecision,
  );
}

function assertDeepEqualArtifact(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RunArtifactError(
      `${label} artifact does not match the admitted run events.`,
    );
  }
}

function assertRunId(
  expectedRunId: string,
  actualRunId: string,
  label: string,
): void {
  if (actualRunId !== expectedRunId) {
    throw new RunArtifactError(
      `${label} runId ${actualRunId} does not match artifact runId ${expectedRunId}.`,
    );
  }
}

function effectRequestEventsFromEvents(
  events: readonly RunEvent[],
): RunEvent<"EffectRequested">[] {
  return events.filter(
    (event): event is RunEvent<"EffectRequested"> =>
      event.type === "EffectRequested",
  );
}

function receiptEventsFromEvents(
  events: readonly RunEvent[],
): RunEvent<"EffectReceiptRecorded">[] {
  return events.filter(
    (event): event is RunEvent<"EffectReceiptRecorded"> =>
      event.type === "EffectReceiptRecorded",
  );
}

function observationEventsFromEvents(
  events: readonly RunEvent[],
): RunEvent<"ExternalStateObserved">[] {
  return events.filter(
    (event): event is RunEvent<"ExternalStateObserved"> =>
      event.type === "ExternalStateObserved",
  );
}

function mismatchEventsFromEvents(
  events: readonly RunEvent[],
): RunEvent<"MismatchDetected">[] {
  return events.filter(
    (event): event is RunEvent<"MismatchDetected"> =>
      event.type === "MismatchDetected",
  );
}

function lastFinalCandidate(
  events: readonly RunEvent[],
): FinalCandidate | undefined {
  let finalCandidate: FinalCandidate | undefined;
  for (const event of events) {
    if (event.type === "ProposalReceived") {
      const proposalEvent = event as RunEvent<"ProposalReceived">;
      if (proposalEvent.payload.proposal.kind === "final_candidate") {
        finalCandidate = parseFinalCandidate(proposalEvent.payload.proposal);
      }
    }
  }

  return finalCandidate;
}

function lastEventOfType<TType extends RunEvent["type"]>(
  events: readonly RunEvent[],
  type: TType,
): RunEvent<TType> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event as RunEvent<TType>;
    }
  }

  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
