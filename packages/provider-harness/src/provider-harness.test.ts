import { describe, expect, it } from "vitest";

import { validateCertificationManifest } from "@amca/adapters-conformance";
import type { JsonObject, Sha256Hash } from "@amca/protocol";

import {
  createOpenCodeCompatibleLocalProviderConfig,
  DEFAULT_LOCAL_PROVIDER_BASE_URL,
  DEFAULT_LOCAL_PROVIDER_MODEL,
} from "./config.js";
import {
  OpenAICompatibleLocalProvider,
  type FetchLike,
} from "./openai-compatible-provider.js";
import { normalizeProviderCompletion } from "./proposal-normalizer.js";
import { redactProviderText, redactProviderValue } from "./redaction.js";
import {
  PROVIDER_HARNESS_CERTIFICATION,
  PROVIDER_HARNESS_MATURITY,
} from "./certification.js";
import type { ProviderChatCompletion, ProviderToolBinding } from "./types.js";

const runId = "run_provider_harness_unit";
const emptyHash =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" satisfies Sha256Hash;

const readTool: ProviderToolBinding = {
  name: "Read",
  capabilityId: "local_readonly.file_read",
  toolId: "local.read_file",
  sideEffectClass: "read",
  inputJSONSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

describe("@amca/provider-harness local OpenAI-compatible provider", () => {
  it("builds OpenCode-compatible local provider defaults without calling the model", () => {
    const config = createOpenCodeCompatibleLocalProviderConfig({
      env: {},
    });
    const provider = new OpenAICompatibleLocalProvider({
      config,
      fetch: forbiddenFetch,
    });
    const preview = provider.requestPreview({
      runId,
      messages: [{ role: "user", content: "Return an AMCA proposal." }],
      tools: [readTool],
    });

    expect(config.baseUrl).toBe(DEFAULT_LOCAL_PROVIDER_BASE_URL.toLowerCase());
    expect(config.model).toBe(DEFAULT_LOCAL_PROVIDER_MODEL);
    expect(preview.url).toBe(
      `${DEFAULT_LOCAL_PROVIDER_BASE_URL.toLowerCase()}/chat/completions`,
    );
    expect(preview.headers.authorization).toBe("[REDACTED]");
    expect(preview.body.reasoning_effort).toBe("none");
    expect(preview.body.parallel_tool_calls).toBe(false);
    expect(preview.body.stream).toBe(true);
  });

  it("normalizes non-streaming structured final candidates into AMCA proposals", async () => {
    let requestBody: JsonObject | undefined;
    const fetch: FetchLike = (_input, init) => {
      if (typeof init.body !== "string") {
        throw new Error("expected JSON request body");
      }
      requestBody = JSON.parse(init.body) as JsonObject;
      return Promise.resolve(
        Response.json({
          id: "chatcmpl_unit",
          model: "code",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify(finalCandidate()),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
      );
    };
    const config = createOpenCodeCompatibleLocalProviderConfig({
      env: {},
      request: { stream: false },
    });
    const completion = await new OpenAICompatibleLocalProvider({
      config,
      fetch,
    }).complete({
      runId,
      messages: [{ role: "user", content: "Return a final candidate." }],
    });
    const result = normalizeProviderCompletion({ runId, completion });

    expect(requestBody?.stream).toBe(false);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
      throw new Error("expected provider result to be accepted");
    }
    expect(result.proposalCandidates).toHaveLength(1);
    expect(result.proposalCandidates[0]?.kind).toBe("final_candidate");
    expect(result.conformanceReport.status).toBe("pass");
    expect(result.metadata.proofUsable).toBe(false);
  });

  it("accumulates streamed tool calls and converts them to ToolCommandRequest proposals", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          streamText([
            {
              id: "chatcmpl_stream",
              model: "code",
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_read",
                        function: { name: "Read", arguments: '{"path":"' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: 'README.md"}' },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ]),
          { status: 200 },
        ),
      );
    const config = createOpenCodeCompatibleLocalProviderConfig({ env: {} });
    const completion = await new OpenAICompatibleLocalProvider({
      config,
      fetch,
    }).complete({
      runId,
      messages: [{ role: "user", content: "Read README." }],
      tools: [readTool],
    });
    const result = normalizeProviderCompletion({
      runId,
      completion,
      tools: [readTool],
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
      throw new Error("expected provider result to be accepted");
    }
    expect(result.toolCommandCandidates).toEqual([
      {
        kind: "tool_command_request",
        commandId: "command_call_read",
        runId,
        capabilityId: "local_readonly.file_read",
        toolId: "local.read_file",
        args: { path: "README.md" },
        sideEffectClass: "read",
      },
    ]);
    expect(result.conformanceReport.toolCommandCount).toBe(1);
  });

  it("fails closed for raw final text without structured claims", () => {
    const result = normalizeProviderCompletion({
      runId,
      completion: completionWithContent("Tests passed."),
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "provider_invalid_json",
          "raw_final_text_forbidden",
        ]),
      );
    }
  });

  it("fails closed when provider output tries to emit authority fields", () => {
    const result = normalizeProviderCompletion({
      runId,
      completion: completionWithContent(
        JSON.stringify({
          proposal: finalCandidate(),
          releaseDecision: { status: "released" },
        }),
      ),
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "provider_extra_authority_field",
      );
    }
  });

  it("fails closed for direct tool-result-shaped provider output", () => {
    const result = normalizeProviderCompletion({
      runId,
      completion: completionWithContent(
        JSON.stringify({
          kind: "tool_result",
          receiptId: "receipt_from_provider",
          status: "succeeded",
        }),
      ),
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "provider_direct_tool_result_forbidden",
      );
    }
  });

  for (const testCase of [
    {
      name: "provider-smuggles-proof-object-blocked",
      metadata: {
        proofObject: { proofId: "proof_provider_smuggled" },
      },
    },
    {
      name: "provider-smuggles-release-decision-blocked",
      metadata: {
        releaseDecision: { status: "released" },
      },
    },
    {
      name: "provider-smuggles-effect-receipt-blocked",
      metadata: {
        effectReceipt: { receiptId: "receipt_provider_smuggled" },
      },
    },
    {
      name: "provider-smuggles-external-observation-blocked",
      metadata: {
        externalObservation: { observationId: "obs_provider_smuggled" },
      },
    },
    {
      name: "provider-smuggles-tool-result-blocked",
      metadata: {
        toolResult: { status: "succeeded" },
      },
    },
    {
      name: "provider-smuggles-mutation-commit-blocked",
      metadata: {
        mutationCommit: { mutationId: "mutation_provider_smuggled" },
      },
    },
    {
      name: "provider-smuggles-human-approval-blocked",
      metadata: {
        humanApproval: { approvalId: "approval_provider_smuggled" },
      },
    },
    {
      name: "provider-smuggles-final-released-event-blocked",
      metadata: {
        finalReleasedEvent: { eventId: "evt_provider_final_released" },
      },
    },
  ]) {
    it(testCase.name, () => {
      const result = normalizeProviderCompletion({
        runId,
        completion: completionWithContent(
          JSON.stringify({
            proposal: finalCandidate(),
            metadata: testCase.metadata,
          }),
        ),
      });

      expectBlockedWithIssue(result, "provider_extra_authority_field");
      expect(result.proposalCandidates).toEqual([]);
      expect(result.toolCommandCandidates).toEqual([]);
    });
  }

  it("provider-final-candidate-uses-provider-response-id-as-evidence-blocked", () => {
    const responseId = "chatcmpl_phase63_provider_response";
    const result = normalizeProviderCompletion({
      runId,
      completion: completionWithContent(
        JSON.stringify(
          finalCandidate({
            evidenceRefs: [providerMetadataEvidenceRef(responseId)],
          }),
        ),
        {
          metadata: { responseId },
        },
      ),
    });

    expectBlockedWithIssue(result, "provider_metadata_evidence_ref_forbidden");
  });

  it("provider-final-candidate-uses-tool-call-id-as-evidence-blocked", () => {
    const toolCallId = "call_phase63_provider_tool";
    const result = normalizeProviderCompletion({
      runId,
      completion: completionWithContent(
        JSON.stringify(
          finalCandidate({
            evidenceRefs: [providerMetadataEvidenceRef(toolCallId)],
          }),
        ),
        {
          metadata: { toolCallIds: [toolCallId] },
          toolCalls: [
            {
              id: toolCallId,
              name: "Read",
              arguments: { path: "README.md" },
            },
          ],
        },
      ),
      tools: [readTool],
    });

    expectBlockedWithIssue(result, "provider_metadata_evidence_ref_forbidden");
    expect(result.toolCommandCandidates).toHaveLength(1);
    expect(result.emissions.map((emission) => emission.kind)).not.toContain(
      "effect_receipt",
    );
  });

  it("redacts provider secrets from errors and metadata-shaped values", () => {
    const providerKeyFixture = [
      "sk",
      "proj",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("-");
    const databaseUrlFixture = `${["post", "gres"].join("")}://user:pass@localhost/db`;
    expect(
      redactProviderText(
        `Authorization: Bearer ${providerKeyFixture} and ${["DATABASE", "URL"].join("_")}=${databaseUrlFixture}`,
      ),
    ).not.toContain(providerKeyFixture);
    expect(redactProviderText(databaseUrlFixture)).not.toContain("user:pass");
    expect(
      redactProviderValue({
        headers: [
          {
            authorization: `Bearer ${providerKeyFixture}`,
          },
        ],
        [["OPENAI", "API", "KEY"].join("_")]: providerKeyFixture,
      }),
    ).toEqual({
      headers: [{ authorization: "[REDACTED]" }],
      [["OPENAI", "API", "KEY"].join("_")]: "[REDACTED]",
    });
  });

  it("declares provider maturity without proof, receipt, release, or tool execution authority", () => {
    expect(
      validateCertificationManifest(PROVIDER_HARNESS_CERTIFICATION).success,
    ).toBe(true);
    expect(PROVIDER_HARNESS_CERTIFICATION.adapterKind).toBe("model_adapter");
    expect(PROVIDER_HARNESS_CERTIFICATION.forbiddenAuthority).toEqual(
      expect.arrayContaining([
        "external tool execution",
        "receipt admission",
        "release decision",
        "proof authority",
      ]),
    );
    expect(PROVIDER_HARNESS_MATURITY.liveProviderCertified).toBe(false);
    expect(PROVIDER_HARNESS_MATURITY.proofAuthority).toBe(false);
    expect(PROVIDER_HARNESS_MATURITY.releaseAuthority).toBe(false);
  });
});

function completionWithContent(
  content: string,
  options: {
    readonly metadata?: Partial<ProviderChatCompletion["metadata"]>;
    readonly toolCalls?: ProviderChatCompletion["toolCalls"];
  } = {},
): ProviderChatCompletion {
  const toolCalls = options.toolCalls ?? [];
  const toolCallIds =
    options.metadata?.toolCallIds ?? toolCalls.map((toolCall) => toolCall.id);

  return {
    content,
    toolCalls,
    metadata: {
      provider: "openai-compatible",
      model: "code",
      toolCallIds,
      proofUsable: false,
      ...options.metadata,
    },
  };
}

function finalCandidate(
  options: { readonly evidenceRefs?: readonly unknown[] } = {},
) {
  return {
    kind: "final_candidate",
    candidateId: "candidate_provider_unit",
    runId,
    claims: [
      {
        claimId: "claim_provider_unit",
        type: "test_result",
        statement: "Tests passed.",
        predicate: {
          kind: "test_result",
          capabilityId: "shell.run_tests",
          expectedStatus: "passed",
          requiredReceiptType: "test_run",
          testSuiteId: "unit",
        },
        evidenceRefs: [
          ...(options.evidenceRefs ?? [
            {
              admissionStatus: "admitted",
              evidenceId: "evidence_provider_unit",
              kind: "effect_receipt",
              sourceEventId: "evt_provider_unit_receipt",
              hash: emptyHash,
              observedAt: "2026-05-24T12:00:00.000Z",
              sensitivity: "internal",
            },
          ]),
        ],
        criticality: "medium",
      },
    ],
  };
}

function providerMetadataEvidenceRef(providerId: string) {
  return {
    admissionStatus: "admitted",
    evidenceId: providerId,
    kind: "effect_receipt",
    sourceEventId: providerId,
    hash: emptyHash,
    observedAt: "2026-05-24T12:00:00.000Z",
    sensitivity: "internal",
  };
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

function streamText(chunks: readonly JsonObject[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function forbiddenFetch(): Promise<Response> {
  return Promise.reject(
    new Error("unit test must not call the local provider"),
  );
}
