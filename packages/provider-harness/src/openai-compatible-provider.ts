import type { JsonObject, JsonValue } from "@amca/protocol";

import { chatCompletionsUrl } from "./config.js";
import { redactProviderText, redactedHeaders } from "./redaction.js";
import type {
  LocalProviderConfig,
  ProviderChatCompletion,
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderNonProofMetadata,
  ProviderRequestPreview,
  ProviderToolBinding,
  ProviderToolCallCandidate,
} from "./types.js";
import { ProviderHarnessError } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface OpenAIChatCompletionResponse {
  readonly id?: string | undefined;
  readonly model?: string | undefined;
  readonly choices?: readonly OpenAIChoice[] | undefined;
  readonly usage?: unknown;
}

interface OpenAIChoice {
  readonly finish_reason?: string | null | undefined;
  readonly message?: OpenAIMessage | undefined;
  readonly delta?: OpenAIStreamDelta | undefined;
}

interface OpenAIMessage {
  readonly content?: string | null | undefined;
  readonly tool_calls?: readonly OpenAIToolCall[] | undefined;
}

interface OpenAIStreamChunk {
  readonly id?: string | undefined;
  readonly model?: string | undefined;
  readonly choices?: readonly OpenAIChoice[] | undefined;
  readonly usage?: unknown;
}

interface OpenAIStreamDelta {
  readonly content?: string | null | undefined;
  readonly tool_calls?: readonly OpenAIStreamToolCallDelta[] | undefined;
}

interface OpenAIStreamToolCallDelta {
  readonly index?: number | undefined;
  readonly id?: string | undefined;
  readonly function?:
    | {
        readonly name?: string | undefined;
        readonly arguments?: string | undefined;
      }
    | undefined;
}

interface OpenAIToolCall {
  readonly id?: string | undefined;
  readonly function?:
    | {
        readonly name?: string | undefined;
        readonly arguments?: string | undefined;
      }
    | undefined;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

export class OpenAICompatibleLocalProvider {
  readonly config: LocalProviderConfig;
  readonly fetch: FetchLike;

  constructor(options: {
    readonly config: LocalProviderConfig;
    readonly fetch?: FetchLike | undefined;
  }) {
    this.config = options.config;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  requestPreview(request: ProviderChatRequest): ProviderRequestPreview {
    return createProviderRequestPreview(this.config, request);
  }

  async complete(
    request: ProviderChatRequest,
  ): Promise<ProviderChatCompletion> {
    if (request.tools?.length && !this.config.capabilities.toolCalls) {
      throw new ProviderHarnessError(
        "provider_tool_calls_unsupported",
        "Provider profile does not support tool calls.",
      );
    }

    const preview = createProviderRequestPreview(this.config, request);
    const response = await fetchWithTimeout(
      this.fetch,
      preview.url,
      {
        body: JSON.stringify(preview.body),
        headers: actualHeaders(this.config),
        method: preview.method,
      },
      this.config.request.timeoutMs,
    );

    if (!response.ok) {
      throw new ProviderHarnessError(
        "provider_fetch_failed",
        `Provider chat completion failed with ${response.status.toString()}: ${redactProviderText(
          await readErrorBody(response),
        )}`,
      );
    }

    if (this.config.request.stream) {
      if (!response.body) {
        throw new ProviderHarnessError(
          "provider_fetch_failed",
          "Provider streaming response did not include a body.",
        );
      }
      return collectStreamingCompletion(
        response.body,
        request.model ?? this.config.model,
      );
    }

    const body = (await response.json()) as OpenAIChatCompletionResponse;
    return completionFromOpenAIResponse(
      body,
      request.model ?? this.config.model,
    );
  }
}

export function createProviderRequestPreview(
  config: LocalProviderConfig,
  request: ProviderChatRequest,
): ProviderRequestPreview {
  const extraBody = { ...config.request.extraBody };
  if (!config.capabilities.supportsReasoningEffort) {
    delete extraBody.reasoning_effort;
  }

  const body: JsonObject = {
    ...extraBody,
    model: request.model ?? config.model,
    messages: toOpenAIChatMessages(request.messages, {
      systemMessages: config.capabilities.systemMessages,
    }),
    stream: config.request.stream,
    ...(request.tools?.length
      ? {
          tools: request.tools.map(toOpenAITool),
          ...(config.capabilities.parallelToolCalls
            ? {}
            : { parallel_tool_calls: false }),
        }
      : {}),
  };

  return {
    url: chatCompletionsUrl(config.baseUrl),
    method: "POST",
    headers: redactedHeaders(actualHeaders(config)),
    body,
  };
}

export function toOpenAIChatMessages(
  messages: readonly ProviderChatMessage[],
  options: { readonly systemMessages?: boolean | undefined } = {},
): JsonValue[] {
  const supportsSystemMessages = options.systemMessages ?? true;
  return messages.map((message) => {
    if (message.role === "system" && !supportsSystemMessages) {
      return {
        role: "user",
        content: `<system>\n${message.content ?? ""}\n</system>`,
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content ?? "",
        ...(message.toolCallId === undefined
          ? {}
          : { tool_call_id: message.toolCallId }),
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        })),
      };
    }
    return {
      role: message.role,
      content: message.content ?? "",
    };
  });
}

export function toOpenAITool(tool: ProviderToolBinding): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputJSONSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    },
  };
}

export function parseToolArguments(text: string): JsonObject {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isJsonObject(parsed)) return parsed;
    if (isJsonValue(parsed)) return { value: parsed };
    return { _raw: text };
  } catch {
    return { _raw: text };
  }
}

function completionFromOpenAIResponse(
  body: OpenAIChatCompletionResponse,
  fallbackModel: string,
): ProviderChatCompletion {
  const choice = body.choices?.[0];
  const message = choice?.message;
  const toolCalls = normalizeToolCalls(message?.tool_calls ?? []);
  return {
    content: message?.content ?? "",
    toolCalls,
    metadata: metadataForCompletion({
      provider: "openai-compatible",
      model: body.model ?? fallbackModel,
      responseId: body.id,
      finishReason: choice?.finish_reason ?? undefined,
      usage: body.usage,
      toolCallIds: toolCalls.map((toolCall) => toolCall.id),
    }),
  };
}

async function collectStreamingCompletion(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): Promise<ProviderChatCompletion> {
  const contentParts: string[] = [];
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let responseId: string | undefined;
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: JsonValue | undefined;

  for await (const chunk of parseOpenAIEventStream(body)) {
    responseId = chunk.id ?? responseId;
    model = chunk.model ?? model;
    usage = toJsonValue(chunk.usage) ?? usage;
    for (const choice of chunk.choices ?? []) {
      finishReason = choice.finish_reason ?? finishReason;
      const content = choice.delta?.content;
      if (content) {
        contentParts.push(content);
      }
      for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
        const index = toolCallDelta.index ?? 0;
        const current = toolCalls.get(index) ?? {
          id: toolCallDelta.id ?? `call_${index.toString()}`,
          name: "",
          argumentsText: "",
        };
        current.id = toolCallDelta.id ?? current.id;
        current.name = toolCallDelta.function?.name ?? current.name;
        current.argumentsText += toolCallDelta.function?.arguments ?? "";
        toolCalls.set(index, current);
      }
    }
  }

  const normalizedToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => ({
      id: value.id,
      name: value.name,
      arguments: parseToolArguments(value.argumentsText),
    }))
    .filter((toolCall) => toolCall.name.length > 0);

  return {
    content: contentParts.join(""),
    toolCalls: normalizedToolCalls,
    metadata: metadataForCompletion({
      provider: "openai-compatible",
      model: model ?? fallbackModel,
      responseId,
      finishReason,
      usage,
      toolCallIds: normalizedToolCalls.map((toolCall) => toolCall.id),
    }),
  };
}

function normalizeToolCalls(
  toolCalls: readonly OpenAIToolCall[],
): ProviderToolCallCandidate[] {
  return toolCalls
    .map((toolCall, index) => ({
      id: toolCall.id ?? `call_${index.toString()}`,
      name: toolCall.function?.name ?? "",
      arguments: parseToolArguments(toolCall.function?.arguments ?? ""),
    }))
    .filter((toolCall) => toolCall.name.length > 0);
}

function metadataForCompletion(input: {
  readonly provider: "openai-compatible";
  readonly model: string;
  readonly responseId?: string | undefined;
  readonly finishReason?: string | undefined;
  readonly usage?: unknown;
  readonly toolCallIds: readonly string[];
}): ProviderNonProofMetadata {
  return {
    provider: input.provider,
    model: input.model,
    ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
    ...(input.finishReason === undefined
      ? {}
      : { finishReason: input.finishReason }),
    ...(toJsonValue(input.usage) === undefined
      ? {}
      : { usage: toJsonValue(input.usage) }),
    toolCallIds: input.toolCallIds,
    proofUsable: false,
  };
}

async function* parseOpenAIEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAIStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.match(/\r?\n\r?\n/u)?.[0] ?? "\n\n";
        buffer = buffer.slice(boundary + separator.length);
        const parsed = parseSSEFrame(frame);
        if (parsed) yield parsed;
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
    }
    buffer += decoder.decode();
    const parsed = parseSSEFrame(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function parseSSEFrame(frame: string): OpenAIStreamChunk | undefined {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") return undefined;
  return JSON.parse(data) as OpenAIStreamChunk;
}

function actualHeaders(config: LocalProviderConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(config.apiKey === undefined
      ? {}
      : { authorization: `Bearer ${config.apiKey}` }),
  };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return response.statusText;
  }
}

async function fetchWithTimeout(
  fetch: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(`Provider request timed out after ${timeoutMs.toString()}ms`),
    );
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderHarnessError(
        "provider_fetch_failed",
        `Provider request failed closed: ${redactProviderText(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined;
}
