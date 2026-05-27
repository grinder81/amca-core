import { createHash } from "node:crypto";

import { canonicalObjectHash } from "@amca/contracts";
import type {
  CertifiedEffectRequest,
  EffectAdapter,
  ReceiptCandidate,
} from "@amca/effect-sdk";
import type {
  EvidenceSensitivity,
  ExternalStateObservationCandidate,
  ISODateTimeString,
  JsonObject,
  PendingEvidenceRef,
  Sha256Hash,
  SideEffectClass,
} from "@amca/protocol";

const defaultApiVersion = "2022-11-28";
const defaultReadReceiptType = "github.rest.read";
const defaultReadObservationType = "github.rest.resource_snapshot";
const defaultWriteReceiptType = "github.rest.write";
const defaultMaxResponseBytes = 1024 * 1024;
const defaultFreshnessRequirementMs = 60_000;

const allowedSchemes = new Set(["http:", "https:"]);
const readMethods = new Set(["GET", "HEAD"]);
const writeMethods = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const adapterModeKeys = new Set(["read", "write"]);
const githubRestOperationValues = [
  "create_pull_request",
  "get_pull_request",
  "get_repository",
  "list_pull_requests",
  "merge_pull_request",
  "update_pull_request",
] as const;
const githubRestOperations: ReadonlySet<string> = new Set(
  githubRestOperationValues,
);
const argKeys = new Set([
  "body",
  "freshnessRequirementMs",
  "maxResponseBytes",
  "method",
  "path",
  "requestHeaders",
  "sensitivity",
  "url",
]);
const unsafeHeaderNamePattern =
  /(?:^|[-_])(authorization|cookie|credential|secret|session|token)(?:$|[-_])|api[-_]?key/u;
const unsafeHeaderValuePattern =
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|(?:api[-_]?key|access[-_]?token|secret|session|password)=/iu;
const unsafeQueryKeyPattern =
  /(?:^|[-_])(access|api|auth|authorization|client|credential|password|secret|session|signature|token)(?:$|[-_])|api[-_]?key|client[-_]?secret/u;
const unsafeQueryValuePattern =
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|(?:api[-_]?key|access[-_]?token|auth|authorization|secret|session|password|credential|token)\s*[=:]/iu;

export type GithubRestAdapterMode = "read" | "write";

export type GithubRestMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "PATCH"
  | "POST"
  | "PUT";

export type GithubRestAdapterFailureReason =
  | "base_url_not_allowed"
  | "branch_not_allowed"
  | "branch_scope_required"
  | "capability_scope_mismatch"
  | "endpoint_not_allowed"
  | "fetch_error"
  | "invalid_body"
  | "invalid_input"
  | "invalid_method"
  | "invalid_url"
  | "missing_fetch"
  | "missing_idempotency_key"
  | "missing_token"
  | "non_http_scheme"
  | "owner_not_allowed"
  | "response_too_large"
  | "repo_not_allowed"
  | "unsafe_header"
  | "unsafe_query"
  | "url_credentials_forbidden";

export type GithubRestOperation = (typeof githubRestOperationValues)[number];

export interface GithubRestRepositoryScope {
  readonly owner: string;
  readonly repo: string;
  readonly allowedOperations: readonly GithubRestOperation[];
  readonly allowedBaseBranches?: readonly string[] | undefined;
  readonly allowedHeadBranches?: readonly string[] | undefined;
}

export interface GithubRestAdapterOptions {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly mode: GithubRestAdapterMode;
  readonly allowedBaseUrls: readonly string[];
  readonly repositoryScopes: readonly GithubRestRepositoryScope[];
  readonly token?: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly receiptType?: string | undefined;
  readonly observationType?: string | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly freshnessRequirementMs?: number | undefined;
  readonly sensitivity?: EvidenceSensitivity | undefined;
  readonly writeSideEffectClass?: Extract<
    SideEffectClass,
    "idempotent_write" | "irreversible_write" | "reversible_write"
  >;
}

export interface GithubRestResponseMetadata {
  readonly statusCode: number;
  readonly contentHash: Sha256Hash;
  readonly byteLength: number;
  readonly contentType?: string | undefined;
}

export interface GithubRestRequestMetadata {
  readonly method: GithubRestMethod;
  readonly operation: GithubRestOperation;
  readonly resource: JsonObject;
  readonly safeHeaderNames: readonly string[];
  readonly bodyHash?: Sha256Hash | undefined;
  readonly idempotencyKeyHash?: Sha256Hash | undefined;
}

export interface GithubRestSuccessPayload {
  readonly result: "succeeded";
  readonly request: GithubRestRequestMetadata;
  readonly response: GithubRestResponseMetadata;
  readonly statusCode: number;
  readonly redaction: "content_hash_only";
}

export interface GithubRestFailurePayload {
  readonly result: "failed";
  readonly reason: GithubRestAdapterFailureReason;
  readonly method?: string | undefined;
  readonly resource?: JsonObject | undefined;
  readonly statusCode?: number | undefined;
  readonly redaction: "content_hash_only";
}

export type GithubRestReceiptPayload =
  | GithubRestFailurePayload
  | GithubRestSuccessPayload;

interface ParsedArgs {
  readonly method: GithubRestMethod;
  readonly operation: GithubRestOperation;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly safeHeaderNames: readonly string[];
  readonly url: URL;
  readonly resource: JsonObject;
  readonly bodyHash?: Sha256Hash | undefined;
  readonly serializedBody?: string | undefined;
  readonly maxResponseBytes: number;
  readonly freshnessRequirementMs: number;
  readonly sensitivity: EvidenceSensitivity;
}

interface FetchResult {
  readonly status: "succeeded";
  readonly response: GithubRestResponseMetadata;
}

interface HashBodyResult {
  readonly contentHash: Sha256Hash;
  readonly byteLength: number;
}

interface GithubRestResource {
  readonly operation: GithubRestOperation;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber?: string | undefined;
}

interface NormalizedGithubRestRepositoryScope {
  readonly owner: string;
  readonly ownerKey: string;
  readonly repo: string;
  readonly repoKey: string;
  readonly allowedOperations: ReadonlySet<GithubRestOperation>;
  readonly allowedBaseBranches?: ReadonlySet<string> | undefined;
  readonly allowedHeadBranches?: ReadonlySet<string> | undefined;
}

export class GithubRestAdapterError extends Error {
  constructor(
    readonly code: GithubRestAdapterFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "GithubRestAdapterError";
  }
}

export function createGithubRestAdapter(
  options: GithubRestAdapterOptions,
): EffectAdapter {
  const mode = normalizeMode(options.mode);
  const allowedBaseUrls = normalizeAllowedBaseUrls(options.allowedBaseUrls);
  const repositoryScopes = normalizeRepositoryScopes(options.repositoryScopes);
  const receiptType =
    options.receiptType ??
    (mode === "read" ? defaultReadReceiptType : defaultWriteReceiptType);
  const observationType = options.observationType ?? defaultReadObservationType;
  const maxResponseBytes = optionalPositiveInteger(
    options.maxResponseBytes,
    "maxResponseBytes",
    defaultMaxResponseBytes,
  );
  const freshnessRequirementMs = optionalPositiveInteger(
    options.freshnessRequirementMs,
    "freshnessRequirementMs",
    defaultFreshnessRequirementMs,
  );
  const sensitivity = normalizeSensitivity(options.sensitivity);
  const sideEffectClass =
    mode === "read"
      ? "read"
      : (options.writeSideEffectClass ?? "idempotent_write");

  return {
    adapterId: options.adapterId,
    capabilityId: options.capabilityId,
    toolId: options.toolId,
    certification: {
      certificationVersion: 1,
      adapterId: options.adapterId,
      adapterKind: mode === "read" ? "external_read" : "external_write",
      capabilityId: options.capabilityId,
      toolId: options.toolId,
      sideEffectClass,
      declaredReceiptTypes: [receiptType],
      ...(mode === "read"
        ? { declaredObservationTypes: [observationType] }
        : {}),
      idempotency: mode === "read" ? "not_required" : "required_for_writes",
      ...(mode === "write"
        ? {
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
          }
        : {}),
      riskProfile: mode === "read" ? "standard" : "critical",
    },
    execute: async (request, context) => {
      const observedAt = context.now();
      const capabilityScopeFailure = capabilityScopeFailureFor({
        capabilityId: options.capabilityId,
        request,
        toolId: options.toolId,
      });
      if (capabilityScopeFailure !== undefined) {
        return {
          receiptCandidate: receiptCandidateFor({
            capabilityId: request.effectRequest.capabilityId,
            effectId: request.effectRequest.effectId,
            observedAt,
            payload: failurePayload({
              method: stringValue(request.effectRequest.args.method),
              reason: capabilityScopeFailure,
            }),
            receiptType,
            runId: request.effectRequest.runId,
          }),
        };
      }

      let parsed: ParsedArgs;
      try {
        parsed = parseArgs(request.effectRequest.args, {
          allowedBaseUrls,
          defaults: {
            maxResponseBytes,
            freshnessRequirementMs,
            sensitivity,
          },
          mode,
          repositoryScopes,
        });
      } catch (error) {
        if (error instanceof GithubRestAdapterError) {
          return {
            receiptCandidate: receiptCandidateFor({
              capabilityId: request.effectRequest.capabilityId,
              effectId: request.effectRequest.effectId,
              observedAt,
              payload: failurePayload({
                method: stringValue(request.effectRequest.args.method),
                reason: error.code,
              }),
              receiptType,
              runId: request.effectRequest.runId,
            }),
          };
        }
        throw error;
      }

      if (
        mode === "write" &&
        request.effectRequest.idempotencyKey === undefined
      ) {
        return {
          receiptCandidate: receiptCandidateFor({
            capabilityId: request.effectRequest.capabilityId,
            effectId: request.effectRequest.effectId,
            observedAt,
            payload: failurePayload({
              method: parsed.method,
              reason: "missing_idempotency_key",
              resource: parsed.resource,
            }),
            receiptType,
            runId: request.effectRequest.runId,
          }),
        };
      }

      if (mode === "write" && options.token === undefined) {
        return {
          receiptCandidate: receiptCandidateFor({
            capabilityId: request.effectRequest.capabilityId,
            effectId: request.effectRequest.effectId,
            observedAt,
            payload: failurePayload({
              method: parsed.method,
              reason: "missing_token",
              resource: parsed.resource,
            }),
            receiptType,
            runId: request.effectRequest.runId,
          }),
        };
      }

      let fetchResult: FetchResult;
      try {
        fetchResult = await fetchGithubHashOnly({
          apiVersion: options.apiVersion ?? defaultApiVersion,
          body: parsed.serializedBody,
          method: parsed.method,
          maxResponseBytes: parsed.maxResponseBytes,
          requestHeaders: parsed.requestHeaders,
          token: options.token,
          url: parsed.url,
          idempotencyKey:
            mode === "write" ? request.effectRequest.idempotencyKey : undefined,
        });
      } catch (error) {
        if (mode === "write") {
          throw error;
        }

        return {
          receiptCandidate: receiptCandidateFor({
            capabilityId: request.effectRequest.capabilityId,
            effectId: request.effectRequest.effectId,
            observedAt,
            payload: failurePayload({
              method: parsed.method,
              reason:
                error instanceof GithubRestAdapterError
                  ? error.code
                  : "fetch_error",
              resource: parsed.resource,
            }),
            receiptType,
            runId: request.effectRequest.runId,
          }),
        };
      }

      if (mode === "write" && fetchResult.response.statusCode >= 500) {
        throw new GithubRestAdapterError(
          "fetch_error",
          "GitHub write response was uncertain and must be quarantined by the broker.",
        );
      }

      const succeeded =
        fetchResult.response.statusCode >= 200 &&
        fetchResult.response.statusCode < 400;
      const payload =
        succeeded && mode === "read"
          ? successPayload({
              idempotencyKey: request.effectRequest.idempotencyKey,
              parsed,
              response: fetchResult.response,
            })
          : succeeded && mode === "write"
            ? successPayload({
                idempotencyKey: request.effectRequest.idempotencyKey,
                parsed,
                response: fetchResult.response,
              })
            : failurePayload({
                method: parsed.method,
                reason: "fetch_error",
                resource: parsed.resource,
                statusCode: fetchResult.response.statusCode,
              });
      const receiptCandidate = receiptCandidateFor({
        capabilityId: request.effectRequest.capabilityId,
        effectId: request.effectRequest.effectId,
        observedAt,
        payload,
        receiptType,
        runId: request.effectRequest.runId,
      });

      if (!succeeded || mode === "write") {
        return { receiptCandidate };
      }

      return {
        receiptCandidate,
        externalStateObservationCandidate: observationCandidateFor({
          observedAt,
          observationType,
          parsed,
          response: fetchResult.response,
          runId: request.effectRequest.runId,
        }),
      };
    },
  };
}

function parseArgs(
  args: JsonObject,
  input: {
    readonly allowedBaseUrls: readonly URL[];
    readonly defaults: {
      readonly maxResponseBytes: number;
      readonly freshnessRequirementMs: number;
      readonly sensitivity: EvidenceSensitivity;
    };
    readonly mode: GithubRestAdapterMode;
    readonly repositoryScopes: readonly NormalizedGithubRestRepositoryScope[];
  },
): ParsedArgs {
  assertRecord(args, "invalid_input", "GitHub REST args must be an object.");
  assertOnlyKeys(args, argKeys, "GitHub REST args");
  const method = normalizeMethod(requiredString(args, "method"), input.mode);
  const parsedUrl = parseScopedUrl(args, input.allowedBaseUrls);
  const headers = normalizeSafeRequestHeaders(args.requestHeaders);
  const body = bodyForMethod(method, args.body);
  const githubResource = validateGithubResourceScope({
    body: args.body,
    repositoryScopes: input.repositoryScopes,
    resource: parseGithubResource(parsedUrl.url, method),
  });

  return {
    method,
    operation: githubResource.operation,
    requestHeaders: headers.headers,
    safeHeaderNames: headers.safeHeaderNames,
    url: parsedUrl.url,
    resource: resourceIdentity(parsedUrl.identity, githubResource),
    ...(body === undefined
      ? {}
      : { bodyHash: body.hash, serializedBody: body.serialized }),
    maxResponseBytes: optionalPositiveInteger(
      args.maxResponseBytes,
      "maxResponseBytes",
      input.defaults.maxResponseBytes,
    ),
    freshnessRequirementMs: optionalPositiveInteger(
      args.freshnessRequirementMs,
      "freshnessRequirementMs",
      input.defaults.freshnessRequirementMs,
    ),
    sensitivity: normalizeSensitivity(
      args.sensitivity ?? input.defaults.sensitivity,
    ),
  };
}

function capabilityScopeFailureFor(input: {
  readonly capabilityId: string;
  readonly request: CertifiedEffectRequest;
  readonly toolId: string;
}): GithubRestAdapterFailureReason | undefined {
  if (
    input.request.effectRequest.capabilityId !== input.capabilityId ||
    input.request.effectRequest.toolId !== input.toolId ||
    input.request.toolCommand.capabilityId !== input.capabilityId ||
    input.request.toolCommand.toolId !== input.toolId
  ) {
    return "capability_scope_mismatch";
  }

  return undefined;
}

function parseScopedUrl(
  args: Record<string, unknown>,
  allowedBaseUrls: readonly URL[],
): { readonly url: URL; readonly identity: JsonObject } {
  const hasPath = args.path !== undefined;
  const hasUrl = args.url !== undefined;
  if (hasPath === hasUrl) {
    throw new GithubRestAdapterError(
      "invalid_url",
      "GitHub REST args must include exactly one of path or url.",
    );
  }

  const url = hasUrl
    ? parseHttpUrl(requiredString(args, "url"))
    : parsePathUrl(requiredString(args, "path"), allowedBaseUrls[0]);
  if (!isAllowedUrl(url, allowedBaseUrls)) {
    throw new GithubRestAdapterError(
      "base_url_not_allowed",
      "GitHub REST URL is outside the configured allowlist.",
    );
  }

  return {
    url,
    identity: urlIdentity(url),
  };
}

function parseGithubResource(
  url: URL,
  method: GithubRestMethod,
): GithubRestResource {
  const segments = pathSegments(url);
  const owner = segments[1];
  const repo = segments[2];

  if (segments[0] !== "repos" || owner === undefined || repo === undefined) {
    throw new GithubRestAdapterError(
      "endpoint_not_allowed",
      "GitHub REST endpoint is outside the repository operation scope.",
    );
  }

  assertGithubOwner(owner);
  assertGithubRepo(repo);
  const rest = segments.slice(3);

  if (rest.length === 0 && (method === "GET" || method === "HEAD")) {
    return {
      operation: "get_repository",
      owner,
      repo,
    };
  }

  if (rest[0] !== "pulls") {
    throw new GithubRestAdapterError(
      "endpoint_not_allowed",
      "GitHub REST endpoint is outside the repository operation scope.",
    );
  }

  if (rest.length === 1) {
    if (method === "GET" || method === "HEAD") {
      return {
        operation: "list_pull_requests",
        owner,
        repo,
      };
    }
    if (method === "POST") {
      return {
        operation: "create_pull_request",
        owner,
        repo,
      };
    }
  }

  if (rest.length === 2 && rest[1] !== undefined && isPullNumber(rest[1])) {
    if (method === "GET" || method === "HEAD") {
      return {
        operation: "get_pull_request",
        owner,
        pullNumber: rest[1],
        repo,
      };
    }
    if (method === "PATCH") {
      return {
        operation: "update_pull_request",
        owner,
        pullNumber: rest[1],
        repo,
      };
    }
  }

  if (
    rest.length === 3 &&
    rest[1] !== undefined &&
    isPullNumber(rest[1]) &&
    rest[2] === "merge" &&
    method === "PUT"
  ) {
    return {
      operation: "merge_pull_request",
      owner,
      pullNumber: rest[1],
      repo,
    };
  }

  throw new GithubRestAdapterError(
    "endpoint_not_allowed",
    "GitHub REST endpoint is outside the repository operation scope.",
  );
}

function validateGithubResourceScope(input: {
  readonly body: unknown;
  readonly repositoryScopes: readonly NormalizedGithubRestRepositoryScope[];
  readonly resource: GithubRestResource;
}): GithubRestResource {
  const ownerKey = repositoryKey(input.resource.owner);
  const ownerScopes = input.repositoryScopes.filter(
    (scope) => scope.ownerKey === ownerKey,
  );
  if (ownerScopes.length === 0) {
    throw new GithubRestAdapterError(
      "owner_not_allowed",
      "GitHub REST owner is outside the configured repository scope.",
    );
  }

  const repoKey = repositoryKey(input.resource.repo);
  const repoScopes = ownerScopes.filter((scope) => scope.repoKey === repoKey);
  if (repoScopes.length === 0) {
    throw new GithubRestAdapterError(
      "repo_not_allowed",
      "GitHub REST repository is outside the configured repository scope.",
    );
  }

  const scope = repoScopes.find((item) =>
    item.allowedOperations.has(input.resource.operation),
  );
  if (scope === undefined) {
    throw new GithubRestAdapterError(
      "endpoint_not_allowed",
      "GitHub REST operation is outside the configured repository scope.",
    );
  }

  if (input.resource.operation === "create_pull_request") {
    assertCreatePullRequestBranchScope(scope, input.body);
  }

  return input.resource;
}

function assertCreatePullRequestBranchScope(
  scope: NormalizedGithubRestRepositoryScope,
  body: unknown,
): void {
  if (
    scope.allowedBaseBranches === undefined ||
    scope.allowedHeadBranches === undefined
  ) {
    throw new GithubRestAdapterError(
      "branch_scope_required",
      "GitHub pull request writes require explicit branch scope.",
    );
  }

  assertRecord(
    body,
    "branch_scope_required",
    "GitHub pull request writes require branch fields.",
  );
  const baseBranch = requestBranch(body, "base");
  const headBranch = requestBranch(body, "head");

  if (
    !scope.allowedBaseBranches.has(baseBranch) ||
    !scope.allowedHeadBranches.has(headBranch)
  ) {
    throw new GithubRestAdapterError(
      "branch_not_allowed",
      "GitHub pull request branch is outside the configured scope.",
    );
  }
}

function requestBranch(
  body: Record<string, unknown>,
  key: "base" | "head",
): string {
  const value = body[key];
  if (typeof value !== "string" || !isSafeBranchName(value)) {
    throw new GithubRestAdapterError(
      "branch_scope_required",
      "GitHub pull request writes require safe base and head branches.",
    );
  }
  return value.trim();
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (/%|[\r\n]/u.test(segment)) {
        throw new GithubRestAdapterError(
          "invalid_url",
          "GitHub REST path segments must be plain, unencoded values.",
        );
      }
      return segment;
    });
}

function parsePathUrl(path: string, baseUrl: URL | undefined): URL {
  if (baseUrl === undefined) {
    throw new GithubRestAdapterError(
      "base_url_not_allowed",
      "GitHub REST adapter requires at least one allowed base URL.",
    );
  }
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(path)
  ) {
    throw new GithubRestAdapterError(
      "invalid_url",
      "GitHub REST path must be an absolute path under the configured base URL.",
    );
  }
  return parseHttpUrl(new URL(path, baseUrl).href);
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GithubRestAdapterError(
      "invalid_url",
      "GitHub REST URL must be parseable.",
    );
  }

  if (!allowedSchemes.has(url.protocol)) {
    throw new GithubRestAdapterError(
      "non_http_scheme",
      "GitHub REST URLs must use http or https.",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new GithubRestAdapterError(
      "url_credentials_forbidden",
      "GitHub REST URLs must not contain embedded credentials.",
    );
  }

  const unsafeQueryKey = [...url.searchParams.keys()].find((key) =>
    unsafeQueryKeyPattern.test(key.toLowerCase()),
  );
  if (unsafeQueryKey !== undefined) {
    throw new GithubRestAdapterError(
      "unsafe_query",
      `GitHub REST query key ${unsafeQueryKey} may contain credentials.`,
    );
  }
  const unsafeQueryValue = [...url.searchParams.values()].find((item) =>
    unsafeQueryValuePattern.test(item),
  );
  if (unsafeQueryValue !== undefined) {
    throw new GithubRestAdapterError(
      "unsafe_query",
      "GitHub REST query values must not contain credential-like material.",
    );
  }

  return url;
}

function isAllowedUrl(url: URL, allowedBaseUrls: readonly URL[]): boolean {
  return allowedBaseUrls.some(
    (baseUrl) =>
      url.protocol === baseUrl.protocol &&
      url.host === baseUrl.host &&
      url.pathname.startsWith(baseUrl.pathname),
  );
}

function normalizeAllowedBaseUrls(value: readonly string[]): readonly URL[] {
  if (value.length === 0) {
    throw new GithubRestAdapterError(
      "base_url_not_allowed",
      "GitHub REST adapter requires explicit allowedBaseUrls.",
    );
  }
  return value.map((item) => {
    const url = parseHttpUrl(item);
    return new URL(url.pathname.endsWith("/") ? url.href : `${url.href}/`);
  });
}

function normalizeRepositoryScopes(
  value: readonly unknown[],
): readonly NormalizedGithubRestRepositoryScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GithubRestAdapterError(
      "invalid_input",
      "GitHub REST adapter requires explicit repositoryScopes.",
    );
  }

  return value.map((rawScope) => {
    assertRecord(
      rawScope,
      "invalid_input",
      "GitHub REST repository scope must be an object.",
    );
    const owner = normalizeGithubOwner(requiredString(rawScope, "owner"));
    const repo = normalizeGithubRepo(requiredString(rawScope, "repo"));
    const allowedOperations = normalizeAllowedOperations(
      rawScope.allowedOperations,
    );
    const allowedBaseBranches = optionalBranchSet(rawScope.allowedBaseBranches);
    const allowedHeadBranches = optionalBranchSet(rawScope.allowedHeadBranches);

    return {
      owner,
      ownerKey: repositoryKey(owner),
      repo,
      repoKey: repositoryKey(repo),
      allowedOperations,
      ...(allowedBaseBranches === undefined ? {} : { allowedBaseBranches }),
      ...(allowedHeadBranches === undefined ? {} : { allowedHeadBranches }),
    };
  });
}

function normalizeAllowedOperations(
  values: unknown,
): ReadonlySet<GithubRestOperation> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new GithubRestAdapterError(
      "invalid_input",
      "GitHub REST repository scopes require allowedOperations.",
    );
  }

  const normalized = values.map((value) => {
    if (isGithubRestOperation(value)) {
      return value;
    }
    throw new GithubRestAdapterError(
      "invalid_input",
      "GitHub REST repository scope has an unsupported operation.",
    );
  });

  return new Set(normalized);
}

function optionalBranchSet(values: unknown): ReadonlySet<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new GithubRestAdapterError(
      "invalid_input",
      "GitHub REST branch scopes must be non-empty when configured.",
    );
  }

  return new Set(values.map(normalizeBranchName));
}

function normalizeMode(value: GithubRestAdapterMode): GithubRestAdapterMode {
  if (adapterModeKeys.has(value)) {
    return value;
  }
  throw new GithubRestAdapterError(
    "invalid_input",
    "GitHub REST adapter mode must be read or write.",
  );
}

function normalizeMethod(
  value: string,
  mode: GithubRestAdapterMode,
): GithubRestMethod {
  const method = value.trim().toUpperCase();
  if (mode === "read" && readMethods.has(method)) {
    return method as GithubRestMethod;
  }
  if (mode === "write" && writeMethods.has(method)) {
    return method as GithubRestMethod;
  }
  throw new GithubRestAdapterError(
    "invalid_method",
    `GitHub REST ${mode} adapter cannot use ${method}.`,
  );
}

function bodyForMethod(
  method: GithubRestMethod,
  value: unknown,
):
  | {
      readonly hash: Sha256Hash;
      readonly serialized: string;
    }
  | undefined {
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    if (value !== undefined) {
      throw new GithubRestAdapterError(
        "invalid_body",
        `${method} GitHub REST requests must not include a body.`,
      );
    }
    return undefined;
  }

  if (value === undefined) {
    return undefined;
  }
  assertJsonObject(
    value,
    "invalid_body",
    "GitHub REST body must be a JSON object.",
  );
  const bodyHash = canonicalObjectHash(value);
  return {
    hash: bodyHash,
    serialized: JSON.stringify(value),
  };
}

function normalizeSafeRequestHeaders(value: unknown): {
  readonly headers: Readonly<Record<string, string>>;
  readonly safeHeaderNames: readonly string[];
} {
  if (value === undefined) {
    return {
      headers: {},
      safeHeaderNames: [],
    };
  }

  assertRecord(
    value,
    "unsafe_header",
    "GitHub REST requestHeaders must be an object.",
  );
  const headers: Record<string, string> = {};
  const names: string[] = [];
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (
      name.length === 0 ||
      /[\r\n:]/u.test(name) ||
      unsafeHeaderNamePattern.test(name)
    ) {
      throw new GithubRestAdapterError(
        "unsafe_header",
        `GitHub REST header ${rawName} is not safe to carry.`,
      );
    }
    if (typeof rawValue !== "string" || /[\r\n]/u.test(rawValue)) {
      throw new GithubRestAdapterError(
        "unsafe_header",
        `GitHub REST header ${rawName} has an unsafe value.`,
      );
    }
    if (unsafeHeaderValuePattern.test(rawValue)) {
      throw new GithubRestAdapterError(
        "unsafe_header",
        `GitHub REST header ${rawName} may carry credentials.`,
      );
    }
    headers[name] = rawValue.trim();
    names.push(name);
  }

  return {
    headers,
    safeHeaderNames: [...new Set(names)].sort(),
  };
}

async function fetchGithubHashOnly(input: {
  readonly apiVersion: string;
  readonly body?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly method: GithubRestMethod;
  readonly maxResponseBytes: number;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly token?: string | undefined;
  readonly url: URL;
}): Promise<FetchResult> {
  if (typeof globalThis.fetch !== "function") {
    throw new GithubRestAdapterError(
      "missing_fetch",
      "globalThis.fetch is required for GitHub REST adapter execution.",
    );
  }

  let response: Response;
  try {
    response = await globalThis.fetch(input.url, {
      ...(input.body === undefined ? {} : { body: input.body }),
      headers: requestHeadersForFetch(input),
      method: input.method,
      redirect: "error",
    });
  } catch {
    throw new GithubRestAdapterError(
      "fetch_error",
      "GitHub REST fetch failed.",
    );
  }

  const declaredLength = contentLength(response.headers);
  if (declaredLength !== undefined && declaredLength > input.maxResponseBytes) {
    throw new GithubRestAdapterError(
      "response_too_large",
      "GitHub REST response exceeds maxResponseBytes.",
    );
  }

  const bodyHash =
    input.method === "HEAD"
      ? emptyBodyHash()
      : await hashResponseBody(response, input.maxResponseBytes);
  if (bodyHash === "response_too_large") {
    throw new GithubRestAdapterError(
      "response_too_large",
      "GitHub REST response exceeds maxResponseBytes.",
    );
  }

  const contentType = safeContentType(response.headers);
  return {
    status: "succeeded",
    response: {
      byteLength: bodyHash.byteLength,
      contentHash: bodyHash.contentHash,
      ...(contentType === undefined ? {} : { contentType }),
      statusCode: response.status,
    },
  };
}

function requestHeadersForFetch(input: {
  readonly apiVersion: string;
  readonly body?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly token?: string | undefined;
}): Headers {
  const headers = new Headers();
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", input.apiVersion);
  for (const [name, value] of Object.entries(input.requestHeaders)) {
    headers.set(name, value);
  }
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (input.token !== undefined) {
    headers.set("authorization", `Bearer ${input.token}`);
  }
  if (input.idempotencyKey !== undefined) {
    headers.set("idempotency-key", input.idempotencyKey);
  }
  return headers;
}

function receiptCandidateFor(input: {
  readonly capabilityId: string;
  readonly effectId: string;
  readonly observedAt: ISODateTimeString;
  readonly payload: GithubRestReceiptPayload;
  readonly receiptType: string;
  readonly runId: string;
}): ReceiptCandidate {
  const payload = input.payload as unknown as JsonObject;
  const payloadHash = canonicalObjectHash(payload);
  return {
    receiptId: `receipt_${sanitizeId(input.effectId)}`,
    effectId: input.effectId,
    runId: input.runId,
    capabilityId: input.capabilityId,
    receiptType: input.receiptType,
    status: input.payload.result === "succeeded" ? "succeeded" : "failed",
    payload,
    payloadHash,
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
    observedAt: input.observedAt,
  };
}

function observationCandidateFor(input: {
  readonly observedAt: ISODateTimeString;
  readonly observationType: string;
  readonly parsed: ParsedArgs;
  readonly response: GithubRestResponseMetadata;
  readonly runId: string;
}): ExternalStateObservationCandidate {
  const observedState = {
    method: input.parsed.method,
    resource: input.parsed.resource,
    response: responseMetadataJson(input.response),
    request: {
      safeHeaderNames: [...input.parsed.safeHeaderNames],
    },
    statusCode: input.response.statusCode,
    contentHash: input.response.contentHash,
    byteLength: input.response.byteLength,
    redaction: "content_hash_only",
  } satisfies JsonObject;
  const payloadHash = canonicalObjectHash(observedState);
  const observedAt = input.observedAt;
  const expiresAt = afterMilliseconds(
    observedAt,
    input.parsed.freshnessRequirementMs,
  );
  const evidenceId = `ev_github_obs_${hashId(input.parsed.resource)}`;

  return {
    observationId: `obs_github_${hashId(input.parsed.resource)}`,
    runId: input.runId,
    observationType: input.observationType,
    subjectType: "github_rest_resource",
    subjectId: `github_rest_${hashId(input.parsed.resource)}`,
    observedState,
    observedAt,
    expiresAt,
    payloadHash,
    evidence: [
      pendingEvidenceRef({
        evidenceId,
        kind: "external_observation",
        hash: payloadHash,
        observedAt,
        expiresAt,
        sensitivity: input.parsed.sensitivity,
        metadata: {
          redaction: "content_hash_only",
        },
      }),
    ],
  };
}

function successPayload(input: {
  readonly idempotencyKey?: string | undefined;
  readonly parsed: ParsedArgs;
  readonly response: GithubRestResponseMetadata;
}): GithubRestSuccessPayload {
  return {
    result: "succeeded",
    request: {
      method: input.parsed.method,
      operation: input.parsed.operation,
      resource: input.parsed.resource,
      safeHeaderNames: input.parsed.safeHeaderNames,
      ...(input.parsed.bodyHash === undefined
        ? {}
        : { bodyHash: input.parsed.bodyHash }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKeyHash: hashSecret(input.idempotencyKey) }),
    },
    response: input.response,
    statusCode: input.response.statusCode,
    redaction: "content_hash_only",
  };
}

function failurePayload(input: {
  readonly method?: string | undefined;
  readonly reason: GithubRestAdapterFailureReason;
  readonly resource?: JsonObject | undefined;
  readonly statusCode?: number | undefined;
}): GithubRestFailurePayload {
  return {
    result: "failed",
    reason: input.reason,
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    redaction: "content_hash_only",
  };
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

function pendingEvidenceRef(
  input: Omit<PendingEvidenceRef, "admissionStatus" | "pendingAdmissionToken">,
): PendingEvidenceRef {
  return {
    ...input,
    admissionStatus: "pending",
    pendingAdmissionToken: `pending_${sanitizeId(input.evidenceId)}`,
  };
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function emptyBodyHash(): HashBodyResult {
  return {
    byteLength: 0,
    contentHash:
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
}

function safeContentType(headers: Headers): string | undefined {
  const value = headers.get("content-type");
  if (value === null) {
    return undefined;
  }
  const [mediaType] = value.split(";");
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

function responseMetadataJson(
  metadata: GithubRestResponseMetadata,
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

function resourceIdentity(
  identity: JsonObject,
  resource: GithubRestResource,
): JsonObject {
  return {
    ...identity,
    operation: resource.operation,
    owner: resource.owner,
    repo: resource.repo,
    ...(resource.pullNumber === undefined
      ? {}
      : { pullNumber: resource.pullNumber }),
  } satisfies JsonObject;
}

function urlIdentity(url: URL): JsonObject {
  return {
    fragmentPresent: url.hash.length > 0,
    host: url.hostname.toLowerCase(),
    path: url.pathname,
    port: url.port,
    queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
    scheme: url.protocol.slice(0, -1),
  } satisfies JsonObject;
}

function assertGithubOwner(value: string): void {
  void normalizeGithubOwner(value);
}

function assertGithubRepo(value: string): void {
  void normalizeGithubRepo(value);
}

function normalizeGithubOwner(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)
  ) {
    throw new GithubRestAdapterError(
      "invalid_input",
      "GitHub REST repository owner scope is invalid.",
    );
  }
  return value;
}

function normalizeGithubRepo(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    value === "." ||
    value === ".." ||
    /[\r\n/%]/u.test(value)
  ) {
    throw new GithubRestAdapterError(
      "invalid_input",
      "GitHub REST repository name scope is invalid.",
    );
  }
  return value;
}

function normalizeBranchName(value: string): string {
  if (!isSafeBranchName(value)) {
    throw new GithubRestAdapterError(
      "invalid_input",
      "GitHub REST branch scope is invalid.",
    );
  }
  return value.trim();
}

function isSafeBranchName(value: string): boolean {
  const branch = value.trim();
  return (
    branch.length > 0 &&
    branch.length <= 250 &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !hasControlCharacter(branch)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function isGithubRestOperation(value: unknown): value is GithubRestOperation {
  return typeof value === "string" && githubRestOperations.has(value);
}

function repositoryKey(value: string): string {
  return value.toLowerCase();
}

function isPullNumber(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GithubRestAdapterError(
      "invalid_input",
      `GitHub REST ${key} must be a non-empty string.`,
    );
  }
  if (/[\r\n]/u.test(value)) {
    throw new GithubRestAdapterError(
      "invalid_input",
      `GitHub REST ${key} must not contain control-line characters.`,
    );
  }
  return value.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
    throw new GithubRestAdapterError(
      "invalid_input",
      `GitHub REST ${key} must be a positive integer.`,
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
  throw new GithubRestAdapterError(
    "invalid_input",
    "GitHub REST sensitivity is unsupported.",
  );
}

function assertRecord(
  value: unknown,
  code: GithubRestAdapterFailureReason,
  message: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GithubRestAdapterError(code, message);
  }
}

function assertJsonObject(
  value: unknown,
  code: GithubRestAdapterFailureReason,
  message: string,
): asserts value is JsonObject {
  assertRecord(value, code, message);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new GithubRestAdapterError(
      "invalid_input",
      `${label} contains unknown fields: ${unknownKeys.join(", ")}.`,
    );
  }
}

function hashSecret(value: string): Sha256Hash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashId(value: JsonObject): string {
  return canonicalObjectHash(value).replace(/^sha256:/u, "");
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
