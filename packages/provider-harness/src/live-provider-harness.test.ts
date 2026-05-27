import { describe, expect, it } from "vitest";

import {
  createOpenCodeCompatibleLocalProviderConfig,
  OpenAICompatibleLocalProvider,
  normalizeProviderCompletion,
  type ProviderToolBinding,
} from "./index.js";

const liveDescribe =
  process.env.AMCA_PROVIDER_LIVE === "1" ? describe : describe.skip;

liveDescribe("Phase 62 live local provider certification", () => {
  it("converts a real local provider response into an AMCA proposal candidate", async () => {
    const baseUrl = requireEnv("AMCA_PROVIDER_BASE_URL");
    const model = requireEnv("AMCA_PROVIDER_MODEL");
    const runId = `run_provider_live_${Date.now().toString()}`;
    const readTool: ProviderToolBinding = {
      name: "Read",
      capabilityId: "local_readonly.file_read",
      toolId: "local.read_file",
      sideEffectClass: "read",
      inputJSONSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    };
    const provider = new OpenAICompatibleLocalProvider({
      config: createOpenCodeCompatibleLocalProviderConfig({
        baseUrl,
        model,
        apiKeyEnv: "AMCA_PROVIDER_API_KEY",
        request: {
          stream: process.env.AMCA_PROVIDER_STREAM !== "0",
        },
      }),
    });

    const completion = await provider.complete({
      runId,
      messages: [
        {
          role: "system",
          content:
            "Return only JSON matching the AMCA ToolCommandRequest contract. Do not include markdown, commentary, proof, release, receipt, or tool-result fields. Do not execute the tool.",
        },
        {
          role: "user",
          content: [
            "Return exactly one JSON object with these fields:",
            "{",
            '  "kind": "tool_command_request",',
            '  "commandId": "command_live_readme",',
            `  "runId": "${runId}",`,
            '  "capabilityId": "local_readonly.file_read",',
            '  "toolId": "local.read_file",',
            '  "args": { "path": "README.md" },',
            '  "sideEffectClass": "read"',
            "}",
          ].join("\n"),
        },
      ],
      tools: [readTool],
    });
    const result = normalizeProviderCompletion({
      runId,
      completion,
      tools: [readTool],
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
      throw new Error("expected live provider result to be accepted");
    }
    expect(result.metadata.proofUsable).toBe(false);
    expect(result.conformanceReport.status).toBe("pass");
  }, 300_000);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for AMCA_PROVIDER_LIVE=1`);
  }
  return value;
}
