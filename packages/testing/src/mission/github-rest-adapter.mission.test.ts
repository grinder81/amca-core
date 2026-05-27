import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { CapabilityContract } from "@amca/capabilities";
import { createGithubRestAdapter } from "@amca/adapters-tools";
import { InMemoryEffectBroker } from "@amca/effect-broker";
import { LocalRunHarness } from "@amca/harness";
import { InMemoryRunKernel } from "@amca/kernel";
import type {
  Claim,
  EvidenceRef,
  ExternalStateObservation,
  FinalCandidate,
  PendingEvidenceRef,
  ToolCommandRequest,
} from "@amca/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const now = "2026-05-25T12:00:00.000Z";
const runId = "mission_github_rest_adapter";
const writeCapabilityId = "github.create_pull_request";
const writeToolId = "github.rest.post";
const writeReceiptType = "github.rest.write";
const readCapabilityId = "github.observe_rest_resource";
const readToolId = "github.rest.get";
const readReceiptType = "github.rest.read";
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

describe("Mission P4/P8 GitHub REST adapter containment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("github-write-requires-preflight", async () => {
    let calls = 0;
    const server = await fixtureServer((_request, response) => {
      calls += 1;
      response.writeHead(201, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ id: 123, body: "raw-response-hidden" }));
    });
    const command = writeCommand();
    const broker = new InMemoryEffectBroker({
      allowedAdapterKinds: ["external_write"],
      adapters: [
        createGithubRestAdapter({
          adapterId: "adapter.github.write.mission",
          allowedBaseUrls: [server.baseUrl],
          capabilityId: writeCapabilityId,
          mode: "write",
          receiptType: writeReceiptType,
          repositoryScopes: writeRepositoryScopes,
          token: "ghp_mission_secret",
          toolId: writeToolId,
        }),
      ],
      capabilities: [writeCapability()],
      clock: () => now,
    });

    try {
      await expect(broker.dispatch(command)).rejects.toMatchObject({
        code: "write_preflight_required",
      });
      expect(calls).toBe(0);

      const decision = broker.preflightWrite(command, {
        decidedAt: now,
        requestedAt: now,
      });
      const result = await broker.dispatchWithPreflight(command, {
        preflightDecision: decision,
        requestedAt: now,
      });

      expect(calls).toBe(1);
      expect(result.receiptCandidate).toMatchObject({
        status: "succeeded",
        receiptType: writeReceiptType,
        payload: {
          result: "succeeded",
          redaction: "content_hash_only",
          request: {
            method: "POST",
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("ghp_mission_secret");
      expect(JSON.stringify(result)).not.toContain("raw-response-hidden");
      expect(result.receiptCandidate.evidence[0]).not.toHaveProperty(
        "sourceEventId",
      );
    } finally {
      await server.close();
    }
  });

  it("github-live-access-not-used-without-credentials", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createGithubRestAdapter({
      adapterId: "adapter.github.read.live-blocked",
      allowedBaseUrls: ["http://127.0.0.1:1/local-only/"],
      capabilityId: readCapabilityId,
      mode: "read",
      observationType,
      receiptType: readReceiptType,
      repositoryScopes: readRepositoryScopes,
      toolId: readToolId,
    }).execute(
      {
        capability: readCapability(),
        effectRequest: {
          effectId: "effect_github_live_blocked",
          commandId: "command_github_live_blocked",
          runId,
          capabilityId: readCapabilityId,
          toolId: readToolId,
          args: {
            method: "GET",
            url: "https://api.github.com/repos/acme/widgets",
          },
          sideEffectClass: "read",
          requestedAt: now,
        },
        toolCommand: {
          kind: "tool_command_request",
          commandId: "command_github_live_blocked",
          runId,
          capabilityId: readCapabilityId,
          toolId: readToolId,
          args: {
            method: "GET",
            url: "https://api.github.com/repos/acme/widgets",
          },
          sideEffectClass: "read",
        },
      },
      {
        now: () => now,
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.receiptCandidate).toMatchObject({
      status: "failed",
      payload: {
        reason: "base_url_not_allowed",
      },
    });
  });

  it("github-write-uncertain-result-is-quarantined-by-broker", async () => {
    const server = await fixtureServer((_request, response) => {
      response.writeHead(503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ message: "unknown write state" }));
    });
    const command = writeCommand("mission-github-write-uncertain");
    const broker = new InMemoryEffectBroker({
      allowedAdapterKinds: ["external_write"],
      adapters: [
        createGithubRestAdapter({
          adapterId: "adapter.github.write.uncertain.mission",
          allowedBaseUrls: [server.baseUrl],
          capabilityId: writeCapabilityId,
          mode: "write",
          receiptType: writeReceiptType,
          repositoryScopes: writeRepositoryScopes,
          token: "ghp_mission_secret",
          toolId: writeToolId,
        }),
      ],
      capabilities: [writeCapability()],
      clock: () => now,
    });

    try {
      const decision = broker.preflightWrite(command, {
        decidedAt: now,
        requestedAt: now,
      });

      await expect(
        broker.dispatchWithPreflight(command, {
          preflightDecision: decision,
          requestedAt: now,
        }),
      ).rejects.toMatchObject({
        code: "adapter_write_quarantined",
        quarantine: {
          reason: "uncertain_external_effect",
          status: "quarantined",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("github-adapter-write-candidate-not-proof-before-admission", async () => {
    const server = await fixtureServer((_request, response) => {
      response.writeHead(201, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ id: 456, body: "hidden-pr-response" }));
    });
    const command = writeCommand("mission-github-write-candidate");
    const broker = new InMemoryEffectBroker({
      allowedAdapterKinds: ["external_write"],
      adapters: [
        createGithubRestAdapter({
          adapterId: "adapter.github.write.candidate.mission",
          allowedBaseUrls: [server.baseUrl],
          capabilityId: writeCapabilityId,
          mode: "write",
          receiptType: writeReceiptType,
          repositoryScopes: writeRepositoryScopes,
          token: "ghp_mission_secret",
          toolId: writeToolId,
        }),
      ],
      capabilities: [writeCapability()],
      clock: () => now,
    });

    try {
      const decision = broker.preflightWrite(command, {
        decidedAt: now,
        requestedAt: now,
      });
      const dispatch = await broker.dispatchWithPreflight(command, {
        preflightDecision: decision,
        requestedAt: now,
      });
      const pendingEvidence = dispatch.receiptCandidate.evidence[0];
      if (pendingEvidence === undefined) {
        throw new Error("GitHub write candidate must include evidence.");
      }

      expect(pendingEvidence.admissionStatus).toBe("pending");
      expect(pendingEvidence).not.toHaveProperty("sourceEventId");

      const kernel = new InMemoryRunKernel({
        runId,
        clock: () => now,
      });
      kernel.startRun({
        occurredAt: now,
        profile: "critical",
      });
      kernel.recordEffectRequest(dispatch.effectRequest, {
        occurredAt: now,
      });

      const blocked = kernel.submitFinalCandidate(
        finalCandidate(
          runId,
          githubWriteClaim([evidenceRefFromPending(pendingEvidence)]),
        ),
        {
          generatedAt: now,
          occurredAt: now,
        },
      );

      expect(blocked.decision.status).toBe("blocked");
      expect(blocked.proof.blockingMismatches).toContainEqual(
        expect.objectContaining({
          type: "unverified_receipt",
          blocking: true,
        }),
      );
      expect(JSON.stringify(dispatch)).not.toContain("hidden-pr-response");
      expect(JSON.stringify(dispatch)).not.toContain("ghp_mission_secret");
    } finally {
      await server.close();
    }
  });

  it("github-adapter-current-state-claim-requires-fresh-observation", async () => {
    const server = await fixtureServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ state: "open", secret: "hidden-state" }));
    });
    const harness = new LocalRunHarness({
      runId,
      clock: () => now,
      brokerOptions: {
        allowedAdapterKinds: ["external_read"],
        adapters: [
          createGithubRestAdapter({
            adapterId: "adapter.github.read.freshness.mission",
            allowedBaseUrls: [server.baseUrl],
            capabilityId: readCapabilityId,
            mode: "read",
            observationType,
            receiptType: readReceiptType,
            repositoryScopes: readRepositoryScopes,
            toolId: readToolId,
          }),
        ],
        capabilities: [readCapability()],
        clock: () => now,
      },
    });

    try {
      harness.startRun({
        occurredAt: now,
        profile: "standard",
      });
      const dispatch = await harness.dispatchToolCommand(readCommand());
      const observation = dispatch.recordedExternalStateObservation;
      if (observation === undefined) {
        throw new Error("GitHub read adapter must emit an observation.");
      }
      const evidenceRef = singleObservationEvidenceRef(observation);

      const released = harness.submitFinalCandidate(
        finalCandidate(
          runId,
          githubCurrentStatusClaim("claim_github_status_fresh", {
            evidenceRefs: [evidenceRef],
            observation,
          }),
        ),
        {
          generatedAt: now,
          occurredAt: now,
        },
      );
      const stale = harness.submitFinalCandidate(
        finalCandidate(
          runId,
          githubCurrentStatusClaim("claim_github_status_stale", {
            evidenceRefs: [evidenceRef],
            observation,
          }),
        ),
        {
          generatedAt: "2026-05-25T12:02:00.000Z",
          occurredAt: "2026-05-25T12:02:00.000Z",
        },
      );

      expect(released.decision.status).toBe("released");
      expect(stale.decision.status).toBe("blocked");
      expect(stale.proof.blockingMismatches).toContainEqual(
        expect.objectContaining({
          type: "stale_external_state",
          blocking: true,
        }),
      );
      expect(JSON.stringify(dispatch)).not.toContain("hidden-state");
    } finally {
      await server.close();
    }
  });
});

function writeCommand(
  idempotencyKey = "mission-github-write-001",
): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: "command_github_write",
    runId,
    capabilityId: writeCapabilityId,
    toolId: writeToolId,
    args: {
      body: {
        base: baseBranch,
        head: headBranch,
        title: "Mission PR",
      },
      method: "POST",
      path: "/repos/acme/widgets/pulls",
    },
    sideEffectClass: "idempotent_write",
    idempotencyKey,
  };
}

function readCommand(): ToolCommandRequest {
  return {
    kind: "tool_command_request",
    commandId: "command_github_read",
    runId,
    capabilityId: readCapabilityId,
    toolId: readToolId,
    args: {
      method: "GET",
      path: "/repos/acme/widgets",
    },
    sideEffectClass: "read",
  };
}

function finalCandidate(runId: string, claim: Claim): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${claim.claimId}`,
    runId,
    claims: [claim],
  };
}

function githubWriteClaim(evidenceRefs: readonly EvidenceRef[]): Claim {
  return {
    claimId: "claim_github_write_candidate_not_proof",
    type: "historical_action",
    statement: "GitHub pull request write was completed.",
    predicate: {
      kind: "historical_action",
      actionVerb: "created",
      capabilityId: writeCapabilityId,
      requiredReceiptType: writeReceiptType,
      subjectType: "agent",
      subjectId: "agent_github_adapter",
      targetType: "pull_request",
    },
    evidenceRefs: [...evidenceRefs],
    criticality: "high",
  };
}

function githubCurrentStatusClaim(
  claimId: string,
  input: {
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly observation: ExternalStateObservation;
  },
): Claim {
  return {
    claimId,
    type: "current_state",
    statement: "GitHub REST resource currently returned HTTP 200.",
    predicate: {
      kind: "current_state",
      subjectType: input.observation.subjectType,
      subjectId: input.observation.subjectId,
      property: "statusCode",
      operator: "equals",
      expectedValue: 200,
      observationType,
      freshnessRequirementMs: 60_000,
    },
    evidenceRefs: [...input.evidenceRefs],
    criticality: "medium",
  };
}

function evidenceRefFromPending(
  pendingEvidenceRef: PendingEvidenceRef,
): EvidenceRef {
  return {
    evidenceId: pendingEvidenceRef.evidenceId,
    kind: pendingEvidenceRef.kind,
    sourceEventId: pendingEvidenceRef.pendingAdmissionToken,
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

function singleObservationEvidenceRef(
  observation: ExternalStateObservation,
): EvidenceRef {
  const evidenceRef = observation.evidence[0];
  if (evidenceRef === undefined) {
    throw new Error("GitHub observation must include evidence.");
  }
  return evidenceRef;
}

function writeCapability(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: writeCapabilityId,
    profile: "critical",
    sideEffectClass: "idempotent_write",
    inputSchema: {
      type: "object",
    },
    receiptSchema: {
      type: "object",
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType: writeReceiptType,
      },
    ],
    supportedClaims: [
      {
        claimType: "historical_action",
        predicateKind: "historical_action",
        requiredReceiptType: writeReceiptType,
        targetTypes: ["pull_request"],
      },
    ],
    proofRules: [],
  };
}

function readCapability(): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: readCapabilityId,
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
        receiptType: readReceiptType,
      },
      {
        evidenceKind: "external_observation",
        observationType,
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
