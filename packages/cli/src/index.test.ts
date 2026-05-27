import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalObjectHash } from "@amca/contracts";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scenariosDir = path.join(repoRoot, "scenarios");
const harnessScenariosDir = path.join(scenariosDir, "harness");

describe("AMCA CLI", () => {
  it("runs a blocked scenario and writes inspectable local artifacts", async () => {
    const store = await makeTempStore();
    const output = createOutput();

    const exitCode = await runCli({
      argv: [
        "run",
        path.join(scenariosDir, "tests-passed-blocked.json"),
        "--store",
        store,
      ],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("status: blocked");
    expect(output.text()).toContain("expectation: pass");

    const runDir = path.join(store, "run_tests_passed_blocked");
    const decision = JSON.parse(
      await readFile(path.join(runDir, "release-decision.json"), "utf8"),
    ) as { status: string };
    const events = await readFile(path.join(runDir, "events.jsonl"), "utf8");

    expect(decision.status).toBe("blocked");
    expect(events).toContain('"ProofGenerated"');
    expect(events).toContain('"MismatchDetected"');
    expect(events).not.toContain('"FinalReleased"');

    await rm(store, { force: true, recursive: true });
  });

  it("runs a released scenario and records FinalReleased", async () => {
    const store = await makeTempStore();
    const output = createOutput();

    const exitCode = await runCli({
      argv: [
        "run",
        path.join(scenariosDir, "tests-passed-released.json"),
        "--store",
        store,
      ],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("status: released");

    const events = await readFile(
      path.join(store, "run_tests_passed_released", "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"FinalReleased"');

    await rm(store, { force: true, recursive: true });
  });

  it("inspects a persisted run", async () => {
    const store = await makeTempStore();
    await runCli({
      argv: [
        "run",
        path.join(scenariosDir, "pr-current-state-stale-blocked.json"),
        "--store",
        store,
      ],
      cwd: repoRoot,
      stdout: createOutput().stdout,
      stderr: createOutput().stderr,
    });

    const output = createOutput();
    const exitCode = await runCli({
      argv: ["inspect", "run_pr_current_state_stale", "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("AMCA run: run_pr_current_state_stale");
    expect(output.text()).toContain("status: blocked");
    expect(output.text()).toContain("stale_external_state");

    await rm(store, { force: true, recursive: true });
  });

  it("replays a persisted run without external execution", async () => {
    const store = await makeTempStore();
    await runCli({
      argv: [
        "run",
        path.join(scenariosDir, "pr-current-state-fresh-released.json"),
        "--store",
        store,
      ],
      cwd: repoRoot,
      stdout: createOutput().stdout,
      stderr: createOutput().stderr,
    });

    const output = createOutput();
    const exitCode = await runCli({
      argv: ["replay", "run_pr_current_state_fresh", "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("AMCA replay");
    expect(output.text()).toContain("status: pass");
    expect(output.text()).toContain("replayedDecision: released");

    await rm(store, { force: true, recursive: true });
  });

  it("runs the locked scenario suite through amca test", async () => {
    const store = await makeTempStore();
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["test", scenariosDir, "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("scenarios: 7");
    expect(output.text()).toContain("passed: 7");
    expect(output.text()).toContain("failed: 0");

    await rm(store, { force: true, recursive: true });
  });

  it("runs a governed harness scenario through the CLI", async () => {
    const store = await makeTempStore();
    const scenarioDir = await makeTempStore();
    const output = createOutput();
    const scenarioPath = path.join(scenarioDir, "harness-released.json");
    await writeJson(scenarioPath, harnessScenario());

    const exitCode = await runCli({
      argv: ["harness", "run", scenarioPath, "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("AMCA harness scenario");
    expect(output.text()).toContain("status: released");
    expect(output.text()).toContain("adapterCalls: 1");
    expect(output.text()).toContain("expectation: pass");

    const runDir = path.join(store, "run_cli_harness_tests_passed");
    const receipts = JSON.parse(
      await readFile(path.join(runDir, "receipts.json"), "utf8"),
    ) as unknown[];
    const effectRequests = JSON.parse(
      await readFile(path.join(runDir, "effect-requests.json"), "utf8"),
    ) as unknown[];
    const finalCandidate = JSON.parse(
      await readFile(path.join(runDir, "final-candidate.json"), "utf8"),
    ) as { kind: string };
    const events = await readFile(path.join(runDir, "events.jsonl"), "utf8");

    expect(receipts).toHaveLength(1);
    expect(effectRequests).toHaveLength(1);
    expect(finalCandidate.kind).toBe("final_candidate");
    expect(events).toContain('"EffectRequested"');
    expect(events).toContain('"EffectReceiptRecorded"');
    expect(events).toContain('"FinalReleased"');

    await rm(store, { force: true, recursive: true });
    await rm(scenarioDir, { force: true, recursive: true });
  });

  it("runs a governed harness current-state scenario and writes admitted observations", async () => {
    const store = await makeTempStore();
    const scenarioDir = await makeTempStore();
    const output = createOutput();
    const scenarioPath = path.join(
      scenarioDir,
      "harness-current-state-released.json",
    );
    await writeJson(scenarioPath, harnessCurrentStateScenario());

    const exitCode = await runCli({
      argv: ["harness", "run", scenarioPath, "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("status: released");
    expect(output.text()).toContain("expectation: pass");

    const runDir = path.join(store, "run_cli_harness_pr_open");
    const observations = JSON.parse(
      await readFile(path.join(runDir, "observations.json"), "utf8"),
    ) as Array<{ evidence: Array<{ sourceEventId: string }> }>;
    const events = await readFile(path.join(runDir, "events.jsonl"), "utf8");

    expect(observations).toHaveLength(1);
    expect(observations[0]?.evidence[0]?.sourceEventId).toBe(
      "evt_cmd_cli_harness_pr_open_external_state_observed",
    );
    expect(events).toContain('"ExternalStateObserved"');

    const inspectOutput = createOutput();
    const inspectExit = await runCli({
      argv: ["inspect", "run_cli_harness_pr_open", "--store", store],
      cwd: repoRoot,
      stdout: inspectOutput.stdout,
      stderr: inspectOutput.stderr,
    });

    expect(inspectExit).toBe(0);
    expect(inspectOutput.text()).toContain("observations: 1");
    expect(inspectOutput.text()).toContain("proofVerdict: pass");

    await rm(store, { force: true, recursive: true });
    await rm(scenarioDir, { force: true, recursive: true });
  });

  it("fails closed on unknown external observation scenario fields", async () => {
    const store = await makeTempStore();
    const scenarioDir = await makeTempStore();
    const output = createOutput();
    const scenarioPath = path.join(
      scenarioDir,
      "harness-current-state-invalid.json",
    );
    await writeJson(scenarioPath, {
      ...harnessCurrentStateScenario(),
      fakeAdapter: {
        ...(harnessCurrentStateScenario().fakeAdapter as Record<
          string,
          unknown
        >),
        externalStateObservation: {
          ...((
            harnessCurrentStateScenario().fakeAdapter as Record<string, unknown>
          ).externalStateObservation as Record<string, unknown>),
          unknownSemanticField: "must fail closed",
        },
      },
    });

    const exitCode = await runCli({
      argv: ["harness", "run", scenarioPath, "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toContain("unknown field(s): unknownSemanticField");

    await rm(store, { force: true, recursive: true });
    await rm(scenarioDir, { force: true, recursive: true });
  });

  it("runs a governed harness current-state scenario and writes observation artifacts", async () => {
    const store = await makeTempStore();
    const output = createOutput();

    const exitCode = await runCli({
      argv: [
        "harness",
        "run",
        path.join(harnessScenariosDir, "pr-current-state-fresh-released.json"),
        "--store",
        store,
      ],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("status: released");
    expect(output.text()).toContain("expectation: pass");

    const runDir = path.join(store, "run_harness_pr_current_state_fresh");
    const observations = JSON.parse(
      await readFile(path.join(runDir, "observations.json"), "utf8"),
    ) as Array<{
      observationType: string;
      evidence: Array<{ sourceEventId: string }>;
    }>;
    const events = await readFile(path.join(runDir, "events.jsonl"), "utf8");

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      observationType: "github.pull_request_state",
      evidence: [
        {
          sourceEventId:
            "evt_cmd_harness_pr_current_state_fresh_external_state_observed",
        },
      ],
    });
    expect(events).toContain('"ExternalStateObserved"');

    const inspectOutput = createOutput();
    const inspectExitCode = await runCli({
      argv: ["inspect", "run_harness_pr_current_state_fresh", "--store", store],
      cwd: repoRoot,
      stdout: inspectOutput.stdout,
      stderr: inspectOutput.stderr,
    });

    expect(inspectExitCode).toBe(0);
    expect(inspectOutput.text()).toContain("observations: 1");

    await rm(store, { force: true, recursive: true });
  });

  it("blocks a governed harness current-state scenario when the observation is stale", async () => {
    const store = await makeTempStore();
    const output = createOutput();

    const exitCode = await runCli({
      argv: [
        "harness",
        "run",
        path.join(harnessScenariosDir, "pr-current-state-stale-blocked.json"),
        "--store",
        store,
      ],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("status: blocked");
    expect(output.text()).toContain("stale_external_state");
    expect(output.text()).toContain("expectation: pass");

    const observations = JSON.parse(
      await readFile(
        path.join(
          store,
          "run_harness_pr_current_state_stale",
          "observations.json",
        ),
        "utf8",
      ),
    ) as unknown[];
    expect(observations).toHaveLength(1);

    await rm(store, { force: true, recursive: true });
  });

  it("fails closed when a fake adapter external observation has unknown fields", async () => {
    const store = await makeTempStore();
    const scenarioDir = await makeTempStore();
    const output = createOutput();
    const scenario = JSON.parse(
      await readFile(
        path.join(harnessScenariosDir, "pr-current-state-fresh-released.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const fakeAdapter = scenario.fakeAdapter as Record<string, unknown>;
    const externalStateObservation =
      fakeAdapter.externalStateObservation as Record<string, unknown>;
    fakeAdapter.externalStateObservation = {
      ...externalStateObservation,
      unexpected: true,
    };
    const scenarioPath = path.join(
      scenarioDir,
      "harness-observation-unknown-field.json",
    );
    await writeJson(scenarioPath, scenario);

    const exitCode = await runCli({
      argv: ["harness", "run", scenarioPath, "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toContain(
      "fakeAdapter.externalStateObservation has unknown field(s): unexpected",
    );

    await rm(store, { force: true, recursive: true });
    await rm(scenarioDir, { force: true, recursive: true });
  });

  it("fails a governed harness write before adapter receipt admission when idempotency is missing", async () => {
    const store = await makeTempStore();
    const scenarioDir = await makeTempStore();
    const output = createOutput();
    const scenarioPath = path.join(scenarioDir, "harness-write-blocked.json");
    await writeJson(
      scenarioPath,
      harnessScenario({
        runId: "run_cli_harness_write_missing_idempotency",
        commandId: "cmd_cli_harness_write_missing_idempotency",
        sideEffectClass: "idempotent_write",
      }),
    );

    const exitCode = await runCli({
      argv: ["harness", "run", scenarioPath, "--store", store],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toContain("idempotencyKey");

    await expect(
      readFile(
        path.join(
          store,
          "run_cli_harness_write_missing_idempotency",
          "receipts.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await rm(store, { force: true, recursive: true });
    await rm(scenarioDir, { force: true, recursive: true });
  });

  it("validates capability contract JSON files without executing them", async () => {
    const capabilityDir = await makeTempStore();
    const output = createOutput();
    await writeJson(
      path.join(capabilityDir, "shell.run_tests.json"),
      validCapabilityContract(),
    );

    const exitCode = await runCli({
      argv: ["validate", capabilityDir],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain("AMCA capability validation");
    expect(output.text()).toContain("files: 1");
    expect(output.text()).toContain("valid: 1");
    expect(output.text()).toContain("invalid: 0");
    expect(output.text()).toContain("VALID shell.run_tests");

    await rm(capabilityDir, { force: true, recursive: true });
  });

  it("reports capability validation failures with field diagnostics", async () => {
    const capabilityDir = await makeTempStore();
    const nestedDir = path.join(capabilityDir, "nested");
    const output = createOutput();
    await mkdir(nestedDir);
    await writeJson(path.join(nestedDir, "invalid.json"), {
      ...validCapabilityContract(),
      sideEffectClass: "magical_write",
      proofRules: [
        {
          ...validProofRule(),
          execute: "return true",
        },
      ],
    });

    const exitCode = await runCli({
      argv: ["validate", capabilityDir],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toContain("files: 1");
    expect(output.text()).toContain("valid: 0");
    expect(output.text()).toContain("invalid: 1");
    expect(output.text()).toContain("INVALID nested/invalid.json");
    expect(output.text()).toContain("sideEffectClass");
    expect(output.text()).toContain("Unrecognized key");

    await rm(capabilityDir, { force: true, recursive: true });
  });

  it("fails validate when a directory has no capability JSON files", async () => {
    const capabilityDir = await makeTempStore();
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["validate", capabilityDir],
      cwd: repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toContain("No capability JSON files found");

    await rm(capabilityDir, { force: true, recursive: true });
  });
});

async function makeTempStore(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "amca-cli-runs-"));
}

function createOutput(): {
  readonly stdout: { write: (chunk: string | Uint8Array) => boolean };
  readonly stderr: { write: (chunk: string | Uint8Array) => boolean };
  readonly text: () => string;
} {
  const chunks: string[] = [];
  const writer = {
    write: (chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk));
      return true;
    },
  };

  return {
    stdout: writer,
    stderr: writer,
    text: () => chunks.join(""),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validCapabilityContract(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    capabilityId: "shell.run_tests",
    profile: "standard",
    sideEffectClass: "compute",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    receiptSchema: {
      type: "object",
      properties: {
        result: { enum: ["passed", "failed"] },
      },
      required: ["result"],
      additionalProperties: false,
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType: "test_run",
      },
    ],
    supportedClaims: [
      {
        claimType: "test_result",
        predicateKind: "test_result",
        requiredReceiptType: "test_run",
        expectedStatuses: ["passed"],
      },
    ],
    proofRules: [validProofRule()],
  };
}

function validProofRule(): Record<string, unknown> {
  return {
    ruleId: "shell.run_tests.test_result",
    version: 1,
    claimType: "test_result",
    predicateKind: "test_result",
    description: "A test-result claim requires a matching test receipt.",
    evidence: [
      {
        requirementId: "shell.run_tests.receipt",
        evidenceKind: "effect_receipt",
        source: "claim.evidenceRefs",
        minimumCount: 1,
        resolvesTo: "effect_receipt",
      },
    ],
    match: {
      operator: "all",
      clauses: [
        {
          kind: "field_equals",
          left: {
            source: "effect_receipt",
            path: "effectReceipt.receiptType",
          },
          right: {
            source: "literal",
            value: "test_run",
          },
          presence: "always",
        },
      ],
    },
  };
}

function validCurrentStateProofRule(): Record<string, unknown> {
  return {
    ruleId: "amca.v0.proof.current_state",
    version: 1,
    claimType: "current_state",
    predicateKind: "current_state",
    description:
      "A current-state claim is supported by a matching fresh external observation.",
    evidence: [
      {
        requirementId: "current_state.external_observation",
        evidenceKind: "external_observation",
        source: "claim.evidenceRefs",
        minimumCount: 1,
        resolvesTo: "external_state_observation",
      },
    ],
    match: {
      operator: "all",
      clauses: [
        {
          kind: "field_equals",
          left: {
            source: "external_observation",
            path: "externalObservation.observationType",
          },
          right: {
            source: "claim_predicate",
            path: "claim.predicate.observationType",
          },
          presence: "always",
        },
        {
          kind: "field_equals",
          left: {
            source: "external_observation",
            path: "externalObservation.subjectType",
          },
          right: {
            source: "claim_predicate",
            path: "claim.predicate.subjectType",
          },
          presence: "always",
        },
        {
          kind: "field_equals",
          left: {
            source: "external_observation",
            path: "externalObservation.subjectId",
          },
          right: {
            source: "claim_predicate",
            path: "claim.predicate.subjectId",
          },
          presence: "always",
        },
        {
          kind: "fresh_within",
          observedAt: {
            source: "external_observation",
            path: "externalObservation.observedAt",
          },
          ttlMs: {
            source: "claim_predicate",
            path: "claim.predicate.freshnessRequirementMs",
          },
          evaluatedAt: "proof.generatedAt",
        },
        {
          kind: "observed_state_satisfies_predicate",
          observedValue: {
            source: "external_observation_dynamic",
            root: "externalObservation.observedState",
            pathFrom: "claim.predicate.property",
          },
          operator: {
            source: "claim_predicate",
            path: "claim.predicate.operator",
          },
          expectedValue: {
            source: "claim_predicate",
            path: "claim.predicate.expectedValue",
          },
          supportedOperators: ["equals", "not_equals", "contains"],
        },
      ],
    },
  };
}

function harnessScenario(
  input: {
    readonly runId?: string;
    readonly commandId?: string;
    readonly sideEffectClass?: string;
    readonly idempotencyKey?: string;
  } = {},
): Record<string, unknown> {
  const runId = input.runId ?? "run_cli_harness_tests_passed";
  const commandId = input.commandId ?? "cmd_cli_harness_tests_passed";
  const sideEffectClass = input.sideEffectClass ?? "compute";
  const now = "2026-05-24T12:00:00.000Z";
  const payload = {
    result: "passed",
    testSuiteId: "unit",
  };
  const evidenceRef = {
    evidenceId: `ev_${commandId}`,
    kind: "effect_receipt",
    sourceEventId: `evt_${commandId}_receipt_recorded`,
    hash: canonicalObjectHash(payload),
    observedAt: now,
    sensitivity: "internal",
  };
  return {
    kind: "governed_harness_run_scenario",
    id: `${runId}_scenario`,
    runId,
    profile: "standard",
    startedAt: "2026-05-24T11:59:00.000Z",
    clock: now,
    toolCommand: {
      kind: "tool_command_request",
      commandId,
      runId,
      capabilityId: "tests.run",
      toolId: "tests.run",
      args: {
        testSuiteId: "unit",
      },
      sideEffectClass,
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    },
    capability: {
      schemaVersion: 1,
      capabilityId: "tests.run",
      profile: "standard",
      sideEffectClass,
      inputSchema: {
        type: "object",
        properties: {
          testSuiteId: { type: "string" },
        },
        required: ["testSuiteId"],
        additionalProperties: false,
      },
      receiptSchema: {
        type: "object",
        properties: {
          result: { enum: ["passed", "failed"] },
          testSuiteId: { type: "string" },
        },
        required: ["result", "testSuiteId"],
        additionalProperties: false,
      },
      evidence: [
        {
          evidenceKind: "effect_receipt",
          receiptType: "test_run",
        },
      ],
      supportedClaims: [
        {
          claimType: "test_result",
          predicateKind: "test_result",
          requiredReceiptType: "test_run",
          expectedStatuses: ["passed"],
        },
      ],
      proofRules: [validProofRule()],
    },
    fakeAdapter: {
      adapterId: "adapter.tests.run",
      receiptType: "test_run",
      status: "succeeded",
      payload,
      observedAt: now,
      evidenceId: `ev_${commandId}`,
      sensitivity: "internal",
    },
    finalCandidate: {
      kind: "final_candidate",
      candidateId: `candidate_${runId}`,
      runId,
      claims: [
        {
          claimId: `claim_${runId}`,
          type: "test_result",
          statement: "Tests passed.",
          predicate: {
            kind: "test_result",
            capabilityId: "tests.run",
            testSuiteId: "unit",
            expectedStatus: "passed",
            requiredReceiptType: "test_run",
          },
          evidenceRefs: [evidenceRef],
          criticality: "medium",
        },
      ],
      narrativeDraft: "Tests passed.",
    },
    expected: {
      releaseStatus: "released",
      mismatchTypes: [],
      approvedClaimIds: [`claim_${runId}`],
    },
  };
}

function harnessCurrentStateScenario(
  input: {
    readonly runId?: string;
    readonly commandId?: string;
    readonly observedAt?: string;
    readonly expectedStatus?: "released" | "blocked";
    readonly mismatchTypes?: readonly string[];
  } = {},
): Record<string, unknown> {
  const runId = input.runId ?? "run_cli_harness_pr_open";
  const commandId = input.commandId ?? "cmd_cli_harness_pr_open";
  const now = "2026-05-24T12:00:00.000Z";
  const observedAt = input.observedAt ?? now;
  const observedState = { state: "open" };
  const observationHash = canonicalObjectHash(observedState);
  const receiptPayload = { checked: true };
  const observationEvidenceRef = {
    evidenceId: `ev_obs_${commandId}`,
    kind: "external_observation",
    sourceEventId: `evt_${commandId}_external_state_observed`,
    hash: observationHash,
    observedAt,
    sensitivity: "internal",
  };

  return {
    kind: "governed_harness_run_scenario",
    id: `${runId}_scenario`,
    runId,
    profile: "standard",
    startedAt: "2026-05-24T11:59:00.000Z",
    clock: now,
    toolCommand: {
      kind: "tool_command_request",
      commandId,
      runId,
      capabilityId: "github.observe_pull_request_state",
      toolId: "github.observe_pull_request_state",
      args: {
        pullRequestId: "123",
      },
      sideEffectClass: "read",
    },
    capability: {
      schemaVersion: 1,
      capabilityId: "github.observe_pull_request_state",
      profile: "standard",
      sideEffectClass: "read",
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
          receiptType: "github.pull_request_state_checked",
        },
        {
          evidenceKind: "external_observation",
          observationType: "github.pull_request_state",
        },
      ],
      supportedClaims: [
        {
          claimType: "current_state",
          predicateKind: "current_state",
          observationType: "github.pull_request_state",
        },
      ],
      proofRules: [validCurrentStateProofRule()],
    },
    fakeAdapter: {
      adapterId: "adapter.github.observe_pull_request_state",
      receiptType: "github.pull_request_state_checked",
      status: "succeeded",
      payload: receiptPayload,
      observedAt,
      evidenceId: `ev_receipt_${commandId}`,
      sensitivity: "internal",
      externalStateObservation: {
        observationType: "github.pull_request_state",
        subjectType: "pull_request",
        subjectId: "123",
        observedState,
        observedAt,
        expiresAt: "2026-05-24T12:01:00.000Z",
        evidenceId: `ev_obs_${commandId}`,
        sensitivity: "internal",
      },
    },
    finalCandidate: {
      kind: "final_candidate",
      candidateId: `candidate_${runId}`,
      runId,
      claims: [
        {
          claimId: `claim_${runId}`,
          type: "current_state",
          statement: "Pull request 123 is currently open.",
          predicate: {
            kind: "current_state",
            subjectType: "pull_request",
            subjectId: "123",
            property: "state",
            operator: "equals",
            expectedValue: "open",
            observationType: "github.pull_request_state",
            freshnessRequirementMs: 60_000,
          },
          evidenceRefs: [observationEvidenceRef],
          criticality: "medium",
        },
      ],
      narrativeDraft: "Pull request 123 is currently open.",
    },
    expected: {
      releaseStatus: input.expectedStatus ?? "released",
      mismatchTypes: input.mismatchTypes ?? [],
      approvedClaimIds:
        input.expectedStatus === "blocked" ? [] : [`claim_${runId}`],
    },
  };
}
