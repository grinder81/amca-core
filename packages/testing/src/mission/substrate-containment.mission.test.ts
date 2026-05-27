import { describe, expect, it } from "vitest";

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LangGraphBoundaryAdapter,
  LANGGRAPH_ADAPTER_CERTIFICATION,
  invokeLangGraphRuntimeBridge,
  translateLangGraphToolCallToToolCommandRequest,
} from "@amca/adapters-langgraph";
import * as langGraphExports from "@amca/adapters-langgraph";
import {
  certificationLevelRank,
  validateCertificationManifest,
  type CertificationManifest,
} from "@amca/adapters-conformance";
import {
  assessTemporalHistoryAuthority,
  buildTemporalActivityEnvelope,
  buildTemporalActivityRetryEnvelope,
  correlateTemporalActivityReceipt,
  createTemporalConformanceReport,
  TEMPORAL_ADAPTER_CERTIFICATION,
  temporalHistoryPayload,
  temporalRetryPreservesIdempotency,
} from "@amca/adapters-temporal";
import type { EffectRequest, EvidenceRef, JsonObject } from "@amca/protocol";

import {
  candidateWith,
  FRESH_OBSERVED_AT,
  GENERATED_AT,
  startedKernel,
  testResultClaim,
} from "./mission-helpers.js";
import adaptersLangGraphPackage from "../../../../packages/adapters-langgraph/package.json" with { type: "json" };
import adaptersTemporalPackage from "../../../../packages/adapters-temporal/package.json" with { type: "json" };
import cliPackage from "../../../../packages/cli/package.json" with { type: "json" };
import contractsPackage from "../../../../packages/contracts/package.json" with { type: "json" };
import kernelPackage from "../../../../packages/kernel/package.json" with { type: "json" };
import proofPackage from "../../../../packages/proof/package.json" with { type: "json" };
import protocolPackage from "../../../../packages/protocol/package.json" with { type: "json" };

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const langGraphRunId = "mission_langgraph_substrate_containment";
const langGraphAdapter = new LangGraphBoundaryAdapter({
  adapterId: "mission_langgraph_adapter",
  runId: langGraphRunId,
});
const checkpoint = {
  checkpointId: "checkpoint_mission_001",
  threadId: "thread_mission_001",
  graphId: "graph_mission_001",
  nodeId: "agent_node",
};

describe("Mission P8 substrate containment", () => {
  it("keeps approved substrate adapters as boundary packages instead of core truth", () => {
    expect(adaptersLangGraphPackage.name).toBe("@amca/adapters-langgraph");
    expect(workspaceDependencies(adaptersLangGraphPackage)).toEqual([
      "@amca/adapters-conformance",
      "@amca/contracts",
      "@amca/protocol",
    ]);
    expect(adaptersTemporalPackage.name).toBe("@amca/adapters-temporal");
    expect(workspaceDependencies(adaptersTemporalPackage)).toEqual([
      "@amca/adapters-conformance",
      "@amca/contracts",
      "@amca/protocol",
    ]);
  });

  it("does not let execution substrates become core package dependencies", () => {
    for (const packageJson of [
      protocolPackage,
      contractsPackage,
      proofPackage,
      kernelPackage,
      cliPackage,
    ]) {
      const dependencies = dependencyNames(packageJson);

      expect(dependencies).not.toContain("@langchain/langgraph");
      expect(dependencies).not.toContain("@temporalio/common");
      expect(dependencies).not.toContain("@temporalio/client");
      expect(dependencies).not.toContain("@temporalio/worker");
      expect(dependencies).not.toContain("@temporalio/workflow");
      expect(dependencies).not.toContain("@amca/adapters-langgraph");
      expect(dependencies).not.toContain("@amca/adapters-temporal");
    }

    const langGraphDependencies = dependencyNames(adaptersLangGraphPackage);
    expect(langGraphDependencies).not.toContain("@temporalio/common");
    expect(langGraphDependencies).not.toContain("@temporalio/client");
    expect(langGraphDependencies).not.toContain("@temporalio/worker");
    expect(langGraphDependencies).not.toContain("@temporalio/workflow");

    const temporalDependencies = dependencyNames(adaptersTemporalPackage);
    expect(temporalDependencies).not.toContain("@langchain/langgraph");
    expect(temporalDependencies).not.toContain("@temporalio/client");
    expect(temporalDependencies).not.toContain("@temporalio/worker");
  });

  it("runtime bridge certification declares only named maturity levels", () => {
    expect(
      validateCertificationManifest(LANGGRAPH_ADAPTER_CERTIFICATION).success,
    ).toBe(true);
    expect(LANGGRAPH_ADAPTER_CERTIFICATION.currentLevel).toBe(
      "level_2_tool_intercepting",
    );
    expect(
      certificationLevelRank(LANGGRAPH_ADAPTER_CERTIFICATION.currentLevel),
    ).toBe(certificationLevelRank("level_2_tool_intercepting"));
    expect(LANGGRAPH_ADAPTER_CERTIFICATION.forbiddenAuthority).toEqual(
      expect.arrayContaining([
        "external tool execution",
        "receipt admission",
        "release decision",
        "proof authority",
      ]),
    );

    expect(
      validateCertificationManifest(TEMPORAL_ADAPTER_CERTIFICATION).success,
    ).toBe(true);
    expect(
      certificationLevelRank(TEMPORAL_ADAPTER_CERTIFICATION.currentLevel),
    ).toBeLessThanOrEqual(certificationLevelRank("level_1_proposal_adapter"));
    expect(TEMPORAL_ADAPTER_CERTIFICATION.forbiddenAuthority).toEqual(
      expect.arrayContaining([
        "worker runtime execution",
        "receipt admission",
        "release decision",
        "proof authority",
      ]),
    );
  });

  it("runtime bridge certification blocks Level 2+ overclaims without named evidence", () => {
    for (const manifest of [
      LANGGRAPH_ADAPTER_CERTIFICATION,
      TEMPORAL_ADAPTER_CERTIFICATION,
    ]) {
      const level2Attempt = validateCertificationManifest({
        ...manifest,
        currentLevel: "level_2_tool_intercepting",
        evidence: emptyCertificationEvidence(),
      } satisfies CertificationManifest);
      const level3Attempt = validateCertificationManifest({
        ...manifest,
        currentLevel: "level_3_replay_certified",
        evidence: {
          ...emptyCertificationEvidence(),
          focusedCommands: [
            "pnpm exec vitest run packages/testing/src/mission/substrate-containment.mission.test.ts -t runtime-tool-interception-certification",
          ],
        },
      } satisfies CertificationManifest);
      const level4Attempt = validateCertificationManifest({
        ...manifest,
        currentLevel: "level_4_critical_path_certified",
        evidence: {
          ...emptyCertificationEvidence(),
          focusedCommands: [
            "pnpm exec vitest run packages/testing/src/mission/substrate-containment.mission.test.ts -t runtime-tool-interception-certification",
            "pnpm exec vitest run packages/testing/src/mission/replay-causality.mission.test.ts -t runtime-replay-certification",
          ],
        },
      } satisfies CertificationManifest);

      expect(certificationIssueCodes(level2Attempt)).toContain(
        "tool_interception_evidence_missing",
      );
      expect(certificationIssueCodes(level3Attempt)).toContain(
        "replay_certification_evidence_missing",
      );
      expect(certificationIssueCodes(level4Attempt)).toContain(
        "critical_path_evidence_missing",
      );
    }
  });

  it("http-readonly-real-fetch-is-confined-to-readonly-adapter", () => {
    const forbiddenRuntimeTokens = [
      "http.request",
      "https.request",
      "undici",
      "axios",
      "XMLHttpRequest",
    ];
    const allowedFetchFiles = [
      path.join(repoRoot, "packages/adapters-tools/src/github-rest-adapter.ts"),
      path.join(
        repoRoot,
        "packages/adapters-tools/src/http-readonly-observation-adapter.ts",
      ),
    ];
    const adapterSourceFiles = sourceFiles(
      path.join(repoRoot, "packages/adapters-tools/src"),
    ).filter((sourceFile) => !sourceFile.endsWith(".test.ts"));
    const filesMentioningFetch: string[] = [];

    for (const sourceFile of adapterSourceFiles) {
      const source = readFileSync(sourceFile, "utf8");
      if (source.includes("fetch")) {
        filesMentioningFetch.push(sourceFile);
      }
      for (const token of forbiddenRuntimeTokens) {
        expect(
          source,
          `${sourceFile} must not contain unmanaged HTTP execution token ${token}`,
        ).not.toContain(token);
      }
    }

    expect(filesMentioningFetch).toEqual(allowedFetchFiles.sort());
  });

  it("langgraph-runtime-bridge-no-release-authority", async () => {
    const result = await invokeLangGraphRuntimeBridge({
      adapter: langGraphAdapter,
      graph: {
        invoke: () =>
          Promise.resolve({
            toolCalls: [
              {
                toolCallId: "tool_call_runtime_mission",
                capabilityId: "github.observe_rest_resource",
                toolId: "github.rest.get",
                args: { method: "GET", path: "/repos/acme/widgets" },
                sideEffectClass: "read",
                checkpoint,
              },
            ],
          }),
      },
      input: {},
    });

    expect(result.conformanceReport.status).toBe("pass");
    expect(result.toolCommands).toHaveLength(1);
    expect(result).toMatchObject({
      externalToolExecution: false,
      proofAuthority: false,
      releaseAuthority: false,
    });
    expect(langGraphExports).not.toHaveProperty("admitLangGraphReceipt");
    expect(langGraphExports).not.toHaveProperty("releaseLangGraphDecision");
    expect(langGraphExports).not.toHaveProperty("generateLangGraphProof");
  });

  it("langgraph-tool-call-bypass-blocked", () => {
    const toolCommand = translateLangGraphToolCallToToolCommandRequest({
      toolCallId: "tool_call_mission",
      runId: langGraphRunId,
      capabilityId: "shell.run_tests",
      toolId: "pnpm.test",
      args: { command: "pnpm test" },
      sideEffectClass: "compute",
      checkpoint,
    });
    const report = langGraphAdapter.evaluateConformance([
      langGraphAdapter.toolCallEmission({
        toolCallId: "tool_call_mission",
        capabilityId: "shell.run_tests",
        toolId: "pnpm.test",
        args: { command: "pnpm test" },
        sideEffectClass: "compute",
        checkpoint,
      }),
      {
        kind: "effect_receipt",
        emissionId: "langgraph_receipt_bypass",
        adapterId: langGraphAdapter.adapterId,
        substrate: "langgraph",
        runId: langGraphRunId,
        receipt: {
          receiptId: "receipt_langgraph_bypass",
          effectId: "effect_langgraph_bypass",
          runId: langGraphRunId,
          capabilityId: "shell.run_tests",
          receiptType: "test_run",
          status: "succeeded",
          payload: { result: "passed" },
          payloadHash:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          evidence: [],
          observedAt: "2026-05-24T12:00:00.000Z",
        },
      },
    ]);

    expect(toolCommand.kind).toBe("tool_command_request");
    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "direct_effect_receipt_forbidden",
    );
  });

  it("langgraph-state-as-truth-blocked", () => {
    const report = langGraphAdapter.evaluateConformance([
      langGraphAdapter.stateMetadataEmission({
        emissionId: "langgraph_state_truth_bypass",
        state: { checkpointId: checkpoint.checkpointId, messages: 8 },
        checkpoint,
        usedAsEvidence: true,
      }),
    ]);

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "substrate_state_as_truth_forbidden",
    );
  });

  it("langgraph-final-text-bypass-blocked", () => {
    const report = langGraphAdapter.evaluateConformance([
      langGraphAdapter.rawFinalTextEmission({
        kind: "raw_text",
        emissionId: "langgraph_raw_text_bypass",
        text: "The LangGraph run succeeded, release it.",
        checkpoint,
      }),
    ]);

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "raw_final_text_forbidden",
    );
  });

  it("langgraph-checkpoint-not-proof", () => {
    const report = langGraphAdapter.evaluateConformance([
      langGraphAdapter.stateMetadataEmission({
        emissionId: "langgraph_checkpoint_metadata",
        state: { checkpointId: checkpoint.checkpointId },
        checkpoint,
      }),
    ]);

    expect(report.status).toBe("pass");
    expect(report.toolCommandCount).toBe(0);
    expect(report.finalCandidateCount).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("temporal-history-as-proof-blocked", () => {
    const history = {
      workflowId: "workflow_history_attack",
      workflowRunId: "temporal_run_history_attack",
      events: [
        {
          eventId: "1",
          eventType: "ActivityTaskCompleted",
          attributes: {
            activityId: "activity_write",
          },
        },
      ],
    };
    const historyPayload = temporalHistoryPayload(history);
    const report = createTemporalConformanceReport({
      adapterId: "adapter.temporal.mission",
      runId: "mission_temporal_history",
      emissions: [
        {
          kind: "substrate_state",
          emissionId: "temporal_history_truth_attempt",
          adapterId: "adapter.temporal.mission",
          substrate: "temporal",
          runId: "mission_temporal_history",
          state: {
            temporalHistory: historyPayload,
          },
          usedAsEvidence: true,
        },
      ],
    });

    expect(assessTemporalHistoryAuthority(history)).toMatchObject({
      status: "temporal_history_only",
      canBeEvidenceRefDirectly: false,
      canBeProofDirectly: false,
      canSupportClaimDirectly: false,
      eligibleForKernelProof: false,
    });
    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "substrate_state_as_truth_forbidden",
    );
  });

  it("temporal-activity-without-receipt-blocked", () => {
    const runId = "mission_temporal_activity_without_receipt";
    const envelope = buildTemporalActivityEnvelope({
      boundary: temporalBoundary(runId),
      effectRequest: temporalEffectRequest(runId),
      activityId: "activity_run_tests",
    });
    const correlation = correlateTemporalActivityReceipt({
      envelope,
      activityResult: {
        status: "completed",
        completedAt: FRESH_OBSERVED_AT,
        attempt: 1,
        result: {
          result: "passed",
        },
      },
    });
    const kernel = startedKernel(runId);
    kernel.recordEffectRequest(temporalEffectRequest(runId));

    const result = kernel.submitFinalCandidate(
      candidateWith(
        runId,
        testResultClaim({
          evidenceRefs: [
            temporalActivityEvidenceRef(correlation.activityResultHash),
          ],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(correlation.authority).toBe("activity_result_only");
    expect(correlation.assessment).toMatchObject({
      canSupportClaimDirectly: false,
      eligibleForKernelProof: false,
    });
    expect(result.decision.status).toBe("blocked");
    expect(result.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        blocking: true,
      }),
    );
  });

  it("temporal-retry-idempotency-preserved", () => {
    const runId = "mission_temporal_retry";
    const firstAttempt = buildTemporalActivityEnvelope({
      boundary: temporalBoundary(runId),
      effectRequest: temporalEffectRequest(runId),
      activityId: "activity_run_tests",
    });
    const retry = buildTemporalActivityRetryEnvelope({
      previousEnvelope: firstAttempt,
      attempt: 2,
      scheduledAt: "2026-05-24T12:00:05.000Z",
    });

    expect(retry.idempotencyKey).toBe(firstAttempt.idempotencyKey);
    expect(retry.effectId).toBe(firstAttempt.effectId);
    expect(retry.runId).toBe(firstAttempt.runId);
    expect(temporalRetryPreservesIdempotency(firstAttempt, retry)).toBe(true);
  });
});

interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
}

function workspaceDependencies(packageJson: PackageJson): string[] {
  return Object.entries(packageJson.dependencies ?? {})
    .filter(
      ([dependencyName, version]) =>
        dependencyName.startsWith("@amca/") && version === "workspace:*",
    )
    .map(([dependencyName]) => dependencyName)
    .sort();
}

function dependencyNames(packageJson: PackageJson): string[] {
  return Object.keys(packageJson.dependencies ?? {}).sort();
}

function emptyCertificationEvidence(): CertificationManifest["evidence"] {
  return {
    phaseReports: [],
    missionTests: [],
    focusedCommands: [],
  };
}

function certificationIssueCodes(
  result: ReturnType<typeof validateCertificationManifest>,
): readonly string[] {
  return result.success ? [] : result.issues.map((issue) => issue.code);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry);
      const entryStat = statSync(entryPath);

      if (entryStat.isDirectory()) {
        return sourceFiles(entryPath);
      }

      return entryStat.isFile() ? [entryPath] : [];
    })
    .sort();
}

function temporalBoundary(runId: string) {
  return {
    adapterId: "adapter.temporal.mission",
    substrate: "temporal" as const,
    runId,
    workflowId: `workflow_${runId}`,
  };
}

function temporalEffectRequest(runId: string): EffectRequest {
  return {
    effectId: "effect_test_001",
    commandId: "command_test_001",
    runId,
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    requestedAt: FRESH_OBSERVED_AT,
    idempotencyKey: `${runId}:temporal:test`,
  };
}

function temporalActivityEvidenceRef(hash: EvidenceRef["hash"]): EvidenceRef {
  return {
    evidenceId: "ev_temporal_activity_result",
    kind: "effect_receipt",
    sourceEventId: "temporal_activity_completed",
    hash,
    observedAt: FRESH_OBSERVED_AT,
    sensitivity: "internal",
    metadata: {
      source: "temporal_activity_result",
    } satisfies JsonObject,
  };
}
