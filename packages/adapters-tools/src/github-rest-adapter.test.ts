import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  validateExternalStateObservationCandidate,
  validateReceiptCandidate,
} from "@amca/contracts";
import type { CertifiedEffectRequest } from "@amca/effect-sdk";
import type {
  EffectRequest,
  JsonObject,
  ToolCommandRequest,
} from "@amca/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGithubRestAdapter,
  GithubRestAdapterError,
} from "./github-rest-adapter.js";

const runId = "run_github_rest_adapter";
const observedAt = "2026-05-25T12:00:00.000Z";
const readCapabilityId = "github.observe_rest_resource";
const writeCapabilityId = "github.create_pull_request";
const readToolId = "github.rest.get";
const writeToolId = "github.rest.post";
const readReceiptType = "github.rest.read";
const writeReceiptType = "github.rest.write";
const observationType = "github.rest.resource_snapshot";
const scopedOwner = "acme";
const scopedRepo = "widgets";
const baseBranch = "main";
const headBranch = "feature/amca-hardening";
const readRepositoryScopes = [
  {
    owner: scopedOwner,
    repo: scopedRepo,
    allowedOperations: ["get_repository"],
  },
] as const;
const writeRepositoryScopes = [
  {
    owner: scopedOwner,
    repo: scopedRepo,
    allowedOperations: ["create_pull_request"],
    allowedBaseBranches: [baseBranch],
    allowedHeadBranches: [headBranch],
  },
] as const;

describe("GitHub REST adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("github-readonly-observation-uses-real-fetch-fixture-without-raw-body-leak", async () => {
    const server = await fixtureServer((request, response) => {
      expect(request.method).toBe("GET");
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ secret: "phase51-hidden-body" }));
    });

    try {
      const result = await createGithubRestAdapter({
        adapterId: "adapter.github.read",
        allowedBaseUrls: [server.baseUrl],
        capabilityId: readCapabilityId,
        mode: "read",
        observationType,
        receiptType: readReceiptType,
        repositoryScopes: readRepositoryScopes,
        toolId: readToolId,
      }).execute(requestFor("read"), {
        now: () => observedAt,
      });

      expect(result.receiptCandidate?.status).toBe("succeeded");
      expect(result.externalStateObservationCandidate).toBeDefined();
      expect(validateReceiptCandidate(result.receiptCandidate).success).toBe(
        true,
      );
      expect(
        validateExternalStateObservationCandidate(
          result.externalStateObservationCandidate,
        ).success,
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain("phase51-hidden-body");
      expect(result.receiptCandidate?.payload).toMatchObject({
        result: "succeeded",
        redaction: "content_hash_only",
        request: {
          method: "GET",
          resource: {
            host: "127.0.0.1",
            path: "/repos/acme/widgets",
          },
        },
      });
      expect(
        result.externalStateObservationCandidate?.evidence[0],
      ).not.toHaveProperty("sourceEventId");
    } finally {
      await server.close();
    }
  });

  it("github-token-not-logged", async () => {
    const token = "ghp_phase51_secret_token";
    let authorizationHeader: string | undefined;
    const server = await fixtureServer((request, response) => {
      authorizationHeader = request.headers.authorization;
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ok: true }));
    });

    try {
      const result = await createGithubRestAdapter({
        adapterId: "adapter.github.read.token",
        allowedBaseUrls: [server.baseUrl],
        capabilityId: readCapabilityId,
        mode: "read",
        observationType,
        receiptType: readReceiptType,
        repositoryScopes: readRepositoryScopes,
        token,
        toolId: readToolId,
      }).execute(requestFor("read"), {
        now: () => observedAt,
      });

      expect(authorizationHeader).toBe(`Bearer ${token}`);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result).toLowerCase()).not.toContain(
        "authorization",
      );
    } finally {
      await server.close();
    }
  });

  it("github-live-access-not-used-without-credentials", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createGithubRestAdapter({
      adapterId: "adapter.github.read.local-only",
      allowedBaseUrls: ["http://127.0.0.1:1/local-fixture/"],
      capabilityId: readCapabilityId,
      mode: "read",
      observationType,
      receiptType: readReceiptType,
      repositoryScopes: readRepositoryScopes,
      toolId: readToolId,
    }).execute(
      requestFor("read", {
        path: "/repos/acme/widgets",
      }),
      {
        now: () => observedAt,
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        result: "failed",
        reason: "base_url_not_allowed",
      },
    });
  });

  it("github-write-candidate-no-raw-body", async () => {
    const server = await fixtureServer((_request, response) => {
      response.writeHead(201, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ html_url: "https://github.test/pr/1" }));
    });

    try {
      const result = await createGithubRestAdapter({
        adapterId: "adapter.github.write",
        allowedBaseUrls: [server.baseUrl],
        capabilityId: writeCapabilityId,
        mode: "write",
        receiptType: writeReceiptType,
        repositoryScopes: writeRepositoryScopes,
        token: "ghp_write_secret",
        toolId: writeToolId,
      }).execute(requestFor("write"), {
        now: () => observedAt,
      });

      expect(result.externalStateObservationCandidate).toBeUndefined();
      expect(result.receiptCandidate).toMatchObject({
        status: "succeeded",
        receiptType: writeReceiptType,
        payload: {
          result: "succeeded",
          redaction: "content_hash_only",
          request: {
            method: "POST",
          },
          statusCode: 201,
        },
      });
      expect(JSON.stringify(result)).toMatch(/"bodyHash":"sha256:/u);
      expect(JSON.stringify(result)).toMatch(/"idempotencyKeyHash":"sha256:/u);
      expect(JSON.stringify(result)).not.toContain("Phase 51 PR");
      expect(JSON.stringify(result)).not.toContain("ghp_write_secret");
      expect(validateReceiptCandidate(result.receiptCandidate).success).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });

  it("github-write-uncertain-server-result-throws-for-broker-quarantine", async () => {
    const server = await fixtureServer((_request, response) => {
      response.writeHead(503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ message: "try later" }));
    });

    try {
      await expect(
        createGithubRestAdapter({
          adapterId: "adapter.github.write.uncertain",
          allowedBaseUrls: [server.baseUrl],
          capabilityId: writeCapabilityId,
          mode: "write",
          receiptType: writeReceiptType,
          repositoryScopes: writeRepositoryScopes,
          token: "ghp_write_secret",
          toolId: writeToolId,
        }).execute(requestFor("write"), {
          now: () => observedAt,
        }),
      ).rejects.toThrow(GithubRestAdapterError);
    } finally {
      await server.close();
    }
  });

  it.each([
    { method: "POST", mode: "read" },
    { method: "GET", mode: "write" },
  ] as const)("github-method-scope-blocked: $mode $method", async (input) => {
    const result = await createGithubRestAdapter({
      adapterId: `adapter.github.${input.mode}.method`,
      allowedBaseUrls: ["http://127.0.0.1:1/"],
      capabilityId:
        input.mode === "read" ? readCapabilityId : writeCapabilityId,
      mode: input.mode,
      observationType,
      receiptType: input.mode === "read" ? readReceiptType : writeReceiptType,
      repositoryScopes:
        input.mode === "read" ? readRepositoryScopes : writeRepositoryScopes,
      token: input.mode === "write" ? "ghp_write_secret" : undefined,
      toolId: input.mode === "read" ? readToolId : writeToolId,
    }).execute(
      requestFor(input.mode, {
        method: input.method,
      }),
      {
        now: () => observedAt,
      },
    );

    expect(result.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        reason: "invalid_method",
      },
    });
  });

  it("github-adapter-blocks-unallowlisted-repo", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createGithubRestAdapter({
      adapterId: "adapter.github.read.repo-scope",
      allowedBaseUrls: ["http://127.0.0.1:1/"],
      capabilityId: readCapabilityId,
      mode: "read",
      observationType,
      receiptType: readReceiptType,
      repositoryScopes: readRepositoryScopes,
      toolId: readToolId,
    }).execute(
      requestFor("read", {
        path: "/repos/acme/unscoped-repo",
      }),
      {
        now: () => observedAt,
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        reason: "repo_not_allowed",
      },
    });
  });

  it("github-adapter-blocks-unallowlisted-owner", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createGithubRestAdapter({
      adapterId: "adapter.github.read.owner-scope",
      allowedBaseUrls: ["http://127.0.0.1:1/"],
      capabilityId: readCapabilityId,
      mode: "read",
      observationType,
      receiptType: readReceiptType,
      repositoryScopes: readRepositoryScopes,
      toolId: readToolId,
    }).execute(
      requestFor("read", {
        path: "/repos/octo/widgets",
      }),
      {
        now: () => observedAt,
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        reason: "owner_not_allowed",
      },
    });
  });

  it("github-adapter-blocks-arbitrary-endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createGithubRestAdapter({
      adapterId: "adapter.github.read.endpoint-scope",
      allowedBaseUrls: ["http://127.0.0.1:1/"],
      capabilityId: readCapabilityId,
      mode: "read",
      observationType,
      receiptType: readReceiptType,
      repositoryScopes: readRepositoryScopes,
      toolId: readToolId,
    }).execute(
      requestFor("read", {
        path: "/repos/acme/widgets/issues",
      }),
      {
        now: () => observedAt,
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        reason: "endpoint_not_allowed",
      },
    });
  });

  it("github-adapter-blocks-unscoped-pr-branch-mutation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const unscopedResult = await createGithubRestAdapter({
      adapterId: "adapter.github.write.unscoped-branch",
      allowedBaseUrls: ["http://127.0.0.1:1/"],
      capabilityId: writeCapabilityId,
      mode: "write",
      receiptType: writeReceiptType,
      repositoryScopes: [
        {
          owner: scopedOwner,
          repo: scopedRepo,
          allowedOperations: ["create_pull_request"],
        },
      ],
      token: "ghp_write_secret",
      toolId: writeToolId,
    }).execute(requestFor("write"), {
      now: () => observedAt,
    });
    const disallowedBranchResult = await createGithubRestAdapter({
      adapterId: "adapter.github.write.branch-scope",
      allowedBaseUrls: ["http://127.0.0.1:1/"],
      capabilityId: writeCapabilityId,
      mode: "write",
      receiptType: writeReceiptType,
      repositoryScopes: writeRepositoryScopes,
      token: "ghp_write_secret",
      toolId: writeToolId,
    }).execute(
      requestFor("write", {
        body: {
          base: baseBranch,
          head: "feature/unscoped-branch",
          title: "Phase 61 PR",
        },
      }),
      {
        now: () => observedAt,
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(unscopedResult.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        reason: "branch_scope_required",
      },
    });
    expect(disallowedBranchResult.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        reason: "branch_not_allowed",
      },
    });
  });

  it("github-adapter-token-never-appears-in-error", async () => {
    const token = "ghp_phase61_error_path_secret";
    const server = await fixtureServer((_request, response) => {
      response.writeHead(503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ message: "unknown write state" }));
    });
    let thrown: unknown;

    try {
      await createGithubRestAdapter({
        adapterId: "adapter.github.write.token-error",
        allowedBaseUrls: [server.baseUrl],
        capabilityId: writeCapabilityId,
        mode: "write",
        receiptType: writeReceiptType,
        repositoryScopes: writeRepositoryScopes,
        token,
        toolId: writeToolId,
      }).execute(requestFor("write"), {
        now: () => observedAt,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await server.close();
    }

    expect(thrown).toBeInstanceOf(GithubRestAdapterError);
    expect(String(thrown)).not.toContain(token);
    expect(JSON.stringify(thrown)).not.toContain(token);
  });
});

function requestFor(
  mode: "read" | "write",
  overrides: Partial<JsonObject> = {},
): CertifiedEffectRequest {
  const sideEffectClass = mode === "read" ? "read" : "idempotent_write";
  const command: ToolCommandRequest = {
    kind: "tool_command_request",
    commandId: `command_github_${mode}`,
    runId,
    capabilityId: mode === "read" ? readCapabilityId : writeCapabilityId,
    toolId: mode === "read" ? readToolId : writeToolId,
    sideEffectClass,
    args:
      mode === "read"
        ? {
            method: "GET",
            path: "/repos/acme/widgets",
            ...overrides,
          }
        : {
            body: {
              base: baseBranch,
              head: headBranch,
              title: "Phase 51 PR",
            },
            method: "POST",
            path: "/repos/acme/widgets/pulls",
            ...overrides,
          },
    ...(mode === "write" ? { idempotencyKey: "idem-github-write" } : {}),
  };
  const effectRequest: EffectRequest = {
    effectId: `effect_github_${mode}`,
    commandId: command.commandId,
    runId,
    capabilityId: command.capabilityId,
    toolId: command.toolId,
    args: command.args,
    sideEffectClass,
    requestedAt: observedAt,
    ...(command.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: command.idempotencyKey }),
  };

  return {
    toolCommand: command,
    effectRequest,
    capability: capabilityFor(mode),
  };
}

function capabilityFor(
  mode: "read" | "write",
): CertifiedEffectRequest["capability"] {
  return {
    schemaVersion: 1,
    capabilityId: mode === "read" ? readCapabilityId : writeCapabilityId,
    profile: mode === "read" ? "standard" : "critical",
    sideEffectClass: mode === "read" ? "read" : "idempotent_write",
    inputSchema: {
      type: "object",
    },
    receiptSchema: {
      type: "object",
    },
    evidence:
      mode === "read"
        ? [
            {
              evidenceKind: "effect_receipt",
              receiptType: readReceiptType,
            },
            {
              evidenceKind: "external_observation",
              observationType,
            },
          ]
        : [
            {
              evidenceKind: "effect_receipt",
              receiptType: writeReceiptType,
            },
          ],
    supportedClaims: [],
    proofRules: [],
  };
}

async function fixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      }),
  };
}
