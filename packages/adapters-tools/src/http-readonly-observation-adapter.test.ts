import {
  validateReceiptCandidate,
  validateEvidenceRef,
  validateExternalStateObservation,
  validateExternalStateObservationCandidate,
  validateFinalCandidate,
} from "@amca/contracts";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import type {
  CertifiedEffectRequest,
  EffectAdapterResult,
} from "@amca/effect-sdk";
import type { JsonObject, JsonValue } from "@amca/protocol";

import {
  HTTP_READONLY_DNS_REBINDING_CERTIFICATION,
  buildHttpReadonlyObservationCandidate,
  createHttpReadonlyObservationAdapter,
  HttpReadonlyObservationContractError,
  type HttpReadonlyObservationCandidateInput,
  type HttpReadonlyObservationFailureReason,
} from "./http-readonly-observation-adapter.js";

const observedAt = "2026-05-24T12:00:00.000Z";
const runId = "run_http_readonly_contract";
const commandId = "command_http_readonly_contract";
const observationType = "http_readonly.resource_snapshot";
const adapterId = "adapter.amca.http_readonly.fetch";
const capabilityId = "amca.http_readonly.observe_resource";
const toolId = "http_readonly.fetch";
const receiptType = "http_readonly.fetch";
const contentHash =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("http_readonly observation candidate contract", () => {
  it("http-readonly-get-candidate-created", () => {
    const candidate = buildHttpReadonlyObservationCandidate(validInput("GET"));

    expect(validateExternalStateObservationCandidate(candidate).success).toBe(
      true,
    );
    expect(candidate).toMatchObject({
      runId,
      observationType,
      subjectType: "http_resource",
      observedAt,
      evidence: [
        {
          admissionStatus: "pending",
          kind: "external_observation",
          sensitivity: "internal",
        },
      ],
    });
    expect(candidate.subjectId).toMatch(/^http_resource_[a-f0-9]{64}$/u);
    expect(candidate.observedState).toMatchObject({
      method: "GET",
      redaction: "content_hash_only",
      request: {
        safeHeaderNames: ["accept"],
      },
      response: {
        byteLength: 0,
        contentHash,
        contentType: "application/json",
        statusCode: 200,
      },
      resource: {
        fragmentPresent: false,
        host: "127.0.0.1",
        path: "/v1/status",
        port: "8080",
        queryKeys: ["page"],
        scheme: "http",
      },
    });
    expect(candidate.evidence[0]).not.toHaveProperty("sourceEventId");
    expect(candidate.evidence[0]?.pendingAdmissionToken).toBe(
      "pending_ev_http_obs_command_http_readonly_contract",
    );
  });

  it("http-readonly-head-candidate-created", () => {
    const candidate = buildHttpReadonlyObservationCandidate(validInput("HEAD"));

    expect(candidate.observedState).toMatchObject({
      method: "HEAD",
      response: {
        byteLength: 0,
        contentHash,
        statusCode: 200,
      },
    });
    expect(validateExternalStateObservationCandidate(candidate).success).toBe(
      true,
    );
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] satisfies readonly string[])(
    "http-readonly-write-method-blocked: %s",
    (method) => {
      expectContractError(
        () => buildHttpReadonlyObservationCandidate(validInput(method)),
        "invalid_method",
      );
    },
  );

  it("http-readonly-url-credentials-blocked", () => {
    expectContractError(
      () =>
        buildHttpReadonlyObservationCandidate({
          ...validInput("GET"),
          url: "https://user:password@example.com/v1/status",
        }),
      "url_credentials_forbidden",
    );
  });

  it.each([
    [{ authorization: "Bearer abc123" }],
    [{ cookie: "session=abc123" }],
    [{ "x-api-key": "abc123" }],
    [{ accept: "Bearer abc123" }],
  ] satisfies readonly [Readonly<Record<string, string>>][])(
    "http-readonly-unsafe-header-blocked: %j",
    (requestHeaders) => {
      expectContractError(
        () =>
          buildHttpReadonlyObservationCandidate({
            ...validInput("GET"),
            requestHeaders,
          }),
        "unsafe_header",
      );
    },
  );

  it("http-readonly-non-http-scheme-blocked", () => {
    expectContractError(
      () =>
        buildHttpReadonlyObservationCandidate({
          ...validInput("GET"),
          url: "file:///etc/passwd",
        }),
      "non_http_scheme",
    );
  });

  it.each([
    "http://127.0.0.1:8080/v1/status?api_key=secret",
    "http://127.0.0.1:8080/v1/status?page=token=secret",
  ])("http-readonly-unsafe-query-blocked: %s", (url) => {
    expectContractError(
      () =>
        buildHttpReadonlyObservationCandidate({
          ...validInput("GET"),
          url,
        }),
      "unsafe_query",
    );
  });

  it("http-readonly-raw-body-not-returned", () => {
    const headerValue = "text/x-phase40-header-value";
    const bodyValue = "phase40-secret-response-body";
    const candidate = buildHttpReadonlyObservationCandidate({
      ...validInput("GET"),
      requestHeaders: {
        accept: headerValue,
      },
    });

    expect(JSON.stringify(candidate)).not.toContain(headerValue);
    expect(JSON.stringify(candidate)).not.toContain(bodyValue);
    expect(candidate.observedState).toMatchObject({
      request: {
        safeHeaderNames: ["accept"],
      },
    });

    const inputWithBody = {
      ...validInput("GET"),
      body: bodyValue,
    };
    expectContractError(
      () => buildHttpReadonlyObservationCandidate(inputWithBody),
      "raw_body_not_allowed",
    );

    const inputWithResponseBody = {
      ...validInput("GET"),
      responseMetadata: {
        ...validInput("GET").responseMetadata,
        rawContent: bodyValue,
      },
    };
    expectContractError(
      () => buildHttpReadonlyObservationCandidate(inputWithResponseBody),
      "raw_body_not_allowed",
    );
  });

  it("http-readonly-oversized-response-metadata-blocked", () => {
    expectContractError(
      () =>
        buildHttpReadonlyObservationCandidate({
          ...validInput("GET"),
          maxResponseBytes: 8,
          responseMetadata: {
            ...validInput("GET").responseMetadata,
            byteLength: 9,
          },
        }),
      "response_too_large",
    );
  });

  it("http-readonly-pending-candidate-cannot-support-proof", () => {
    const candidate = buildHttpReadonlyObservationCandidate(validInput("GET"));
    const pendingEvidence = candidate.evidence[0];

    expect(pendingEvidence).toMatchObject({
      admissionStatus: "pending",
    });
    expect(pendingEvidence).not.toHaveProperty("sourceEventId");
    expect(validateEvidenceRef(pendingEvidence).success).toBe(false);
    expect(validateExternalStateObservation(candidate).success).toBe(false);

    const finalCandidateWithPendingEvidence = {
      kind: "final_candidate",
      candidateId: "candidate_http_pending_evidence",
      runId,
      claims: [
        {
          claimId: "claim_http_current_state",
          type: "current_state",
          statement: "The HTTP resource returned 200.",
          predicate: {
            kind: "current_state",
            subjectType: candidate.subjectType,
            subjectId: candidate.subjectId,
            property: "response.statusCode",
            operator: "equals",
            expectedValue: 200,
            observationType,
            freshnessRequirementMs: 60_000,
          },
          evidenceRefs: candidate.evidence,
          criticality: "medium",
        },
      ],
    };

    expect(
      validateFinalCandidate(finalCandidateWithPendingEvidence).success,
    ).toBe(false);
  });
});

describe("http_readonly real adapter", () => {
  it("certifies read-only external read authority", () => {
    const adapter = createHttpReadonlyObservationAdapter({
      adapterId,
      capabilityId,
      toolId,
      allowedOrigins: ["https://example.com"],
      receiptType,
      observationType,
      clock: () => observedAt,
    });

    expect(adapter.certification).toMatchObject({
      adapterKind: "external_read",
      sideEffectClass: "read",
      idempotency: "not_required",
      declaredReceiptTypes: [receiptType],
      declaredObservationTypes: [observationType],
    });
  });

  it("http-adapter-requires-base-url-allowlist", () => {
    expectContractError(
      () =>
        createHttpReadonlyObservationAdapter({
          adapterId,
          capabilityId,
          toolId,
          receiptType,
          observationType,
          clock: () => observedAt,
        }),
      "invalid_input",
    );

    expect(
      createHttpReadonlyObservationAdapter({
        adapterId,
        capabilityId,
        toolId,
        allowedOrigins: ["https://example.com"],
        receiptType,
        observationType,
        clock: () => observedAt,
      }).certification.adapterKind,
    ).toBe("external_read");
  });

  it("declares DNS rebinding as not certified", () => {
    expect(HTTP_READONLY_DNS_REBINDING_CERTIFICATION).toMatchObject({
      status: "not_certified",
      mitigation: "origin_allowlist_and_literal_destination_guards",
    });
  });

  it("performs GET through fetch and returns only hash metadata", async () => {
    const secretBody = "phase46-secret-response-body";
    const requestHeaderValue = "application/amca-phase46";

    await withHttpServer(
      {
        "/status": (request, response) => {
          expect(request.method).toBe("GET");
          expect(request.headers.accept).toBe(requestHeaderValue);
          response.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
          });
          response.end(secretBody);
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          server.url("/status?page=1"),
          localFixtureOptions(server, {
            requestHeaders: {
              accept: requestHeaderValue,
            },
          }),
        );
        const receiptCandidate = requiredReceiptCandidate(result);
        const observationCandidate = requiredObservationCandidate(result);

        expect(validateReceiptCandidate(receiptCandidate).success).toBe(true);
        expect(
          validateExternalStateObservationCandidate(observationCandidate)
            .success,
        ).toBe(true);
        expect(receiptCandidate.status).toBe("succeeded");
        expect(receiptCandidate.payload).toMatchObject({
          result: "observed",
          method: "GET",
          statusCode: 200,
          contentHash: sha256(secretBody),
          byteLength: Buffer.byteLength(secretBody),
          redaction: "content_hash_only",
        });
        expect(observationCandidate.observedState).toMatchObject({
          method: "GET",
          statusCode: 200,
          contentHash: sha256(secretBody),
          byteLength: Buffer.byteLength(secretBody),
          contentType: "text/plain",
          request: {
            safeHeaderNames: ["accept"],
          },
          response: {
            statusCode: 200,
            contentHash: sha256(secretBody),
            byteLength: Buffer.byteLength(secretBody),
            contentType: "text/plain",
          },
          resource: {
            host: "127.0.0.1",
            path: "/status",
            queryKeys: ["page"],
            scheme: "http",
          },
          redaction: "content_hash_only",
        });
        expect(observationCandidate.evidence[0]).toMatchObject({
          admissionStatus: "pending",
          kind: "external_observation",
          hash: observationCandidate.payloadHash,
        });
        expect(observationCandidate.evidence[0]).not.toHaveProperty(
          "sourceEventId",
        );
        expect(JSON.stringify(result)).not.toContain(secretBody);
        expect(JSON.stringify(result)).not.toContain(requestHeaderValue);
        expect(jsonKeys(result as unknown as JsonValue)).not.toEqual(
          expect.arrayContaining(["body", "rawBody", "rawContent", "text"]),
        );
      },
    );
  });

  it("performs HEAD without reading or inventing a body", async () => {
    await withHttpServer(
      {
        "/head": (_request, response) => {
          response.writeHead(204, {
            "content-length": "99",
            "content-type": "application/json",
          });
          response.end();
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          server.url("/head"),
          localFixtureOptions(server, {
            method: "HEAD",
          }),
        );
        const receiptCandidate = requiredReceiptCandidate(result);
        const observationCandidate = requiredObservationCandidate(result);

        expect(receiptCandidate.status).toBe("succeeded");
        expect(observationCandidate.observedState).toMatchObject({
          method: "HEAD",
          statusCode: 204,
          contentHash,
          byteLength: 0,
        });
      },
    );
  });

  it.each([
    ["POST", "invalid_method"],
    ["PUT", "invalid_method"],
    ["PATCH", "invalid_method"],
    ["DELETE", "invalid_method"],
  ] satisfies readonly (readonly [
    string,
    HttpReadonlyObservationFailureReason,
  ])[])("blocks write method %s before fetch", async (method, reason) => {
    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200);
          response.end("must-not-be-called");
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          server.url("/status"),
          localFixtureOptions(server, {
            method,
          }),
        );

        expectFailure(result, reason);
        expect(server.hits("/status")).toBe(0);
      },
    );
  });

  it.each([
    ["file:///tmp/secret", "non_http_scheme", "https://example.com"],
    [
      "http://user:password@127.0.0.1:8080/status",
      "url_credentials_forbidden",
      "http://127.0.0.1:8080",
    ],
    [
      "http://127.0.0.1:8080/status?api_key=secret",
      "unsafe_query",
      "http://127.0.0.1:8080",
    ],
    [
      "http://127.0.0.1:8080/status?q=token=secret",
      "unsafe_query",
      "http://127.0.0.1:8080",
    ],
  ] satisfies readonly (readonly [
    string,
    HttpReadonlyObservationFailureReason,
    string,
  ])[])("blocks unsafe URL %s before fetch", async (url, reason, origin) => {
    const result = await executeHttpRead(url, {
      allowedOrigins: [origin],
    });

    expectFailure(result, reason);
  });

  it("http-adapter-blocks-localhost-ssrf", async () => {
    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200);
          response.end("must-not-be-called");
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          `http://localhost:${String(server.port)}/status`,
          {
            allowedOrigins: [`http://localhost:${String(server.port)}`],
          },
        );

        expectFailure(result, "unsafe_destination");
        expect(server.hits("/status")).toBe(0);
      },
    );
  });

  it("http-adapter-blocks-127-0-0-1", async () => {
    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200);
          response.end("must-not-be-called");
        },
      },
      async (server) => {
        const result = await executeHttpRead(server.url("/status"), {
          allowedOrigins: [server.origin],
        });

        expectFailure(result, "unsafe_destination");
        expect(server.hits("/status")).toBe(0);
      },
    );
  });

  it.each([
    "http://10.0.0.1/status",
    "http://172.16.0.1/status",
    "http://172.31.255.255/status",
    "http://192.168.1.10/status",
  ])("http-adapter-blocks-private-ip-ranges: %s", async (url) => {
    const result = await executeHttpRead(url, {
      allowedOrigins: [new URL(url).origin],
    });

    expectFailure(result, "unsafe_destination");
  });

  it("http-adapter-blocks-169-254-169-254", async () => {
    const url = "http://169.254.169.254/latest/meta-data";
    const result = await executeHttpRead(url, {
      allowedOrigins: [new URL(url).origin],
    });

    expectFailure(result, "unsafe_destination");
  });

  it.each([
    "http://169.254.1.1/status",
    "http://[fe80::1]/status",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://metadata/latest/meta-data",
  ])("http-adapter-blocks-link-local-and-metadata-hosts: %s", async (url) => {
    const result = await executeHttpRead(url, {
      allowedOrigins: [new URL(url).origin],
    });

    expectFailure(result, "unsafe_destination");
  });

  it.each([
    [{ authorization: "Bearer abc123" }],
    [{ cookie: "session=abc123" }],
    [{ "x-api-key": "abc123" }],
    [{ accept: "Bearer abc123" }],
  ] satisfies readonly [Readonly<Record<string, string>>][])(
    "blocks unsafe request headers before fetch: %j",
    async (requestHeaders) => {
      await withHttpServer(
        {
          "/status": (_request, response) => {
            response.writeHead(200);
            response.end("must-not-be-called");
          },
        },
        async (server) => {
          const result = await executeHttpRead(server.url("/status"), {
            ...localFixtureOptions(server, {
              requestHeaders,
            }),
          });

          expectFailure(result, "unsafe_header");
          expect(server.hits("/status")).toBe(0);
        },
      );
    },
  );

  it("follows same-origin redirects and reports the final resource", async () => {
    const finalBody = "phase46-redirect-final";

    await withHttpServer(
      {
        "/redirect": (_request, response) => {
          response.writeHead(302, {
            location: "/final?page=2",
          });
          response.end();
        },
        "/final": (_request, response) => {
          response.writeHead(200, {
            "content-type": "text/plain",
          });
          response.end(finalBody);
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          server.url("/redirect"),
          localFixtureOptions(server),
        );
        const receiptCandidate = requiredReceiptCandidate(result);
        const observationCandidate = requiredObservationCandidate(result);

        expect(receiptCandidate.status).toBe("succeeded");
        expect(receiptCandidate.payload).toMatchObject({
          redirects: 1,
          contentHash: sha256(finalBody),
        });
        expect(observationCandidate.observedState).toMatchObject({
          resource: {
            path: "/final",
            queryKeys: ["page"],
          },
        });
        expect(server.hits("/redirect")).toBe(1);
        expect(server.hits("/final")).toBe(1);
      },
    );
  });

  it("blocks redirects that change host or target unsafe URLs", async () => {
    await withHttpServer(
      {
        "/host-redirect": (_request, response, server) => {
          response.writeHead(302, {
            location: `http://localhost:${String(server.port)}/target`,
          });
          response.end();
        },
        "/secret-redirect": (_request, response) => {
          response.writeHead(302, {
            location: "/target?token=secret",
          });
          response.end();
        },
        "/metadata-redirect": (_request, response) => {
          response.writeHead(302, {
            location: "//169.254.169.254/latest/meta-data",
          });
          response.end();
        },
        "/target": (_request, response) => {
          response.writeHead(200);
          response.end("must-not-be-called");
        },
      },
      async (server) => {
        expectFailure(
          await executeHttpRead(
            server.url("/host-redirect"),
            localFixtureOptions(server),
          ),
          "unsafe_redirect",
        );
        expectFailure(
          await executeHttpRead(
            server.url("/secret-redirect"),
            localFixtureOptions(server),
          ),
          "unsafe_redirect",
        );
        expectFailure(
          await executeHttpRead(
            server.url("/metadata-redirect"),
            localFixtureOptions(server),
          ),
          "unsafe_redirect",
        );
        expect(server.hits("/target")).toBe(0);
      },
    );
  });

  it("http-adapter-revalidates-redirect-target-after-resolution", async () => {
    await withHttpServer(
      {
        "/redirect": (_request, response) => {
          response.writeHead(302, {
            location: "//169.254.169.254/latest/meta-data",
          });
          response.end();
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          server.url("/redirect"),
          localFixtureOptions(server),
        );

        expectFailure(result, "unsafe_redirect");
      },
    );
  });

  it("http-adapter-timeout-fails-closed", async () => {
    await withHttpServer(
      {
        "/slow": (_request, response) => {
          const timer = setTimeout(() => {
            response.writeHead(200);
            response.end("late-body-must-not-be-proof");
          }, 100);
          timer.unref();
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          server.url("/slow"),
          localFixtureOptions(server, {
            timeoutMs: 5,
          }),
        );

        expectFailure(result, "timeout");
      },
    );
  });

  it("http-adapter-non-2xx-cannot-support-proof-before-admission", async () => {
    const secretBody = "phase61-non-2xx-body";

    await withHttpServer(
      {
        "/not-found": (_request, response) => {
          response.writeHead(404, {
            "content-type": "text/plain",
          });
          response.end(secretBody);
        },
      },
      async (server) => {
        const result = await executeHttpRead(
          server.url("/not-found"),
          localFixtureOptions(server),
        );
        const receiptCandidate = requiredReceiptCandidate(result);

        expectFailure(result, "non_success_status");
        expect(receiptCandidate.payload).toMatchObject({
          result: "failed",
          statusCode: 404,
        });
        expect(validateReceiptCandidate(receiptCandidate).success).toBe(true);
        expect(validateEvidenceRef(receiptCandidate.evidence[0]).success).toBe(
          false,
        );
        expect(JSON.stringify(result)).not.toContain(secretBody);
      },
    );
  });

  it("blocks oversized responses without observation evidence or raw body leakage", async () => {
    const oversizedBody = "phase46-oversized-secret-body";

    await withHttpServer(
      {
        "/declared-too-large": (_request, response) => {
          response.writeHead(200, {
            "content-length": String(Buffer.byteLength(oversizedBody)),
          });
          response.end(oversizedBody);
        },
        "/stream-too-large": (_request, response) => {
          response.writeHead(200);
          response.end(oversizedBody);
        },
      },
      async (server) => {
        const declared = await executeHttpRead(
          server.url("/declared-too-large"),
          localFixtureOptions(server, {
            maxResponseBytes: 4,
          }),
        );
        const streamed = await executeHttpRead(
          server.url("/stream-too-large"),
          localFixtureOptions(server, {
            maxResponseBytes: 4,
          }),
        );

        expectFailure(declared, "response_too_large");
        expectFailure(streamed, "response_too_large");
        expect(JSON.stringify(declared)).not.toContain(oversizedBody);
        expect(JSON.stringify(streamed)).not.toContain(oversizedBody);
      },
    );
  });
});

function validInput(method: string): HttpReadonlyObservationCandidateInput {
  return {
    runId,
    commandId,
    url: "http://127.0.0.1:8080/v1/status?page=1",
    method,
    observedAt,
    observationType,
    requestHeaders: {
      accept: "application/json",
    },
    responseMetadata: {
      statusCode: 200,
      contentHash,
      byteLength: 0,
      contentType: "application/json",
    },
  };
}

function expectContractError(
  operation: () => unknown,
  code: HttpReadonlyObservationFailureReason,
): void {
  expect(operation).toThrow(HttpReadonlyObservationContractError);

  try {
    operation();
  } catch (error) {
    expect((error as HttpReadonlyObservationContractError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HttpReadonlyObservationContractError ${code}.`);
}

interface HttpServerFixture {
  readonly origin: string;
  readonly port: number;
  readonly hits: (path: string) => number;
  readonly url: (pathAndQuery: string) => string;
}

type HttpRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  server: HttpServerFixture,
) => void;

interface ExecuteHttpReadOptions {
  readonly method?: string | undefined;
  readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly allowLocalNetworkForTestingOnly?: boolean | undefined;
}

async function withHttpServer(
  routes: Readonly<Record<string, HttpRoute>>,
  callback: (server: HttpServerFixture) => Promise<void>,
): Promise<void> {
  const hitCounts = new Map<string, number>();
  const fixtureRef: { current?: HttpServerFixture } = {};
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    hitCounts.set(pathname, (hitCounts.get(pathname) ?? 0) + 1);
    const route = routes[pathname];

    if (route === undefined || fixtureRef.current === undefined) {
      response.writeHead(404);
      response.end("missing");
      return;
    }

    route(request, response, fixtureRef.current);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const fixture: HttpServerFixture = {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    hits: (path) => hitCounts.get(path) ?? 0,
    url: (pathAndQuery) =>
      `http://127.0.0.1:${String(address.port)}${pathAndQuery}`,
  };
  fixtureRef.current = fixture;

  try {
    await callback(fixture);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }
}

async function executeHttpRead(
  url: string,
  options: ExecuteHttpReadOptions = {},
): Promise<EffectAdapterResult> {
  const adapter = createHttpReadonlyObservationAdapter({
    adapterId,
    capabilityId,
    toolId,
    allowedOrigins: options.allowedOrigins ?? ["https://example.com"],
    allowLocalNetworkForTestingOnly:
      options.allowLocalNetworkForTestingOnly === true,
    receiptType,
    observationType,
    clock: () => observedAt,
    ...(options.maxRedirects === undefined
      ? {}
      : { maxRedirects: options.maxRedirects }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });

  return adapter.execute(requestFor(url, options), { now: () => observedAt });
}

function localFixtureOptions(
  server: HttpServerFixture,
  options: ExecuteHttpReadOptions = {},
): ExecuteHttpReadOptions {
  return {
    ...options,
    allowedOrigins: [server.origin],
    allowLocalNetworkForTestingOnly: true,
  };
}

function requestFor(
  url: string,
  options: ExecuteHttpReadOptions = {},
): CertifiedEffectRequest {
  const method = options.method ?? "GET";
  const args: JsonObject = {
    url,
    method,
    ...(options.requestHeaders === undefined
      ? {}
      : { requestHeaders: options.requestHeaders }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
  };

  return {
    toolCommand: {
      kind: "tool_command_request",
      commandId: `command_http_${sanitizeId(method)}_${sanitizeId(url)}`,
      runId,
      capabilityId,
      toolId,
      args,
      sideEffectClass: "read",
    },
    effectRequest: {
      effectId: `effect_http_${sanitizeId(method)}_${sanitizeId(url)}`,
      commandId: `command_http_${sanitizeId(method)}_${sanitizeId(url)}`,
      runId,
      capabilityId,
      toolId,
      args,
      sideEffectClass: "read",
      requestedAt: observedAt,
    },
    capability: {
      schemaVersion: 1,
      capabilityId,
      profile: "standard",
      sideEffectClass: "read",
      inputSchema: {
        type: "object",
      },
      receiptSchema: {
        type: "object",
      },
      evidence: [
        {
          evidenceKind: "effect_receipt",
          receiptType,
        },
        {
          evidenceKind: "external_observation",
          observationType,
        },
      ],
      supportedClaims: [],
      proofRules: [],
    },
  };
}

function requiredObservationCandidate(
  result: EffectAdapterResult,
): NonNullable<EffectAdapterResult["externalStateObservationCandidate"]> {
  if (result.externalStateObservationCandidate === undefined) {
    throw new Error("Expected HTTP readonly adapter to emit an observation.");
  }
  return result.externalStateObservationCandidate;
}

function requiredReceiptCandidate(
  result: EffectAdapterResult,
): NonNullable<EffectAdapterResult["receiptCandidate"]> {
  if (result.receiptCandidate === undefined) {
    throw new Error("Expected HTTP readonly adapter to emit a receipt.");
  }
  return result.receiptCandidate;
}

function expectFailure(
  result: EffectAdapterResult,
  reason: HttpReadonlyObservationFailureReason,
): void {
  const receiptCandidate = requiredReceiptCandidate(result);

  expect(receiptCandidate.status).toBe("failed");
  expect(result.externalStateObservationCandidate).toBeUndefined();
  expect(reasonOf(receiptCandidate.payload)).toBe(reason);
}

function reasonOf(payload: JsonObject): HttpReadonlyObservationFailureReason {
  const reason = payload.reason;
  if (typeof reason !== "string") {
    throw new Error("Expected HTTP failure payload to contain reason.");
  }
  return reason as HttpReadonlyObservationFailureReason;
}

function jsonKeys(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => jsonKeys(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...jsonKeys(item),
    ]);
  }
  return [];
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
