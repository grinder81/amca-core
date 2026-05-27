import { readFileSync } from "node:fs";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { validateCertificationManifest } from "@amca/adapters-conformance";
import type { FinalCandidate, JsonObject } from "@amca/protocol";

import {
  LANGGRAPH_ADAPTER_CERTIFICATION,
  LangGraphBoundaryAdapter,
  LangGraphBoundaryError,
  type LangGraphProposalBridgeState,
  createLangGraphCheckpointMetadata,
  invokeLangGraphProposalBridge,
  invokeLangGraphRuntimeBridge,
  translateLangGraphFinalOutputToFinalCandidate,
  translateLangGraphToolCallToToolCommandRequest,
} from "./index.js";
import * as langGraphExports from "./index.js";

const runId = "run_langgraph_adapter";
const adapter = new LangGraphBoundaryAdapter({
  adapterId: "adapter_langgraph_test",
  runId,
});

const checkpoint = {
  checkpointId: "checkpoint_001",
  threadId: "thread_001",
  graphId: "graph_001",
  nodeId: "agent_node",
};

describe("LangGraph boundary adapter", () => {
  it("converts LangGraph tool calls to ToolCommandRequest proposals", () => {
    const command = translateLangGraphToolCallToToolCommandRequest({
      toolCallId: "tool_call_001",
      runId,
      capabilityId: "shell.run_tests",
      toolId: "pnpm.test",
      args: { command: "pnpm test" },
      sideEffectClass: "compute",
      checkpoint,
    });

    expect(command).toEqual({
      kind: "tool_command_request",
      commandId: "langgraph_command:tool_call_001",
      runId,
      capabilityId: "shell.run_tests",
      toolId: "pnpm.test",
      args: { command: "pnpm test" },
      sideEffectClass: "compute",
    });
    expect("checkpointId" in command).toBe(false);
  });

  it("converts structured LangGraph final output to FinalCandidate", () => {
    const candidate = translateLangGraphFinalOutputToFinalCandidate({
      kind: "structured_final_candidate",
      finalCandidate: finalCandidate(),
      checkpoint,
    });

    expect(candidate.kind).toBe("final_candidate");
    expect(candidate.runId).toBe(runId);
    expect(candidate.claims).toHaveLength(1);
    expect(candidate.claims[0]?.predicate.kind).toBe("test_result");
  });

  it("blocks raw final prose through conformance and conversion", () => {
    const report = adapter.evaluateConformance([
      adapter.rawFinalTextEmission({
        kind: "raw_text",
        emissionId: "emission_raw_final",
        text: "The graph is done, release this answer.",
        checkpoint,
      }),
    ]);

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "raw_final_text_forbidden",
    );
    expect(() =>
      translateLangGraphFinalOutputToFinalCandidate({
        kind: "raw_text",
        text: "release me",
        checkpoint,
      }),
    ).toThrow(LangGraphBoundaryError);
  });

  it("keeps checkpoint IDs as metadata only", () => {
    const emission = adapter.toolCallEmission({
      toolCallId: "tool_call_checkpoint",
      capabilityId: "shell.run_tests",
      toolId: "pnpm.test",
      args: { command: "pnpm test" },
      sideEffectClass: "compute",
      checkpoint,
    });
    const metadata = createLangGraphCheckpointMetadata({ runId, checkpoint });

    expect(emission.metadata).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      metadataOnly: true,
      proofRole: "none",
    });
    expect(emission.toolCommand).not.toHaveProperty("checkpointId");
    expect(metadata).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      checkpointRole: "correlation_only",
      truthAuthority: "amca_semantic_events",
    });
  });

  it("blocks LangGraph state when used as evidence or truth", () => {
    const report = adapter.evaluateConformance([
      adapter.stateMetadataEmission({
        emissionId: "emission_state_truth",
        state: { checkpointId: checkpoint.checkpointId, messages: 4 },
        checkpoint,
        usedAsEvidence: true,
      }),
    ]);

    expect(report.status).toBe("fail");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "substrate_state_as_truth_forbidden",
    );
  });

  it("reports conformance for structured LangGraph boundary emissions", () => {
    const report = adapter.evaluateConformance([
      adapter.toolCallEmission({
        toolCallId: "tool_call_conformant",
        capabilityId: "shell.run_tests",
        toolId: "pnpm.test",
        args: { command: "pnpm test" },
        sideEffectClass: "compute",
        checkpoint,
      }),
      adapter.finalOutputEmission({
        kind: "structured_final_candidate",
        finalCandidate: finalCandidate(),
        checkpoint,
      }),
      adapter.stateMetadataEmission({
        state: { checkpointId: checkpoint.checkpointId },
        checkpoint,
      }),
    ]);

    expect(report).toMatchObject({
      status: "pass",
      toolCommandCount: 1,
      finalCandidateCount: 1,
      issues: [],
    });
  });

  it("langgraph-node-output-becomes-tool-command-request", async () => {
    const graph = deterministicProposalGraph({
      toolCalls: [
        {
          toolCallId: "tool_call_real_graph",
          emissionId: "emission_real_graph_tool",
          capabilityId: "shell.run_tests",
          toolId: "pnpm.test",
          args: { command: "pnpm test" },
          sideEffectClass: "compute",
          checkpoint,
        },
      ],
    });

    const result = await invokeLangGraphProposalBridge({
      graph,
      adapter,
      input: {},
    });

    expect(result.conformanceReport.status).toBe("pass");
    expect(result.toolCommands).toEqual([
      expect.objectContaining({
        kind: "tool_command_request",
        commandId: "langgraph_command:tool_call_real_graph",
        runId,
        capabilityId: "shell.run_tests",
      }),
    ]);
    expect(result.emissions[0]).toMatchObject({
      kind: "tool_call",
      substrate: "langgraph",
      metadata: {
        checkpointRole: "correlation_only",
        proofRole: "none",
      },
    });
  });

  it("langgraph-runtime-bridge-tool-call-interception", async () => {
    const graph = deterministicProposalGraph({
      toolCalls: [
        {
          toolCallId: "tool_call_runtime_bridge",
          capabilityId: "github.observe_rest_resource",
          toolId: "github.rest.get",
          args: { path: "/repos/acme/widgets", method: "GET" },
          sideEffectClass: "read",
          checkpoint,
        },
      ],
      finalOutput: {
        kind: "structured_final_candidate",
        finalCandidate: finalCandidate(),
        checkpoint,
      },
    });

    const result = await invokeLangGraphRuntimeBridge({
      graph,
      adapter,
      input: {},
    });

    expect(result).toMatchObject({
      bridgeKind: "langgraph_runtime_bridge",
      runtimeExecution: "deterministic_graph_invoke_only",
      externalToolExecution: false,
      proofAuthority: false,
      releaseAuthority: false,
      conformanceReport: {
        status: "pass",
      },
    });
    expect(result.toolCommands).toEqual([
      expect.objectContaining({
        kind: "tool_command_request",
        capabilityId: "github.observe_rest_resource",
        sideEffectClass: "read",
      }),
    ]);
    expect(result.finalCandidates).toHaveLength(1);
  });

  it("langgraph-final-output-becomes-structured-final-candidate", async () => {
    const graph = deterministicProposalGraph({
      finalOutput: {
        kind: "structured_final_candidate",
        emissionId: "emission_real_graph_final",
        finalCandidate: finalCandidate(),
        checkpoint,
      },
    });

    const result = await invokeLangGraphProposalBridge({
      graph,
      adapter,
      input: {},
    });

    expect(result.conformanceReport.status).toBe("pass");
    expect(result.finalCandidates).toEqual([
      expect.objectContaining({
        kind: "final_candidate",
        candidateId: "candidate_langgraph_001",
        runId,
      }),
    ]);
    expect(result.finalCandidates[0]?.claims[0]?.predicate.kind).toBe(
      "test_result",
    );
  });

  it("langgraph-checkpoint-as-proof-blocked", async () => {
    const graph = deterministicProposalGraph({
      substrateStates: [
        {
          emissionId: "emission_real_graph_checkpoint_truth",
          state: { checkpointId: checkpoint.checkpointId },
          checkpoint,
          usedAsEvidence: true,
        },
      ],
    });

    const result = await invokeLangGraphProposalBridge({
      graph,
      adapter,
      input: {},
    });

    expect(result.conformanceReport.status).toBe("fail");
    expect(
      result.conformanceReport.issues.map((issue) => issue.code),
    ).toContain("substrate_state_as_truth_forbidden");
  });

  it("does not import forbidden authority packages or substrate runtimes", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageJson;
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const dependencies = Object.keys(packageJson.dependencies ?? {});
    const forbiddenSpecifiers = [
      "@amca/proof",
      "@amca/kernel",
      "@amca/ledger-local",
      "@amca/cli",
      "@amca/services",
      "@amca/adapters-temporal",
      "@temporalio/client",
      "@temporalio/worker",
      "@temporalio/workflow",
      "pg",
      "postgres",
    ];

    for (const forbidden of forbiddenSpecifiers) {
      expect(dependencies, `package dependency ${forbidden}`).not.toContain(
        forbidden,
      );
      expect(source, `source import ${forbidden}`).not.toContain(
        `from "${forbidden}"`,
      );
      expect(source, `source import ${forbidden}`).not.toContain(
        `from '${forbidden}'`,
      );
    }
  });

  it("langgraph-runtime-bridge-has-no-tool-proof-or-release-authority", () => {
    expect(
      validateCertificationManifest(LANGGRAPH_ADAPTER_CERTIFICATION).success,
    ).toBe(true);
    expect(LANGGRAPH_ADAPTER_CERTIFICATION).toMatchObject({
      currentLevel: "level_2_tool_intercepting",
      targetLevel: "level_3_replay_certified",
    });
    expect(LANGGRAPH_ADAPTER_CERTIFICATION.forbiddenAuthority).toContain(
      "external tool execution",
    );
    expect(langGraphExports).toHaveProperty("invokeLangGraphRuntimeBridge");
    expect(langGraphExports).not.toHaveProperty("executeLangGraphTools");
    expect(langGraphExports).not.toHaveProperty("admitLangGraphReceipt");
    expect(langGraphExports).not.toHaveProperty("releaseLangGraphDecision");
    expect(langGraphExports).not.toHaveProperty("generateLangGraphProof");
  });
});

function finalCandidate(): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: "candidate_langgraph_001",
    runId,
    claims: [
      {
        claimId: "claim_tests_passed",
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

interface PackageJson {
  readonly dependencies?: Record<string, string>;
}

function deterministicProposalGraph(output: LangGraphProposalBridgeState) {
  const State = Annotation.Root({
    toolCalls: Annotation<LangGraphProposalBridgeState["toolCalls"]>({
      value: (_left, right) => right,
      default: () => [],
    }),
    finalOutput: Annotation<LangGraphProposalBridgeState["finalOutput"]>({
      value: (_left, right) => right,
      default: () => undefined,
    }),
    substrateStates: Annotation<
      LangGraphProposalBridgeState["substrateStates"]
    >({
      value: (_left, right) => right,
      default: () => [],
    }),
  });

  return new StateGraph(State)
    .addNode("emit_amca_boundary_output", (): LangGraphProposalBridgeState => {
      return {
        toolCalls: output.toolCalls ?? [],
        ...(output.finalOutput === undefined
          ? {}
          : { finalOutput: output.finalOutput }),
        substrateStates: output.substrateStates ?? [],
      };
    })
    .addEdge(START, "emit_amca_boundary_output")
    .addEdge("emit_amca_boundary_output", END)
    .compile() as {
    invoke(input: JsonObject): Promise<LangGraphProposalBridgeState>;
  };
}
