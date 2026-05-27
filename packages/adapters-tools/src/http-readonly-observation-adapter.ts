import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { canonicalObjectHash } from "@amca/contracts";
import type { EffectAdapter, ReceiptCandidate } from "@amca/effect-sdk";
import type {
  EvidenceSensitivity,
  ExternalStateObservationCandidate,
  ISODateTimeString,
  JsonObject,
  PendingEvidenceRef,
  Sha256Hash,
} from "@amca/protocol";

const defaultReceiptType = "http_readonly.fetch";
const defaultObservationType = "http_readonly.resource_snapshot";
const defaultFreshnessRequirementMs = 60_000;
const defaultMaxResponseBytes = 1024 * 1024;
const defaultMaxRedirects = 3;
const defaultTimeoutMs = 10_000;

const allowedSchemes = new Set(["http:", "https:"]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const rawBodyKeys = new Set([
  "body",
  "content",
  "data",
  "rawBody",
  "rawContent",
  "responseBody",
  "text",
]);

const normalizedRawBodyKeys = new Set([
  "body",
  "content",
  "data",
  "rawbody",
  "rawcontent",
  "responsebody",
  "text",
]);

const adapterArgKeys = new Set([
  "freshnessRequirementMs",
  "maxResponseBytes",
  "method",
  "requestHeaders",
  "sensitivity",
  "url",
]);

const inputKeys = new Set([
  "commandId",
  "freshnessRequirementMs",
  "maxResponseBytes",
  "method",
  "observedAt",
  "observationType",
  "requestHeaders",
  "responseMetadata",
  "runId",
  "sensitivity",
  "url",
]);

const responseMetadataKeys = new Set([
  "byteLength",
  "contentHash",
  "contentType",
  "statusCode",
]);

const unsafeHeaderNamePattern =
  /(?:^|[-_])(authorization|cookie|credential|secret|session|token)(?:$|[-_])|api[-_]?key/u;
const unsafeHeaderValuePattern =
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|(?:api[-_]?key|access[-_]?token|secret|session|password)=/iu;
const unsafeQueryKeyPattern =
  /(?:^|[-_])(access|api|auth|authorization|client|credential|password|secret|session|signature|token)(?:$|[-_])|api[-_]?key|client[-_]?secret/u;
const unsafeQueryValuePattern =
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|(?:api[-_]?key|access[-_]?token|auth|authorization|secret|session|password|credential|token)\s*[=:]/iu;

export type HttpReadonlyMethod = "GET" | "HEAD";

export const HTTP_READONLY_DNS_REBINDING_CERTIFICATION = {
  status: "not_certified",
  reason:
    "The v0 HTTP readonly adapter blocks literal local/private/link-local destinations and requires an explicit origin allowlist, but it does not resolve and pin DNS answers before fetch.",
  mitigation: "origin_allowlist_and_literal_destination_guards",
} as const;

export type HttpReadonlyObservationFailureReason =
  | "fetch_error"
  | "invalid_input"
  | "invalid_method"
  | "invalid_observed_at"
  | "invalid_response_metadata"
  | "invalid_url"
  | "missing_fetch"
  | "non_success_status"
  | "non_http_scheme"
  | "raw_body_not_allowed"
  | "redirect_limit_exceeded"
  | "response_too_large"
  | "timeout"
  | "unsafe_redirect"
  | "unsafe_destination"
  | "unsafe_header"
  | "unsafe_query"
  | "url_not_allowed"
  | "url_credentials_forbidden";

export interface HttpReadonlyResponseMetadata {
  readonly statusCode: number;
  readonly contentHash: Sha256Hash;
  readonly byteLength: number;
  readonly contentType?: string | undefined;
}

export interface HttpReadonlySuccessPayload {
  readonly result: "observed";
  readonly method: HttpReadonlyMethod;
  readonly resource: JsonObject;
  readonly response: HttpReadonlyResponseMetadata;
  readonly statusCode: number;
  readonly contentHash: Sha256Hash;
  readonly byteLength: number;
  readonly redirects: number;
  readonly redaction: "content_hash_only";
}

export interface HttpReadonlyFailurePayload {
  readonly result: "failed";
  readonly reason: HttpReadonlyObservationFailureReason;
  readonly method?: string | undefined;
  readonly resource?: JsonObject | undefined;
  readonly statusCode?: number | undefined;
  readonly redirects?: number | undefined;
  readonly redaction: "content_hash_only";
}

export type HttpReadonlyReceiptPayload =
  | HttpReadonlyFailurePayload
  | HttpReadonlySuccessPayload;

export interface HttpReadonlyObservationAdapterOptions {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly allowLocalNetworkForTestingOnly?: boolean | undefined;
  readonly receiptType?: string | undefined;
  readonly observationType?: string | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly freshnessRequirementMs?: number | undefined;
  readonly sensitivity?: EvidenceSensitivity | undefined;
  readonly clock?: (() => ISODateTimeString) | undefined;
}

export interface HttpReadonlyObservationCandidateInput {
  readonly runId: string;
  readonly commandId: string;
  readonly url: string;
  readonly method: string;
  readonly observedAt: ISODateTimeString;
  readonly responseMetadata: HttpReadonlyResponseMetadata;
  readonly observationType?: string | undefined;
  readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly freshnessRequirementMs?: number | undefined;
  readonly sensitivity?: EvidenceSensitivity | undefined;
}

interface SafeHttpUrl {
  readonly url: URL;
  readonly identity: JsonObject;
}

interface SafeRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;
  readonly safeHeaderNames: readonly string[];
}

interface HttpDestinationPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowLocalNetworkForTestingOnly: boolean;
}

interface ParsedAdapterArgs {
  readonly url: URL;
  readonly method: HttpReadonlyMethod;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly maxResponseBytes: number;
  readonly freshnessRequirementMs: number;
  readonly sensitivity: EvidenceSensitivity;
}

interface HashBodyResult {
  readonly contentHash: Sha256Hash;
  readonly byteLength: number;
}

interface TimeoutGuard {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly clear: () => void;
}

type FetchHashOnlyResult =
  | {
      readonly status: "failed";
      readonly reason: HttpReadonlyObservationFailureReason;
      readonly resource: JsonObject;
      readonly statusCode?: number | undefined;
      readonly redirects: number;
    }
  | {
      readonly status: "succeeded";
      readonly finalUrl: string;
      readonly resource: JsonObject;
      readonly responseMetadata: HttpReadonlyResponseMetadata;
      readonly redirects: number;
    };

export class HttpReadonlyObservationContractError extends Error {
  constructor(
    readonly code: HttpReadonlyObservationFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "HttpReadonlyObservationContractError";
  }
}

export function createHttpReadonlyObservationAdapter(
  options: HttpReadonlyObservationAdapterOptions,
): EffectAdapter {
  const receiptType = options.receiptType ?? defaultReceiptType;
  const observationType = options.observationType ?? defaultObservationType;
  const maxResponseBytes = optionalPositiveInteger(
    options.maxResponseBytes,
    "maxResponseBytes",
    defaultMaxResponseBytes,
  );
  const maxRedirects = optionalNonNegativeInteger(
    options.maxRedirects,
    "maxRedirects",
    defaultMaxRedirects,
  );
  const timeoutMs = optionalPositiveInteger(
    options.timeoutMs,
    "timeoutMs",
    defaultTimeoutMs,
  );
  const freshnessRequirementMs = optionalPositiveInteger(
    options.freshnessRequirementMs,
    "freshnessRequirementMs",
    defaultFreshnessRequirementMs,
  );
  const sensitivity = normalizeSensitivity(options.sensitivity);
  const destinationPolicy: HttpDestinationPolicy = {
    allowedOrigins: normalizeAllowedOrigins(options.allowedOrigins),
    allowLocalNetworkForTestingOnly:
      options.allowLocalNetworkForTestingOnly === true,
  };

  return {
    adapterId: options.adapterId,
    capabilityId: options.capabilityId,
    toolId: options.toolId,
    certification: {
      certificationVersion: 1,
      adapterId: options.adapterId,
      adapterKind: "external_read",
      capabilityId: options.capabilityId,
      toolId: options.toolId,
      sideEffectClass: "read",
      declaredReceiptTypes: [receiptType],
      declaredObservationTypes: [observationType],
      idempotency: "not_required",
      riskProfile: "standard",
    },
    execute: async (request, context) => {
      const observedAt = (options.clock ?? context.now)();

      let parsedArgs: ParsedAdapterArgs;
      try {
        parsedArgs = parseAdapterArgs(request.effectRequest.args, {
          maxResponseBytes,
          freshnessRequirementMs,
          sensitivity,
          destinationPolicy,
        });
      } catch (error) {
        if (error instanceof HttpReadonlyObservationContractError) {
          return {
            receiptCandidate: receiptCandidateFor({
              effectId: request.effectRequest.effectId,
              runId: request.effectRequest.runId,
              capabilityId: request.effectRequest.capabilityId,
              receiptType,
              observedAt,
              payload: failurePayload({
                reason: error.code,
                method: stringValue(request.effectRequest.args.method),
              }),
            }),
          };
        }
        throw error;
      }

      const fetchResult = await fetchHashOnly({
        method: parsedArgs.method,
        requestHeaders: parsedArgs.requestHeaders,
        url: parsedArgs.url,
        maxRedirects,
        maxResponseBytes: parsedArgs.maxResponseBytes,
        timeoutMs,
        destinationPolicy,
      });

      if (fetchResult.status === "failed") {
        return {
          receiptCandidate: receiptCandidateFor({
            effectId: request.effectRequest.effectId,
            runId: request.effectRequest.runId,
            capabilityId: request.effectRequest.capabilityId,
            receiptType,
            observedAt,
            payload: failurePayload({
              reason: fetchResult.reason,
              method: parsedArgs.method,
              resource: fetchResult.resource,
              statusCode: fetchResult.statusCode,
              redirects: fetchResult.redirects,
            }),
          }),
        };
      }

      const externalStateObservationCandidate =
        buildHttpReadonlyObservationCandidate({
          runId: request.effectRequest.runId,
          commandId: request.effectRequest.commandId,
          url: fetchResult.finalUrl,
          method: parsedArgs.method,
          observedAt,
          observationType,
          requestHeaders: parsedArgs.requestHeaders,
          responseMetadata: fetchResult.responseMetadata,
          maxResponseBytes: parsedArgs.maxResponseBytes,
          freshnessRequirementMs: parsedArgs.freshnessRequirementMs,
          sensitivity: parsedArgs.sensitivity,
        });

      return {
        receiptCandidate: receiptCandidateFor({
          effectId: request.effectRequest.effectId,
          runId: request.effectRequest.runId,
          capabilityId: request.effectRequest.capabilityId,
          receiptType,
          observedAt,
          payload: successPayload({
            method: parsedArgs.method,
            resource: fetchResult.resource,
            responseMetadata: fetchResult.responseMetadata,
            redirects: fetchResult.redirects,
          }),
        }),
        externalStateObservationCandidate,
      };
    },
  };
}

export function buildHttpReadonlyObservationCandidate(
  input: HttpReadonlyObservationCandidateInput,
): ExternalStateObservationCandidate {
  const record = assertInputRecord(input);
  const runId = requiredString(record, "runId", "invalid_input");
  const commandId = requiredString(record, "commandId", "invalid_input");
  const observedAt = requiredIsoDateTime(record, "observedAt");
  const method = normalizeMethod(
    requiredString(record, "method", "invalid_method"),
  );
  const urlIdentity = parseUrlIdentity(
    requiredString(record, "url", "invalid_url"),
  );
  const safeHeaderNames = normalizeSafeHeaderNames(record.requestHeaders);
  const maxResponseBytes = optionalPositiveInteger(
    record.maxResponseBytes,
    "maxResponseBytes",
    defaultMaxResponseBytes,
  );
  const freshnessRequirementMs = optionalPositiveInteger(
    record.freshnessRequirementMs,
    "freshnessRequirementMs",
    defaultFreshnessRequirementMs,
  );
  const observationType =
    optionalString(record.observationType, "observationType") ??
    defaultObservationType;
  const sensitivity = normalizeSensitivity(record.sensitivity);
  const responseMetadata = normalizeResponseMetadata(
    record.responseMetadata,
    maxResponseBytes,
  );

  const observedState = {
    method,
    statusCode: responseMetadata.statusCode,
    contentHash: responseMetadata.contentHash,
    byteLength: responseMetadata.byteLength,
    ...(responseMetadata.contentType === undefined
      ? {}
      : { contentType: responseMetadata.contentType }),
    request: {
      safeHeaderNames,
    },
    response: responseMetadataJson(responseMetadata),
    resource: urlIdentity,
    redaction: "content_hash_only",
  } satisfies JsonObject;
  const payloadHash = canonicalObjectHash(observedState);
  const evidenceId = `ev_http_obs_${sanitizeId(commandId)}`;

  return {
    observationId: `obs_http_${sanitizeId(commandId)}`,
    runId,
    observationType,
    subjectType: "http_resource",
    subjectId: `http_resource_${hashId(urlIdentity)}`,
    observedState,
    observedAt,
    expiresAt: afterMilliseconds(observedAt, freshnessRequirementMs),
    payloadHash,
    evidence: [
      pendingEvidenceRef({
        evidenceId,
        kind: "external_observation",
        hash: payloadHash,
        observedAt,
        sensitivity,
        expiresAt: afterMilliseconds(observedAt, freshnessRequirementMs),
        metadata: {
          redaction: "content_hash_only",
        },
      }),
    ],
  };
}

function assertInputRecord(
  input: HttpReadonlyObservationCandidateInput,
): Record<string, unknown> {
  assertRecord(
    input,
    "invalid_input",
    "HTTP readonly input must be an object.",
  );
  assertNoRawBodyKeys(input, "HTTP readonly input");
  assertOnlyKeys(input, inputKeys, "HTTP readonly input");
  return input;
}

function parseUrlIdentity(value: string): JsonObject {
  return parseSafeHttpUrl(value).identity;
}

function parseSafeHttpUrl(value: string): SafeHttpUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpReadonlyObservationContractError(
      "invalid_url",
      "HTTP readonly URL must be parseable.",
    );
  }

  if (!allowedSchemes.has(url.protocol)) {
    throw new HttpReadonlyObservationContractError(
      "non_http_scheme",
      "HTTP readonly observations allow only http and https URLs.",
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new HttpReadonlyObservationContractError(
      "url_credentials_forbidden",
      "HTTP readonly URLs must not contain embedded credentials.",
    );
  }

  const queryKeys = [...new Set([...url.searchParams.keys()])].sort();
  const unsafeQueryKey = queryKeys.find((key) =>
    unsafeQueryKeyPattern.test(key.toLowerCase()),
  );
  if (unsafeQueryKey !== undefined) {
    throw new HttpReadonlyObservationContractError(
      "unsafe_query",
      `HTTP readonly URL query key ${unsafeQueryKey} may contain credentials.`,
    );
  }

  const unsafeQueryValue = [...url.searchParams.values()].find((item) =>
    unsafeQueryValuePattern.test(item),
  );
  if (unsafeQueryValue !== undefined) {
    throw new HttpReadonlyObservationContractError(
      "unsafe_query",
      "HTTP readonly URL query values must not contain credential-like material.",
    );
  }

  return {
    url,
    identity: urlIdentity(url, queryKeys),
  };
}

function normalizeMethod(value: string): HttpReadonlyMethod {
  const method = value.trim().toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new HttpReadonlyObservationContractError(
      "invalid_method",
      "HTTP readonly observations allow only GET and HEAD.",
    );
  }
  return method;
}

function normalizeSafeHeaderNames(value: unknown): string[] {
  return [...normalizeSafeRequestHeaders(value).safeHeaderNames];
}

function normalizeSafeRequestHeaders(value: unknown): SafeRequestHeaders {
  if (value === undefined) {
    return {
      headers: {},
      safeHeaderNames: [],
    };
  }

  assertRecord(
    value,
    "unsafe_header",
    "HTTP readonly requestHeaders must be an object.",
  );

  const names: string[] = [];
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (
      name.length === 0 ||
      /[\r\n:]/u.test(name) ||
      unsafeHeaderNamePattern.test(name)
    ) {
      throw new HttpReadonlyObservationContractError(
        "unsafe_header",
        `HTTP readonly header ${rawName} is not safe to carry.`,
      );
    }
    if (typeof rawValue !== "string" || /[\r\n]/u.test(rawValue)) {
      throw new HttpReadonlyObservationContractError(
        "unsafe_header",
        `HTTP readonly header ${rawName} has an unsafe value.`,
      );
    }
    if (unsafeHeaderValuePattern.test(rawValue)) {
      throw new HttpReadonlyObservationContractError(
        "unsafe_header",
        `HTTP readonly header ${rawName} may carry credentials.`,
      );
    }
    names.push(name);
    headers[name] = rawValue.trim();
  }

  return {
    headers,
    safeHeaderNames: [...new Set(names)].sort(),
  };
}

function normalizeResponseMetadata(
  value: unknown,
  maxResponseBytes: number,
): HttpReadonlyResponseMetadata {
  assertRecord(
    value,
    "invalid_response_metadata",
    "HTTP readonly responseMetadata must be an object.",
  );
  assertNoRawBodyKeys(value, "HTTP readonly responseMetadata");
  assertOnlyKeys(value, responseMetadataKeys, "HTTP readonly responseMetadata");

  const statusCode = value.statusCode;
  if (
    typeof statusCode !== "number" ||
    !Number.isInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 599
  ) {
    throw new HttpReadonlyObservationContractError(
      "invalid_response_metadata",
      "HTTP readonly statusCode must be an integer between 100 and 599.",
    );
  }

  const contentHash = value.contentHash;
  if (typeof contentHash !== "string" || !isSha256Hash(contentHash)) {
    throw new HttpReadonlyObservationContractError(
      "invalid_response_metadata",
      "HTTP readonly contentHash must be a sha256 hash.",
    );
  }

  const byteLength = value.byteLength;
  if (
    typeof byteLength !== "number" ||
    !Number.isInteger(byteLength) ||
    byteLength < 0
  ) {
    throw new HttpReadonlyObservationContractError(
      "invalid_response_metadata",
      "HTTP readonly byteLength must be a non-negative integer.",
    );
  }
  if (byteLength > maxResponseBytes) {
    throw new HttpReadonlyObservationContractError(
      "response_too_large",
      "HTTP readonly response metadata exceeds maxResponseBytes.",
    );
  }

  const contentType = optionalString(value.contentType, "contentType");

  return {
    byteLength,
    contentHash,
    ...(contentType === undefined ? {} : { contentType }),
    statusCode,
  };
}

function responseMetadataJson(
  metadata: HttpReadonlyResponseMetadata,
): JsonObject {
  return {
    byteLength: metadata.byteLength,
    contentHash: metadata.contentHash,
    ...(metadata.contentType === undefined
      ? {}
      : { contentType: metadata.contentType }),
    statusCode: metadata.statusCode,
  };
}

function parseAdapterArgs(
  args: JsonObject,
  defaults: {
    readonly maxResponseBytes: number;
    readonly freshnessRequirementMs: number;
    readonly sensitivity: EvidenceSensitivity;
    readonly destinationPolicy: HttpDestinationPolicy;
  },
): ParsedAdapterArgs {
  assertRecord(args, "invalid_input", "HTTP readonly args must be an object.");
  assertNoRawBodyKeys(args, "HTTP readonly args");
  assertOnlyKeys(args, adapterArgKeys, "HTTP readonly args");

  const safeUrl = parseSafeHttpUrl(requiredString(args, "url", "invalid_url"));
  assertExecutableDestination(safeUrl.url, defaults.destinationPolicy);
  const method = normalizeMethod(
    requiredString(args, "method", "invalid_method"),
  );
  const requestHeaders = normalizeSafeRequestHeaders(args.requestHeaders);

  return {
    url: safeUrl.url,
    method,
    requestHeaders: requestHeaders.headers,
    maxResponseBytes: optionalPositiveInteger(
      args.maxResponseBytes,
      "maxResponseBytes",
      defaults.maxResponseBytes,
    ),
    freshnessRequirementMs: optionalPositiveInteger(
      args.freshnessRequirementMs,
      "freshnessRequirementMs",
      defaults.freshnessRequirementMs,
    ),
    sensitivity: normalizeSensitivity(args.sensitivity ?? defaults.sensitivity),
  };
}

async function fetchHashOnly(input: {
  readonly url: URL;
  readonly method: HttpReadonlyMethod;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
  readonly destinationPolicy: HttpDestinationPolicy;
}): Promise<FetchHashOnlyResult> {
  if (typeof globalThis.fetch !== "function") {
    return {
      status: "failed",
      reason: "missing_fetch",
      resource: urlIdentity(input.url),
      redirects: 0,
    };
  }

  let currentUrl = input.url;
  let redirects = 0;

  for (;;) {
    const timeout = createTimeoutGuard(input.timeoutMs);
    try {
      const response = await globalThis.fetch(currentUrl, {
        method: input.method,
        headers: input.requestHeaders,
        redirect: "manual",
        signal: timeout.signal,
      });

      if (isRedirectResponse(response)) {
        const location = response.headers.get("location");
        if (location === null) {
          return {
            status: "failed",
            reason: "unsafe_redirect",
            resource: urlIdentity(currentUrl),
            statusCode: response.status,
            redirects,
          };
        }

        if (redirects >= input.maxRedirects) {
          return {
            status: "failed",
            reason: "redirect_limit_exceeded",
            resource: urlIdentity(currentUrl),
            statusCode: response.status,
            redirects,
          };
        }

        const nextUrl = parseRedirectUrl(location, currentUrl);
        if (
          nextUrl === undefined ||
          isUnsafeRedirect(currentUrl, nextUrl) ||
          !isExecutableDestination(nextUrl, input.destinationPolicy)
        ) {
          return {
            status: "failed",
            reason: "unsafe_redirect",
            resource: urlIdentity(currentUrl),
            statusCode: response.status,
            redirects,
          };
        }

        currentUrl = nextUrl;
        redirects += 1;
        continue;
      }

      if (!isSuccessStatus(response.status)) {
        return {
          status: "failed",
          reason: "non_success_status",
          resource: urlIdentity(currentUrl),
          statusCode: response.status,
          redirects,
        };
      }

      if (input.method === "GET") {
        const declaredLength = contentLength(response.headers);
        if (
          declaredLength !== undefined &&
          declaredLength > input.maxResponseBytes
        ) {
          return {
            status: "failed",
            reason: "response_too_large",
            resource: urlIdentity(currentUrl),
            statusCode: response.status,
            redirects,
          };
        }
      }

      const bodyHash =
        input.method === "HEAD"
          ? emptyBodyHash()
          : await hashResponseBody(response, input.maxResponseBytes);

      if (bodyHash === "response_too_large") {
        return {
          status: "failed",
          reason: "response_too_large",
          resource: urlIdentity(currentUrl),
          statusCode: response.status,
          redirects,
        };
      }

      const contentType = safeContentType(response.headers);
      return {
        status: "succeeded",
        finalUrl: currentUrl.href,
        resource: urlIdentity(currentUrl),
        responseMetadata: {
          statusCode: response.status,
          contentHash: bodyHash.contentHash,
          byteLength: bodyHash.byteLength,
          ...(contentType === undefined ? {} : { contentType }),
        },
        redirects,
      };
    } catch {
      return {
        status: "failed",
        reason: timeout.timedOut() ? "timeout" : "fetch_error",
        resource: urlIdentity(currentUrl),
        redirects,
      };
    } finally {
      timeout.clear();
    }
  }
}

function createTimeoutGuard(timeoutMs: number): TimeoutGuard {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode <= 299;
}

function normalizeAllowedOrigins(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      "HTTP readonly adapter execution requires at least one allowed origin.",
    );
  }

  const origins = value.map((item, index) =>
    normalizeAllowedOrigin(item, index),
  );
  return new Set([...new Set(origins)].sort());
}

function normalizeAllowedOrigin(value: unknown, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      `HTTP readonly allowedOrigins[${String(index)}] must be a non-empty string.`,
    );
  }

  const safeUrl = parseSafeHttpUrl(value);
  if (
    safeUrl.url.pathname !== "/" ||
    safeUrl.url.search.length > 0 ||
    safeUrl.url.hash.length > 0
  ) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      "HTTP readonly allowedOrigins entries must be origins, not path or query URLs.",
    );
  }
  return safeUrl.url.origin;
}

function assertExecutableDestination(
  url: URL,
  policy: HttpDestinationPolicy,
): void {
  if (!policy.allowedOrigins.has(url.origin)) {
    throw new HttpReadonlyObservationContractError(
      "url_not_allowed",
      "HTTP readonly URL origin is not in the adapter allowlist.",
    );
  }

  if (
    !policy.allowLocalNetworkForTestingOnly &&
    isUnsafeDestinationHost(url.hostname)
  ) {
    throw new HttpReadonlyObservationContractError(
      "unsafe_destination",
      "HTTP readonly URL targets a local, private, link-local, or metadata destination.",
    );
  }
}

function isExecutableDestination(
  url: URL,
  policy: HttpDestinationPolicy,
): boolean {
  try {
    assertExecutableDestination(url, policy);
    return true;
  } catch {
    return false;
  }
}

function isUnsafeDestinationHost(hostname: string): boolean {
  const host = stripTrailingDot(stripIpv6Brackets(hostname.toLowerCase()));
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal")
  ) {
    return true;
  }

  if (isIP(host) === 4) {
    const octets = parseIpv4Octets(host);
    return octets === undefined ? true : isUnsafeIpv4(octets);
  }

  if (isIP(host) === 6) {
    return isUnsafeIpv6(host);
  }

  return false;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function parseIpv4Octets(
  host: string,
): readonly [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) => Number(part));
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }

  return [
    octets[0] as number,
    octets[1] as number,
    octets[2] as number,
    octets[3] as number,
  ];
}

function isUnsafeIpv4(
  octets: readonly [number, number, number, number],
): boolean {
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isUnsafeIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") {
    return true;
  }
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) {
    return true;
  }
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return true;
  }
  return false;
}

function isRedirectResponse(response: Response): boolean {
  return redirectStatuses.has(response.status);
}

function parseRedirectUrl(location: string, currentUrl: URL): URL | undefined {
  try {
    return parseSafeHttpUrl(new URL(location, currentUrl).href).url;
  } catch {
    return undefined;
  }
}

function isUnsafeRedirect(currentUrl: URL, nextUrl: URL): boolean {
  return (
    currentUrl.protocol !== nextUrl.protocol || currentUrl.host !== nextUrl.host
  );
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

async function hashResponseBody(
  response: Response,
  maxResponseBytes: number,
): Promise<HashBodyResult | "response_too_large"> {
  if (response.body === null) {
    return emptyBodyHash();
  }

  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let byteLength = 0;

  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      const chunk = Buffer.from(read.value);
      byteLength += chunk.byteLength;

      if (byteLength > maxResponseBytes) {
        await reader.cancel();
        return "response_too_large";
      }

      hash.update(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    contentHash: `sha256:${hash.digest("hex")}`,
    byteLength,
  };
}

function emptyBodyHash(): HashBodyResult {
  return {
    contentHash:
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    byteLength: 0,
  };
}

function safeContentType(headers: Headers): string | undefined {
  const contentType = headers.get("content-type");
  if (contentType === null) {
    return undefined;
  }

  const [mediaType] = contentType.split(";");
  const normalized = mediaType?.trim().toLowerCase();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

function receiptCandidateFor(input: {
  readonly effectId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly receiptType: string;
  readonly observedAt: ISODateTimeString;
  readonly payload: HttpReadonlyReceiptPayload;
}): ReceiptCandidate {
  const payload = input.payload as unknown as JsonObject;
  const payloadHash = canonicalObjectHash(payload);
  return {
    receiptId: `receipt_${input.effectId}`,
    effectId: input.effectId,
    runId: input.runId,
    capabilityId: input.capabilityId,
    receiptType: input.receiptType,
    status: input.payload.result === "observed" ? "succeeded" : "failed",
    payload,
    payloadHash,
    observedAt: input.observedAt,
    evidence: [
      pendingEvidenceRef({
        evidenceId: `ev_${sanitizeId(input.effectId)}`,
        kind: "effect_receipt",
        hash: payloadHash,
        observedAt: input.observedAt,
        sensitivity: "internal",
        metadata: {
          redaction: "content_hash_only",
        },
      }),
    ],
  };
}

function successPayload(input: {
  readonly method: HttpReadonlyMethod;
  readonly resource: JsonObject;
  readonly responseMetadata: HttpReadonlyResponseMetadata;
  readonly redirects: number;
}): HttpReadonlySuccessPayload {
  return {
    result: "observed",
    method: input.method,
    resource: input.resource,
    response: input.responseMetadata,
    statusCode: input.responseMetadata.statusCode,
    contentHash: input.responseMetadata.contentHash,
    byteLength: input.responseMetadata.byteLength,
    redirects: input.redirects,
    redaction: "content_hash_only",
  };
}

function failurePayload(input: {
  readonly reason: HttpReadonlyObservationFailureReason;
  readonly method?: string | undefined;
  readonly resource?: JsonObject | undefined;
  readonly statusCode?: number | undefined;
  readonly redirects?: number | undefined;
}): HttpReadonlyFailurePayload {
  return {
    result: "failed",
    reason: input.reason,
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.redirects === undefined ? {} : { redirects: input.redirects }),
    redaction: "content_hash_only",
  };
}

function pendingEvidenceRef(
  input: Omit<PendingEvidenceRef, "admissionStatus" | "pendingAdmissionToken">,
): PendingEvidenceRef {
  return {
    ...input,
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${sanitizeId(input.evidenceId)}`,
  };
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  code: HttpReadonlyObservationFailureReason,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpReadonlyObservationContractError(
      code,
      `HTTP readonly ${key} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      `HTTP readonly ${key} must be a non-empty string when present.`,
    );
  }
  if (/[\r\n]/u.test(value)) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      `HTTP readonly ${key} must not contain control-line characters.`,
    );
  }
  return value.trim();
}

function requiredIsoDateTime(
  record: Record<string, unknown>,
  key: string,
): ISODateTimeString {
  const value = requiredString(record, key, "invalid_observed_at");
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new HttpReadonlyObservationContractError(
      "invalid_observed_at",
      `HTTP readonly ${key} must be an ISO date-time string.`,
    );
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  key: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      `HTTP readonly ${key} must be a positive integer.`,
    );
  }
  return value;
}

function optionalNonNegativeInteger(
  value: unknown,
  key: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      `HTTP readonly ${key} must be a non-negative integer.`,
    );
  }
  return value;
}

function normalizeSensitivity(value: unknown): EvidenceSensitivity {
  if (value === undefined) {
    return "internal";
  }
  if (
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted"
  ) {
    return value;
  }
  throw new HttpReadonlyObservationContractError(
    "invalid_input",
    "HTTP readonly sensitivity is unsupported.",
  );
}

function assertRecord(
  value: unknown,
  code: HttpReadonlyObservationFailureReason,
  message: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpReadonlyObservationContractError(code, message);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new HttpReadonlyObservationContractError(
      "invalid_input",
      `${label} contains unknown fields: ${unknownKeys.join(", ")}.`,
    );
  }
}

function assertNoRawBodyKeys(
  value: Record<string, unknown>,
  label: string,
): void {
  const bodyKey = Object.keys(value).find((key) => {
    const normalized = key.replace(/[-_]/gu, "").toLowerCase();
    return rawBodyKeys.has(key) || normalizedRawBodyKeys.has(normalized);
  });
  if (bodyKey !== undefined) {
    throw new HttpReadonlyObservationContractError(
      "raw_body_not_allowed",
      `${label} must not include raw response body field ${bodyKey}.`,
    );
  }
}

function isSha256Hash(value: string): value is Sha256Hash {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function urlIdentity(url: URL, queryKeys?: readonly string[]): JsonObject {
  return {
    fragmentPresent: url.hash.length > 0,
    host: url.hostname.toLowerCase(),
    path: url.pathname,
    port: url.port,
    queryKeys: [...(queryKeys ?? new Set([...url.searchParams.keys()]))].sort(),
    scheme: url.protocol.slice(0, -1),
  } satisfies JsonObject;
}

function hashId(value: JsonObject): string {
  return canonicalObjectHash(value).replace(/^sha256:/u, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function afterMilliseconds(
  value: ISODateTimeString,
  milliseconds: number,
): ISODateTimeString {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}
