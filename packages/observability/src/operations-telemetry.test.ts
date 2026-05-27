import { describe, expect, it } from "vitest";

import type {
  EffectRequest,
  EffectReceipt,
  FinalCandidate,
  ProofObject,
  RunEvent,
} from "@amca/protocol";

import {
  collectOperationalTelemetry,
  redactOperationalValue,
} from "./index.js";

const HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STARTED_AT = "2026-05-25T12:00:00.000Z";
const PROVIDER_KEY_FIXTURE = [
  "sk",
  "proj",
  "abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
].join("-");
const CLOUD_ACCESS_KEY_FIXTURE = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const CLOUD_SECRET_KEY_FIXTURE = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const DB_URL_PASSWORD_FIXTURE = "redaction-db-secret-password";
const DB_URL_FIXTURE = `${["post", "gres"].join("")}://amca:${DB_URL_PASSWORD_FIXTURE}@db.internal:5432/amca`;
const JWT_LOOKING_SECRET =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyZWRhY3Rpb24ifQ.signatureredaction";
const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
const PEM_PRIVATE_KEY = [
  `-----BEGIN ${privateKeyLabel}-----`,
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "redactionprivatekeymaterial",
  `-----END ${privateKeyLabel}-----`,
].join("\n");
const HEADER_BEARER_SECRET = "redaction-header-bearer-secret";
const HEADER_API_KEY = [
  "sk",
  "proj",
  "headerabcdefghijklmnopqrstuvwxyz012345",
].join("-");
const HEADER_SESSION_SECRET = "redaction-session-secret";

describe("AMCA operational telemetry", () => {
  it("records release, mismatch, latency, quarantine, and replay metrics", () => {
    const report = collectOperationalTelemetry({
      generatedAt: "2026-05-25T12:01:00.000Z",
      replayResults: [
        {
          replayId: "replay_001",
          status: "passed",
          durationMs: 7,
        },
      ],
      events: [
        event("RunStarted", 1, STARTED_AT, { runId: "run_ops" }),
        event("EffectRequested", 2, "2026-05-25T12:00:01.000Z", {
          effectRequest: effectRequest(),
        }),
        event("EffectReceiptRecorded", 3, "2026-05-25T12:00:03.000Z", {
          receipt: effectReceipt(),
        }),
        event("ProposalReceived", 4, "2026-05-25T12:00:04.000Z", {
          proposal: finalCandidate(),
        }),
        event("ProofGenerated", 5, "2026-05-25T12:00:06.000Z", {
          proof: proofObject("fail"),
        }),
        event("MismatchDetected", 6, "2026-05-25T12:00:06.000Z", {
          mismatch: {
            mismatchId: "mismatch_001",
            runId: "run_ops",
            type: "missing_evidence",
            blocking: true,
            message: "Missing evidence.",
          },
        }),
        event("ReleaseDecided", 7, "2026-05-25T12:00:07.000Z", {
          decision: {
            status: "blocked",
            runId: "run_ops",
            proofId: "proof_001",
            approvedClaimIds: [],
            blockingMismatchIds: ["mismatch_001"],
          },
        }),
        event("WriteQuarantined", 8, "2026-05-25T12:00:08.000Z", {
          quarantine: {
            kind: "write_quarantine_state",
            quarantineId: "quarantine_001",
            runId: "run_ops",
            preflightId: "preflight_001",
            commandId: "command_001",
            capabilityId: "github.create_pull_request",
            toolId: "github.create_pull_request",
            sideEffectClass: "idempotent_write",
            status: "quarantined",
            reason: "uncertain_external_effect",
            message: "External outcome is uncertain.",
            quarantinedAt: "2026-05-25T12:00:08.000Z",
          },
        }),
      ],
    });

    expect(report.proofUsable).toBe(false);
    expect(report.authority).toEqual({
      admitsEvidence: false,
      executesEffects: false,
      mutatesTruth: false,
      proofAuthority: false,
      releaseAuthority: false,
    });
    expect(metric(report, "release_gate_block_count")?.value).toBe(1);
    expect(metric(report, "release_gate_pass_count")?.value).toBe(0);
    expect(metric(report, "effect_latency_ms")?.value).toBe(2000);
    expect(metric(report, "proof_latency_ms")?.value).toBe(2000);
    expect(metric(report, "mismatch_detected_total")?.attributes).toMatchObject(
      {
        mismatchType: "missing_evidence",
      },
    );
    expect(metric(report, "quarantine_total")?.value).toBe(1);
    expect(metric(report, "replay_success_total")?.value).toBe(1);
    expect(report.traces).toHaveLength(8);
    expect(report.audit).toHaveLength(8);
  });

  it("redacts secret keys and secret-shaped values in traces and audit output", () => {
    const secret = "phase58-super-secret-token";
    const report = collectOperationalTelemetry({
      generatedAt: "2026-05-25T12:01:00.000Z",
      redaction: {
        redactions: [secret],
      },
      events: [
        event("EffectRequested", 1, STARTED_AT, {
          effectRequest: {
            ...effectRequest(),
            runId: `run_${secret}`,
            args: {
              authorization: `Bearer ${secret}`,
              safe: "visible",
            },
          },
        }),
      ],
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toMatch(/Bearer\s+/u);
    expect(
      redactOperationalValue({
        safe: "visible",
        apiKey: "api_key=phase58-test",
        nested: {
          token: "should hide",
        },
      }),
    ).toEqual({
      safe: "visible",
      apiKey: "[REDACTED]",
      nested: {
        token: "[REDACTED]",
      },
    });
  });

  it("observability-redacts-openai-api-key", () => {
    const redacted = redactOperationalValue({
      provider: "openai",
      message: `${["OPENAI", "API", "KEY"].join("_")}=${PROVIDER_KEY_FIXTURE}`,
      nested: {
        apiKey: PROVIDER_KEY_FIXTURE,
      },
    });

    expectNoSecretLeak(redacted, [PROVIDER_KEY_FIXTURE]);
  });

  it("observability-redacts-aws-access-key-and-secret", () => {
    const redacted = redactOperationalValue({
      message: [
        `${["AWS", "ACCESS", "KEY", "ID"].join("_")}=${CLOUD_ACCESS_KEY_FIXTURE}`,
        `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${CLOUD_SECRET_KEY_FIXTURE}`,
      ].join(" "),
      credentials: {
        awsAccessKeyId: CLOUD_ACCESS_KEY_FIXTURE,
        awsSecretAccessKey: CLOUD_SECRET_KEY_FIXTURE,
      },
    });

    expectNoSecretLeak(redacted, [
      CLOUD_ACCESS_KEY_FIXTURE,
      CLOUD_SECRET_KEY_FIXTURE,
    ]);
  });

  it("observability-redacts-database-url-password", () => {
    const redacted = redactOperationalValue({
      connection: "primary",
      message: `connecting to ${DB_URL_FIXTURE}`,
    });

    expectNoSecretLeak(redacted, [DB_URL_PASSWORD_FIXTURE, DB_URL_FIXTURE]);
  });

  it("observability-redacts-jwt-looking-string", () => {
    const redacted = redactOperationalValue({
      diagnostic: `token candidate ${JWT_LOOKING_SECRET}`,
    });

    expectNoSecretLeak(redacted, [JWT_LOOKING_SECRET]);
  });

  it("observability-redacts-pem-private-key", () => {
    const redacted = redactOperationalValue({
      diagnostic: PEM_PRIVATE_KEY,
    });

    expectNoSecretLeak(redacted, [
      PEM_PRIVATE_KEY,
      "BEGIN PRIVATE KEY",
      "redactionprivatekeymaterial",
    ]);
  });

  it("observability-redacts-array-of-header-secrets", () => {
    const redacted = redactOperationalValue({
      headers: [
        `Authorization: Bearer ${HEADER_BEARER_SECRET}`,
        `x-api-key: ${HEADER_API_KEY}`,
        [`Cookie: session=${HEADER_SESSION_SECRET}; path=/`],
      ],
    });

    expectNoSecretLeak(redacted, [
      HEADER_BEARER_SECRET,
      HEADER_API_KEY,
      HEADER_SESSION_SECRET,
    ]);
  });
});

type TelemetryReport = ReturnType<typeof collectOperationalTelemetry>;

function expectNoSecretLeak(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  expect(serialized).toContain("[REDACTED]");
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

function metric(
  report: TelemetryReport,
  name: TelemetryReport["metrics"][number]["name"],
): TelemetryReport["metrics"][number] | undefined {
  return report.metrics.find((entry) => entry.name === name);
}

function event(
  type: RunEvent["type"],
  sequence: number,
  occurredAt: string,
  payload: RunEvent["payload"],
): RunEvent {
  return {
    eventId: `evt_${String(sequence)}`,
    runId: "run_ops",
    sequence,
    type,
    payload,
    payloadHash: HASH,
    causationId: sequence === 1 ? null : "evt_1",
    correlationId: null,
    occurredAt,
  };
}

function effectRequest(): EffectRequest {
  return {
    effectId: "effect_001",
    commandId: "command_001",
    runId: "run_ops",
    capabilityId: "shell.run_tests",
    toolId: "pnpm.test",
    args: {
      command: "pnpm test",
    },
    sideEffectClass: "compute",
    requestedAt: "2026-05-25T12:00:01.000Z",
  };
}

function effectReceipt(): EffectReceipt {
  return {
    receiptId: "receipt_001",
    effectId: "effect_001",
    runId: "run_ops",
    capabilityId: "shell.run_tests",
    receiptType: "test_run",
    status: "succeeded",
    payload: {
      result: "passed",
    },
    payloadHash: HASH,
    evidence: [
      {
        evidenceId: "ev_001",
        kind: "effect_receipt",
        sourceEventId: "evt_3",
        hash: HASH,
        observedAt: "2026-05-25T12:00:03.000Z",
        sensitivity: "internal",
      },
    ],
    observedAt: "2026-05-25T12:00:03.000Z",
  };
}

function finalCandidate(): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: "candidate_001",
    runId: "run_ops",
    claims: [
      {
        claimId: "claim_001",
        type: "test_result",
        statement: "Tests passed.",
        predicate: {
          kind: "test_result",
          capabilityId: "shell.run_tests",
          expectedStatus: "passed",
          requiredReceiptType: "test_run",
        },
        evidenceRefs: [],
        criticality: "medium",
      },
    ],
  };
}

function proofObject(verdict: ProofObject["verdict"]): ProofObject {
  return {
    proofId: "proof_001",
    runId: "run_ops",
    candidateId: "candidate_001",
    generatedAt: "2026-05-25T12:00:06.000Z",
    verdict,
    claims: [
      {
        claimId: "claim_001",
        supported: false,
        evidenceRefs: [],
        mismatchIds: ["mismatch_001"],
      },
    ],
    approvedClaimIds: [],
    rejectedClaimIds: ["claim_001"],
    blockingMismatches: [],
    evaluatedClaims: finalCandidate().claims,
  };
}
