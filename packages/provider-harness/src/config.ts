import type { JsonObject } from "@amca/protocol";

import type {
  LocalProviderCapabilities,
  LocalProviderConfig,
  LocalProviderDiscoveryConfig,
  LocalProviderRequestConfig,
} from "./types.js";
import { ProviderHarnessError } from "./types.js";

export const DEFAULT_LOCAL_PROVIDER_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_LOCAL_PROVIDER_MODEL = "code";
export const DEFAULT_LOCAL_PROVIDER_API_KEY = "local-dev-placeholder";
export const DEFAULT_LOCAL_PROVIDER_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_LOCAL_PROVIDER_DISCOVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCAL_PROVIDER_REASONING_EFFORT = "none";
export const DEFAULT_LOCAL_PROVIDER_MODEL_PREFERENCES = [
  "code",
  "fast",
  "gemma",
  "llama",
] as const;

export interface CreateLocalProviderConfigOptions {
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly apiKeyEnv?: string | undefined;
  readonly discovery?: Partial<LocalProviderDiscoveryConfig> | undefined;
  readonly request?: Partial<LocalProviderRequestConfig> | undefined;
  readonly capabilities?: Partial<LocalProviderCapabilities> | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export function createOpenCodeCompatibleLocalProviderConfig(
  options: CreateLocalProviderConfigOptions = {},
): LocalProviderConfig {
  const env = options.env ?? process.env;
  const apiKey =
    options.apiKey ??
    valueFromEnv(env, options.apiKeyEnv) ??
    env.AMCA_PROVIDER_API_KEY ??
    DEFAULT_LOCAL_PROVIDER_API_KEY;
  const extraBody = jsonObject({
    reasoning_effort: DEFAULT_LOCAL_PROVIDER_REASONING_EFFORT,
    ...(options.request?.extraBody ?? {}),
  });

  return validateLocalProviderConfig({
    provider: "openai-compatible",
    baseUrl: normalizeBaseUrl(
      options.baseUrl ??
        env.AMCA_PROVIDER_BASE_URL ??
        DEFAULT_LOCAL_PROVIDER_BASE_URL,
    ),
    model:
      options.model ?? env.AMCA_PROVIDER_MODEL ?? DEFAULT_LOCAL_PROVIDER_MODEL,
    apiKey,
    ...(options.apiKeyEnv === undefined
      ? {}
      : { apiKeyEnv: options.apiKeyEnv }),
    discovery: {
      enabled: options.discovery?.enabled ?? true,
      prefer: options.discovery?.prefer ?? [
        ...DEFAULT_LOCAL_PROVIDER_MODEL_PREFERENCES,
      ],
      timeoutMs:
        options.discovery?.timeoutMs ??
        DEFAULT_LOCAL_PROVIDER_DISCOVERY_TIMEOUT_MS,
    },
    request: {
      timeoutMs:
        options.request?.timeoutMs ?? DEFAULT_LOCAL_PROVIDER_REQUEST_TIMEOUT_MS,
      stream: options.request?.stream ?? true,
      extraBody,
    },
    capabilities: {
      toolCalls: options.capabilities?.toolCalls ?? true,
      parallelToolCalls: options.capabilities?.parallelToolCalls ?? false,
      systemMessages: options.capabilities?.systemMessages ?? true,
      supportsReasoningEffort:
        options.capabilities?.supportsReasoningEffort ?? true,
      ...(options.capabilities?.maxContextTokens === undefined
        ? {}
        : { maxContextTokens: options.capabilities.maxContextTokens }),
      ...(options.capabilities?.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.capabilities.maxOutputTokens }),
    },
  });
}

export function validateLocalProviderConfig(
  config: LocalProviderConfig,
): LocalProviderConfig {
  if (config.model.length === 0) {
    throw new ProviderHarnessError(
      "provider_config_invalid",
      "Provider model must be non-empty.",
    );
  }
  if (
    config.request.timeoutMs <= 0 ||
    !Number.isInteger(config.request.timeoutMs)
  ) {
    throw new ProviderHarnessError(
      "provider_config_invalid",
      "Provider request timeout must be a positive integer.",
    );
  }
  normalizeBaseUrl(config.baseUrl);
  return config;
}

export function normalizeBaseUrl(rawBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new ProviderHarnessError(
      "provider_config_invalid",
      "Provider baseUrl must be a valid URL.",
    );
  }

  if (url.username || url.password) {
    throw new ProviderHarnessError(
      "provider_config_invalid",
      "Provider baseUrl must not contain credentials.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderHarnessError(
      "provider_config_invalid",
      "Provider baseUrl must use http or https.",
    );
  }

  url.hash = "";
  url.search = "";
  const normalized = url.toString().replace(/\/+$/u, "");
  return normalized;
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function valueFromEnv(
  env: NodeJS.ProcessEnv,
  name: string | undefined,
): string | undefined {
  if (name === undefined) return undefined;
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  const json: Record<string, JsonObject[keyof JsonObject]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonValue(entry)) {
      json[key] = entry;
    }
  }
  return json;
}

function isJsonValue(value: unknown): value is JsonObject[keyof JsonObject] {
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
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
