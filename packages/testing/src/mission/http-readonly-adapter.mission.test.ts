import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { createHttpReadonlyObservationAdapter } from "@amca/adapters-tools";
import type { CapabilityContract } from "@amca/capabilities";
import {
  EffectBrokerError,
  type EffectDispatchResult,
  InMemoryEffectBroker,
} from "@amca/effect-broker";
import type { EffectAdapter } from "@amca/effect-sdk";
import { LocalRunHarness } from "@amca/harness";
import type {
  Claim,
  EvidenceRef,
  ExternalStateObservation,
  JsonObject,
  JsonValue,
  PendingEvidenceRef,
  ToolCommandRequest,
} from "@amca/protocol";
import { replayRunEvents } from "@amca/replay";
import { describe, expect, it } from "vitest";

import {
  candidateWith,
  eventTypes,
  GENERATED_AT,
  STARTED_AT,
} from "./mission-helpers.js";

const now = "2026-05-24T12:00:00.000Z";
const reevaluatedAt = "2026-05-24T12:00:15.000Z";
const capabilityId = "amca.http_readonly.observe_resource";
const toolId = "http_readonly.fetch";
const receiptType = "http_readonly.fetch";
const observationType = "http_readonly.resource_snapshot";

describe("Mission HTTP readonly adapter conformance", () => {
  it("requires explicit broker opt-in for the external_read adapter kind", async () => {
    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200);
          response.end("ok");
        },
      },
      async (server) => {
        const fixture = localHttpFixture(server);

        expect(
          () =>
            new InMemoryEffectBroker({
              adapters: [fixture.adapter],
              capabilities: [fixture.capability],
              clock: () => now,
            }),
        ).toThrow(EffectBrokerError);

        await expect(
          allowedBroker(fixture).dispatch(
            fixture.command(server.url("/status")),
          ),
        ).resolves.toMatchObject({
          receiptCandidate: {
            receiptType,
            status: "succeeded",
          },
        });
      },
    );
  });

  it("releases current-state HTTP claims only after harness/kernel observation admission", async () => {
    const secretBody = "phase46-mission-http-body";

    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200, {
            "content-type": "text/plain",
          });
          response.end(secretBody);
        },
      },
      async (server) => {
        const fixture = localHttpFixture(server);
        const harness = governedHarness(fixture);
        harness.startRun({
          occurredAt: STARTED_AT,
          profile: "standard",
        });

        const dispatch = await harness.dispatchToolCommand(
          fixture.command(server.url("/status?page=1")),
        );
        const pendingObservation =
          dispatch.brokerResult.externalStateObservationCandidate;
        const admittedObservation = dispatch.recordedExternalStateObservation;

        if (
          pendingObservation === undefined ||
          admittedObservation === undefined
        ) {
          throw new Error(
            "HTTP readonly dispatch must produce an observation.",
          );
        }

        expect(pendingObservation.evidence[0]).toMatchObject({
          admissionStatus: "pending",
        });
        expect(pendingObservation.evidence[0]).not.toHaveProperty(
          "sourceEventId",
        );
        expect(admittedObservation.evidence[0]).toMatchObject({
          admissionStatus: "admitted",
          sourceEventId: dispatch.externalStateObservationEvent?.eventId,
        });
        expect(eventTypes(harness.kernel)).toContain("ExternalStateObserved");

        const evidenceRef = singleEvidenceRef(admittedObservation);
        const result = harness.submitFinalCandidate(
          candidateWith(
            fixture.runId,
            httpStatusClaim(evidenceRef, admittedObservation),
          ),
          {
            generatedAt: GENERATED_AT,
            occurredAt: GENERATED_AT,
          },
        );

        expect(result.decision.status).toBe("released");
        expect(eventTypes(harness.kernel)).toContain("FinalReleased");
        expect(JSON.stringify(dispatch)).not.toContain(secretBody);
      },
    );
  });

  it("blocks broker-only pending HTTP observation candidates before admission", async () => {
    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200);
          response.end("ok");
        },
      },
      async (server) => {
        const fixture = localHttpFixture(server);
        const command = fixture.command(server.url("/status"));
        const dispatch = await allowedBroker(fixture).dispatch(command);
        const pendingObservation = dispatch.externalStateObservationCandidate;

        if (pendingObservation === undefined) {
          throw new Error("HTTP readonly broker dispatch must observe state.");
        }
        const pendingEvidenceRef = pendingObservation.evidence[0];
        if (pendingEvidenceRef === undefined) {
          throw new Error("HTTP readonly observation must carry evidence.");
        }

        expect(pendingEvidenceRef.admissionStatus).toBe("pending");
        expect(pendingEvidenceRef).not.toHaveProperty("sourceEventId");

        const harness = new LocalRunHarness({
          runId: fixture.runId,
          clock: () => now,
        });
        harness.startRun({
          occurredAt: STARTED_AT,
          profile: "standard",
        });

        const result = harness.submitFinalCandidate(
          candidateWith(
            fixture.runId,
            httpStatusClaim(
              expectedObservationEvidenceRef(
                pendingEvidenceRef,
                command.commandId,
              ),
              pendingObservation,
            ),
          ),
          {
            generatedAt: GENERATED_AT,
            occurredAt: GENERATED_AT,
          },
        );

        expect(result.decision.status).toBe("blocked");
        expect(result.finalReleasedEvent).toBeUndefined();
        expect(result.proof.blockingMismatches).toContainEqual(
          expect.objectContaining({
            type: "unsupported_claim",
            blocking: true,
          }),
        );
        expect(eventTypes(harness.kernel)).not.toContain(
          "ExternalStateObserved",
        );
        expect(eventTypes(harness.kernel)).not.toContain("FinalReleased");
      },
    );
  });

  it("blocks writes, unsafe URLs, unsafe redirects, and oversized bodies", async () => {
    const oversizedBody = "phase46-mission-oversized-secret";

    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200);
          response.end("ok");
        },
        "/host-redirect": (_request, response, server) => {
          response.writeHead(302, {
            location: `http://localhost:${String(server.port)}/target`,
          });
          response.end();
        },
        "/target": (_request, response) => {
          response.writeHead(200);
          response.end("must-not-be-called");
        },
        "/too-large": (_request, response) => {
          response.writeHead(200, {
            "content-length": String(Buffer.byteLength(oversizedBody)),
          });
          response.end(oversizedBody);
        },
      },
      async (server) => {
        const fixture = localHttpFixture(server);
        const broker = allowedBroker(fixture);

        await expectBrokerError(
          broker.dispatch({
            ...fixture.command(server.url("/status")),
            commandId: "command_http_readonly_write_attempt",
            idempotencyKey: "http-readonly-write-attempt",
            sideEffectClass: "idempotent_write",
          }),
          "side_effect_class_mismatch",
        );

        await expectNotSuccessfulEvidence(
          broker.dispatch(
            fixture.command(server.url("/status"), {
              method: "POST",
            }),
          ),
          "invalid_method",
        );
        await expectNotSuccessfulEvidence(
          broker.dispatch(
            fixture.command("file:///tmp/secret", {
              commandId: "command_http_file_scheme",
            }),
          ),
          "non_http_scheme",
        );
        await expectNotSuccessfulEvidence(
          broker.dispatch(
            fixture.command(server.url("/status?api_key=secret"), {
              commandId: "command_http_unsafe_query",
            }),
          ),
          "unsafe_query",
        );
        await expectNotSuccessfulEvidence(
          broker.dispatch(fixture.command(server.url("/host-redirect"))),
          "unsafe_redirect",
        );
        await expectNotSuccessfulEvidence(
          broker.dispatch(
            fixture.command(server.url("/too-large"), {
              commandId: "command_http_oversized",
              maxResponseBytes: 4,
            }),
          ),
          "response_too_large",
        );

        expect(server.hits("/target")).toBe(0);
      },
    );
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
        const localhostOrigin = `http://localhost:${String(server.port)}`;
        const fixture = httpFixture({
          allowedOrigins: [localhostOrigin],
        });
        const broker = allowedBroker(fixture);

        await expectNotSuccessfulEvidence(
          broker.dispatch(
            fixture.command(`${localhostOrigin}/status`, {
              commandId: "command_http_localhost_ssrf",
            }),
          ),
          "unsafe_destination",
        );
        expect(server.hits("/status")).toBe(0);
      },
    );
  });

  it("http-adapter-non-2xx-cannot-support-proof-before-admission", async () => {
    const secretBody = "phase61-mission-non-2xx-body";

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
        const fixture = localHttpFixture(server);
        const harness = governedHarness(fixture);
        harness.startRun({
          occurredAt: STARTED_AT,
          profile: "standard",
        });

        const dispatch = await harness.dispatchToolCommand(
          fixture.command(server.url("/not-found"), {
            commandId: "command_http_non_2xx_current_state",
          }),
        );

        expect(dispatch.recordedReceipt.status).toBe("failed");
        expect(dispatch.brokerResult.receiptCandidate.payload).toMatchObject({
          result: "failed",
          reason: "non_success_status",
          statusCode: 404,
        });
        expect(dispatch.brokerResult.externalStateObservationCandidate).toBe(
          undefined,
        );
        expect(dispatch.recordedExternalStateObservation).toBeUndefined();

        const receiptEvidence = dispatch.recordedReceipt.evidence[0];
        if (receiptEvidence === undefined) {
          throw new Error("HTTP failed receipt must carry evidence.");
        }

        const result = harness.submitFinalCandidate(
          candidateWith(
            fixture.runId,
            httpStatusClaim(receiptEvidence, {
              subjectType: "http_resource",
              subjectId: "http_resource_non_2xx",
              observedState: {
                statusCode: 404,
              },
            }),
          ),
          {
            generatedAt: GENERATED_AT,
            occurredAt: GENERATED_AT,
          },
        );

        expect(result.decision.status).toBe("blocked");
        expect(result.finalReleasedEvent).toBeUndefined();
        expect(result.proof.blockingMismatches).toContainEqual(
          expect.objectContaining({
            type: "missing_evidence",
            blocking: true,
          }),
        );
        expect(eventTypes(harness.kernel)).not.toContain(
          "ExternalStateObserved",
        );
        expect(eventTypes(harness.kernel)).not.toContain("FinalReleased");
        expect(JSON.stringify(dispatch)).not.toContain(secretBody);
      },
    );
  });

  it("does not expose raw response bodies or request header values", async () => {
    const secretBody = "phase46-mission-secret-body";
    const headerValue = "application/amca-mission-secret";

    await withHttpServer(
      {
        "/status": (request, response) => {
          expect(request.headers.accept).toBe(headerValue);
          response.writeHead(200, {
            "content-type": "text/plain",
          });
          response.end(secretBody);
        },
      },
      async (server) => {
        const fixture = localHttpFixture(server);
        const dispatch = await allowedBroker(fixture).dispatch(
          fixture.command(server.url("/status"), {
            requestHeaders: {
              accept: headerValue,
            },
          }),
        );

        expect(dispatch.receiptCandidate.status).toBe("succeeded");
        const adapterEvidenceOutput = {
          receiptCandidate: dispatch.receiptCandidate,
          externalStateObservationCandidate:
            dispatch.externalStateObservationCandidate,
        };
        expect(JSON.stringify(adapterEvidenceOutput)).not.toContain(secretBody);
        expect(JSON.stringify(adapterEvidenceOutput)).not.toContain(
          headerValue,
        );
        expect(
          jsonKeys(adapterEvidenceOutput as unknown as JsonValue),
        ).not.toEqual(
          expect.arrayContaining(["body", "rawBody", "rawContent", "text"]),
        );
      },
    );
  });

  it("replays and re-evaluates admitted HTTP observations without redispatching", async () => {
    await withHttpServer(
      {
        "/status": (_request, response) => {
          response.writeHead(200);
          response.end("ok");
        },
      },
      async (server) => {
        const fixture = localHttpFixture(server);
        const counted = adapterWithExecutionCount(fixture.adapter);
        const harness = governedHarness({
          ...fixture,
          adapter: counted.adapter,
        });
        harness.startRun({
          occurredAt: STARTED_AT,
          profile: "standard",
        });

        const dispatch = await harness.dispatchToolCommand(
          fixture.command(server.url("/status")),
        );
        const observation = dispatch.recordedExternalStateObservation;
        if (observation === undefined) {
          throw new Error("HTTP readonly harness must admit an observation.");
        }
        const evidenceRef = singleEvidenceRef(observation);
        const finalCandidate = candidateWith(
          fixture.runId,
          httpStatusClaim(evidenceRef, observation),
        );

        const released = harness.submitFinalCandidate(finalCandidate, {
          generatedAt: GENERATED_AT,
          occurredAt: GENERATED_AT,
        });
        const beforeReplay = eventTypes(harness.kernel);

        expect(released.decision.status).toBe("released");
        expect(harness.replay().events.map((event) => event.type)).toEqual(
          beforeReplay,
        );
        expect(
          replayRunEvents({ events: harness.kernel.events() }),
        ).toMatchObject({
          status: "passed",
          runId: fixture.runId,
          replayedDecision: {
            status: "released",
          },
        });
        expect(counted.calls()).toBe(1);

        const reevaluated = harness.reevaluateFinalCandidate(finalCandidate, {
          generatedAt: reevaluatedAt,
          occurredAt: reevaluatedAt,
        });

        expect(reevaluated.decision.status).toBe("released");
        expect(counted.calls()).toBe(1);
      },
    );
  });

  it("does not expose proof, release, or admission authority on the adapter object", () => {
    const adapter = createHttpReadonlyObservationAdapter({
      adapterId: "adapter.amca.http_readonly.fetch",
      capabilityId,
      toolId,
      allowedOrigins: ["https://example.com"],
      receiptType,
      observationType,
      clock: () => now,
    });
    const forbiddenAuthorityMethods = [
      "admitObservation",
      "admitReceipt",
      "decideRelease",
      "evaluateProof",
      "recordEffectReceipt",
      "recordExternalStateObservation",
      "release",
      "submitFinalCandidate",
    ];
    const adapterSurface = adapter as unknown as Record<string, unknown>;

    for (const method of forbiddenAuthorityMethods) {
      expect(adapterSurface[method], `adapter must not expose ${method}`).toBe(
        undefined,
      );
    }
    expect(typeof adapterSurface.execute).toBe("function");
  });
});

interface HttpFixture {
  readonly adapter: EffectAdapter;
  readonly capability: CapabilityContract;
  readonly runId: string;
  readonly command: (
    url: string,
    options?: {
      readonly commandId?: string | undefined;
      readonly method?: string | undefined;
      readonly maxResponseBytes?: number | undefined;
      readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
    },
  ) => ToolCommandRequest;
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

interface HttpFixtureOptions {
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly allowLocalNetworkForTestingOnly?: boolean | undefined;
}

function localHttpFixture(server: HttpServerFixture): HttpFixture {
  return httpFixture({
    allowedOrigins: [server.origin],
    allowLocalNetworkForTestingOnly: true,
  });
}

function httpFixture(options: HttpFixtureOptions = {}): HttpFixture {
  const runId = `mission_http_readonly_${String(Date.now())}`;
  return {
    adapter: createHttpReadonlyObservationAdapter({
      adapterId: "adapter.amca.http_readonly.fetch",
      capabilityId,
      toolId,
      allowedOrigins: options.allowedOrigins ?? ["https://example.com"],
      allowLocalNetworkForTestingOnly:
        options.allowLocalNetworkForTestingOnly === true,
      receiptType,
      observationType,
      clock: () => now,
    }),
    capability: httpCapability(),
    runId,
    command: (url, options = {}) =>
      httpCommand(runId, url, {
        commandId: options.commandId,
        method: options.method,
        maxResponseBytes: options.maxResponseBytes,
        requestHeaders: options.requestHeaders,
      }),
  };
}

function allowedBroker(fixture: HttpFixture): InMemoryEffectBroker {
  return new InMemoryEffectBroker({
    adapters: [fixture.adapter],
    capabilities: [fixture.capability],
    allowedAdapterKinds: ["external_read"],
    clock: () => now,
  });
}

function governedHarness(fixture: HttpFixture): LocalRunHarness {
  return new LocalRunHarness({
    runId: fixture.runId,
    clock: () => now,
    brokerOptions: {
      adapters: [fixture.adapter],
      capabilities: [fixture.capability],
      allowedAdapterKinds: ["external_read"],
      clock: () => now,
    },
  });
}

function httpCapability(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId,
    profile: "standard",
    sideEffectClass: "read",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        requestHeaders: { type: "object" },
      },
      required: ["url", "method"],
      additionalProperties: false,
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
    supportedClaims: [
      {
        claimType: "current_state",
        predicateKind: "current_state",
        observationType,
        supportedOperators: ["equals"],
        maximumFreshnessRequirementMs: 300_000,
      },
    ],
    proofRules: [],
    metadata: {
      authorityBoundary: "governed_http_readonly",
    },
  };
}

function httpCommand(
  runId: string,
  url: string,
  options: {
    readonly commandId?: string | undefined;
    readonly method?: string | undefined;
    readonly maxResponseBytes?: number | undefined;
    readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
  } = {},
): ToolCommandRequest {
  const method = options.method ?? "GET";
  const args: JsonObject = {
    url,
    method,
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.requestHeaders === undefined
      ? {}
      : { requestHeaders: options.requestHeaders }),
  };
  const commandId =
    options.commandId ?? `command_http_readonly_${sha256(url).slice(7, 19)}`;

  return {
    kind: "tool_command_request",
    commandId,
    runId,
    capabilityId,
    toolId,
    args,
    sideEffectClass: "read",
  };
}

function httpStatusClaim(
  evidenceRef: EvidenceRef,
  observation: ExternalStateObservation | ObservationLike,
): Claim {
  return {
    claimId: "claim_http_status_current",
    type: "current_state",
    statement: "HTTP resource status matches the observed read.",
    predicate: {
      kind: "current_state",
      subjectType: observation.subjectType,
      subjectId: observation.subjectId,
      property: "statusCode",
      operator: "equals",
      expectedValue: numberField(observation.observedState, "statusCode"),
      observationType,
      freshnessRequirementMs: 60_000,
    },
    evidenceRefs: [evidenceRef],
    criticality: "medium",
  };
}

interface ObservationLike {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly observedState: JsonObject;
}

function expectedObservationEvidenceRef(
  pendingEvidenceRef: PendingEvidenceRef,
  commandId: string,
): EvidenceRef {
  return {
    evidenceId: pendingEvidenceRef.evidenceId,
    kind: pendingEvidenceRef.kind,
    sourceEventId: observationEventIdForCommand(commandId),
    hash: pendingEvidenceRef.hash,
    observedAt: pendingEvidenceRef.observedAt,
    sensitivity: pendingEvidenceRef.sensitivity,
    ...(pendingEvidenceRef.artifactUri === undefined
      ? {}
      : { artifactUri: pendingEvidenceRef.artifactUri }),
    ...(pendingEvidenceRef.expiresAt === undefined
      ? {}
      : { expiresAt: pendingEvidenceRef.expiresAt }),
    ...(pendingEvidenceRef.metadata === undefined
      ? {}
      : { metadata: pendingEvidenceRef.metadata }),
  };
}

function singleEvidenceRef(observation: ExternalStateObservation): EvidenceRef {
  const [evidenceRef] = observation.evidence;
  if (evidenceRef === undefined) {
    throw new Error("Expected HTTP observation evidence.");
  }
  return evidenceRef;
}

async function expectNotSuccessfulEvidence(
  dispatch: Promise<EffectDispatchResult>,
  reason: string,
): Promise<void> {
  const result = await dispatch;
  expect(result.receiptCandidate.status).toBe("failed");
  expect(result.externalStateObservationCandidate).toBeUndefined();
  expect(result.receiptCandidate.payload).toMatchObject({
    result: "failed",
    reason,
  });
}

async function expectBrokerError(
  promise: Promise<unknown>,
  code: EffectBrokerError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "EffectBrokerError",
    code,
  });
}

function adapterWithExecutionCount(adapter: EffectAdapter): {
  readonly adapter: EffectAdapter;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    adapter: {
      ...adapter,
      execute: async (request, context) => {
        calls += 1;
        return adapter.execute(request, context);
      },
    },
    calls: () => calls,
  };
}

function numberField(object: JsonObject, field: string): number {
  const value = object[field];
  if (typeof value !== "number") {
    throw new Error(`Expected observedState.${field} to be a number.`);
  }
  return value;
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

function observationEventIdForCommand(commandId: string): string {
  return `evt_${sanitizeId(commandId)}_external_state_observed`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
