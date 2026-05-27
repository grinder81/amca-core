import { describe, expect, it } from "vitest";

import { collectOperationalTelemetry } from "@amca/observability";
import type { EvidenceRef, RunEvent } from "@amca/protocol";

import {
  BAD_HASH,
  candidateWith,
  effectEvidenceRef,
  GENERATED_AT,
  startedKernel,
  submitReleasedTestClaim,
  testResultClaim,
} from "./mission-helpers.js";

const PROVIDER_KEY_FIXTURE = [
  "sk",
  "proj",
  "missionabcdefghijklmnopqrstuvwxyz0123456789",
].join("-");
const CLOUD_ACCESS_KEY_FIXTURE = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const CLOUD_SECRET_KEY_FIXTURE = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const DB_URL_PASSWORD_FIXTURE = "redaction-mission-db-password";
const DB_URL_FIXTURE = `${["post", "gres"].join("")}://amca:${DB_URL_PASSWORD_FIXTURE}@db.internal:5432/amca`;
const JWT_LOOKING_SECRET =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtaXNzaW9uIn0.signatureredactionmission";
const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
const PEM_PRIVATE_KEY = [
  `-----BEGIN ${privateKeyLabel}-----`,
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "redactionmissionprivatekeymaterial",
  `-----END ${privateKeyLabel}-----`,
].join("\n");

describe("Mission P10 observability and operations litmus", () => {
  it("telemetry-output-not-proof", () => {
    const source = submitReleasedTestClaim("mission_telemetry_source");
    const report = collectOperationalTelemetry({
      events: source.kernel.events(),
      generatedAt: GENERATED_AT,
      replayResults: [
        {
          replayId: "mission_replay_001",
          status: "passed",
          durationMs: 4,
        },
      ],
    });
    const attackKernel = startedKernel("mission_telemetry_attack");

    expect(report.proofUsable).toBe(false);
    expect(report.authority.proofAuthority).toBe(false);
    expect(report.authority.releaseAuthority).toBe(false);
    expect(() =>
      attackKernel.submitFinalCandidate(
        candidateWith(
          attackKernel.runId,
          testResultClaim({
            evidenceRefs: [report as unknown as EvidenceRef],
          }),
        ),
        {
          occurredAt: GENERATED_AT,
          generatedAt: GENERATED_AT,
        },
      ),
    ).toThrow(/FinalCandidate validation failed/u);

    const forgedEvidence = effectEvidenceRef("ev_telemetry_report", BAD_HASH, {
      sourceEventId: "evt_telemetry_report",
    });
    const blocked = attackKernel.submitFinalCandidate(
      candidateWith(
        attackKernel.runId,
        testResultClaim({
          evidenceRefs: [forgedEvidence],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    expect(blocked.decision.status).toBe("blocked");
    expect(blocked.proof.verdict).toBe("fail");
    expect(blocked.proof.blockingMismatches).toContainEqual(
      expect.objectContaining({
        type: "unverified_receipt",
        blocking: true,
      }),
    );
  });

  it("trace-secret-redaction", () => {
    const secret = "phase58-mission-secret-token";
    const source = submitReleasedTestClaim(`mission_${secret}`);
    const report = collectOperationalTelemetry({
      events: source.kernel.events(),
      generatedAt: GENERATED_AT,
      redaction: {
        redactions: [secret],
      },
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toMatch(/token[=:]/iu);
    expect(report.traces.length).toBeGreaterThan(0);
    expect(report.audit.length).toBeGreaterThan(0);
  });

  it("enterprise-redaction-corpus-not-leaked", () => {
    const report = collectOperationalTelemetry({
      events: [
        missionEffectRequestedEvent(
          [
            `${["OPENAI", "API", "KEY"].join("_")}=${PROVIDER_KEY_FIXTURE}`,
            `${["AWS", "ACCESS", "KEY", "ID"].join("_")}=${CLOUD_ACCESS_KEY_FIXTURE}`,
            `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${CLOUD_SECRET_KEY_FIXTURE}`,
            `connecting to ${DB_URL_FIXTURE}`,
            JWT_LOOKING_SECRET,
            PEM_PRIVATE_KEY,
            `Authorization: Bearer ${PROVIDER_KEY_FIXTURE}`,
            `x-api-key: ${PROVIDER_KEY_FIXTURE}`,
          ].join(" "),
        ),
      ],
      generatedAt: GENERATED_AT,
    });

    expect(report.proofUsable).toBe(false);
    expectNoSecretLeak(report, [
      PROVIDER_KEY_FIXTURE,
      CLOUD_ACCESS_KEY_FIXTURE,
      CLOUD_SECRET_KEY_FIXTURE,
      DB_URL_PASSWORD_FIXTURE,
      DB_URL_FIXTURE,
      JWT_LOOKING_SECRET,
      PEM_PRIVATE_KEY,
      "BEGIN PRIVATE KEY",
      "redactionmissionprivatekeymaterial",
    ]);
  });

  it("metric-release-vs-block-distinguished", () => {
    const released = submitReleasedTestClaim("mission_metric_released");
    const blockedKernel = startedKernel("mission_metric_blocked");
    blockedKernel.submitFinalCandidate(
      candidateWith(
        blockedKernel.runId,
        testResultClaim({
          evidenceRefs: [],
        }),
      ),
      {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      },
    );

    const report = collectOperationalTelemetry({
      events: [...released.kernel.events(), ...blockedKernel.events()],
      generatedAt: GENERATED_AT,
    });

    expect(
      report.metrics.find(
        (metric) =>
          metric.name === "release_decision_total" &&
          metric.attributes.status === "released",
      )?.value,
    ).toBe(1);
    expect(
      report.metrics.find(
        (metric) =>
          metric.name === "release_decision_total" &&
          metric.attributes.status === "blocked",
      )?.value,
    ).toBe(1);
    expect(
      report.metrics.find((metric) => metric.name === "release_gate_pass_count")
        ?.value,
    ).toBe(1);
    expect(
      report.metrics.find(
        (metric) => metric.name === "release_gate_block_count",
      )?.value,
    ).toBe(1);
  });
});

function expectNoSecretLeak(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  expect(serialized).toContain("[REDACTED]");
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

function missionEffectRequestedEvent(capabilityId: string): RunEvent {
  return {
    eventId: "evt_mission_enterprise_redaction",
    runId: "mission_enterprise_redaction",
    sequence: 1,
    type: "EffectRequested",
    payload: {
      effectRequest: {
        effectId: "effect_mission_enterprise_redaction",
        commandId: "command_mission_enterprise_redaction",
        runId: "mission_enterprise_redaction",
        capabilityId,
        toolId: "mission.redaction",
        args: {},
        sideEffectClass: "compute" as const,
        requestedAt: GENERATED_AT,
      },
    },
    payloadHash: BAD_HASH,
    causationId: null,
    correlationId: null,
    occurredAt: GENERATED_AT,
  };
}
