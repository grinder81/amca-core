import { describe, expect, it } from "vitest";

import { canonicalHash } from "@amca/contracts";
import type { JsonObject, RunEvent } from "@amca/protocol";

import {
  assertCapability,
  exportReleaseAuditReport,
  redactRunEvent,
  redactSecrets,
  SecurityError,
  type Principal,
  type SecurityContext,
} from "./index.js";

const operator = principal("operator_001", "tenant_a", ["operator"]);
const viewer = principal("viewer_001", "tenant_a", ["viewer"]);
const auditor = principal("auditor_001", "tenant_a", ["auditor"]);
const PROVIDER_KEY_FIXTURE = [
  "sk",
  "proj",
  "securityabcdefghijklmnopqrstuvwxyz0123456789",
].join("-");
const CLOUD_ACCESS_KEY_FIXTURE = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const CLOUD_SECRET_KEY_FIXTURE = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const DB_URL_PASSWORD_FIXTURE = "redaction-security-db-password";
const DB_URL_FIXTURE = `${["post", "gres"].join("")}://amca:${DB_URL_PASSWORD_FIXTURE}@db.internal:5432/amca`;
const JWT_LOOKING_SECRET =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzZWN1cml0eSJ9.signatureredactionsecurity";
const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
const PEM_PRIVATE_KEY = [
  `-----BEGIN ${privateKeyLabel}-----`,
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "redactionsecurityprivatekeymaterial",
  `-----END ${privateKeyLabel}-----`,
].join("\n");

describe("@amca/security", () => {
  it("role-without-capability-blocked", () => {
    expect(() => {
      assertCapability(context(viewer), "run:execute");
    }).toThrow(SecurityError);

    try {
      assertCapability(context(viewer), "run:execute");
    } catch (error) {
      expect((error as SecurityError).code).toBe("capability_denied");
    }
  });

  it("inspect-redacts-restricted-evidence", () => {
    const event = runEvent("ProposalReceived", 2, {
      proposal: {
        kind: "final_candidate",
        candidateId: "candidate_redaction",
        runId: "run_redaction",
        claims: [
          {
            claimId: "claim_restricted",
            type: "test_result",
            statement: "Tests passed.",
            predicate: {
              kind: "test_result",
              capabilityId: "shell.run_tests",
              expectedStatus: "passed",
              requiredReceiptType: "test_run",
            },
            evidenceRefs: [
              {
                admissionStatus: "admitted",
                evidenceId: "ev_restricted",
                kind: "effect_receipt",
                sourceEventId: "evt_receipt",
                hash: validHash("a"),
                observedAt: "2026-05-25T00:00:00.000Z",
                sensitivity: "restricted",
                metadata: {
                  apiToken: "secret-token",
                },
              },
            ],
            criticality: "medium",
          },
        ],
      },
    });

    const redacted = redactRunEvent(event, context(viewer));
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain("evidence_access_denied");
    expect(serialized).not.toContain(validHash("a"));
    expect(serialized).not.toContain("secret-token");
  });

  it("audit-export-no-secret-leak and audit-explains-release-block", () => {
    const events = [
      runEvent("RunStarted", 1, {
        runId: "run_audit",
        profile: "standard",
        metadata: {
          apiToken: "secret-token",
        },
      }),
      runEvent("MismatchDetected", 2, {
        mismatch: {
          mismatchId: "mismatch_missing_evidence",
          runId: "run_audit",
          type: "missing_evidence",
          blocking: true,
          message: "Evidence is missing.",
          claimId: "claim_tests_passed",
        },
      }),
      runEvent("ReleaseDecided", 3, {
        decision: {
          status: "blocked",
          runId: "run_audit",
          proofId: "proof_audit",
          approvedClaimIds: [],
          blockingMismatchIds: ["mismatch_missing_evidence"],
        },
      }),
    ];

    const report = exportReleaseAuditReport({
      context: context(auditor),
      runId: "run_audit",
      events,
    });
    const serialized = JSON.stringify(report);

    expect(report.proofUsable).toBe(false);
    expect(report.containsRawEvidence).toBe(false);
    expect(report.decisions[0]?.blockingMismatchIds).toEqual([
      "mismatch_missing_evidence",
    ]);
    expect(report.mismatches[0]?.type).toBe("missing_evidence");
    expect(serialized).not.toContain("secret-token");
  });

  it("redactSecrets-redacts-enterprise-secret-corpus", () => {
    const redacted = redactSecrets({
      message: [
        `${["OPENAI", "API", "KEY"].join("_")}=${PROVIDER_KEY_FIXTURE}`,
        `${["AWS", "ACCESS", "KEY", "ID"].join("_")}=${CLOUD_ACCESS_KEY_FIXTURE}`,
        `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${CLOUD_SECRET_KEY_FIXTURE}`,
        `connecting to ${DB_URL_FIXTURE}`,
        JWT_LOOKING_SECRET,
      ].join(" "),
      pem: PEM_PRIVATE_KEY,
      headers: [
        `Authorization: Bearer ${PROVIDER_KEY_FIXTURE}`,
        `x-api-key: ${PROVIDER_KEY_FIXTURE}`,
      ],
    });

    expectNoSecretLeak(redacted, [
      PROVIDER_KEY_FIXTURE,
      CLOUD_ACCESS_KEY_FIXTURE,
      CLOUD_SECRET_KEY_FIXTURE,
      DB_URL_PASSWORD_FIXTURE,
      DB_URL_FIXTURE,
      JWT_LOOKING_SECRET,
      PEM_PRIVATE_KEY,
      "BEGIN PRIVATE KEY",
      "redactionsecurityprivatekeymaterial",
    ]);
  });

  it("allows explicit operator capabilities without granting restricted evidence access", () => {
    expect(() => {
      assertCapability(context(operator), "run:execute");
    }).not.toThrow();
    expect(() => {
      assertCapability(context(operator), "evidence:read_restricted");
    }).toThrow(SecurityError);
  });
});

function expectNoSecretLeak(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  expect(serialized).toContain("[REDACTED]");
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

function principal(
  principalId: string,
  tenantId: string,
  roles: Principal["roles"],
): Principal {
  return {
    principalId,
    tenantId,
    roles,
  };
}

function context(principalValue: Principal): SecurityContext {
  return {
    tenantId: principalValue.tenantId,
    principal: principalValue,
  };
}

function runEvent(
  type: RunEvent["type"],
  sequence: number,
  payload: JsonObject,
): RunEvent {
  return {
    eventId: `evt_run_audit_${String(sequence)}`,
    runId: "run_audit",
    sequence,
    type,
    payload,
    payloadHash: canonicalHash(payload),
    causationId:
      sequence === 1 ? null : `evt_run_audit_${String(sequence - 1)}`,
    correlationId: null,
    occurredAt: "2026-05-25T00:00:00.000Z",
  } as unknown as RunEvent;
}

function validHash(char: string): `sha256:${string}` {
  return `sha256:${char.repeat(64)}`;
}
