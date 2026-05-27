import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalObjectHash } from "@amca/contracts";
import type {
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  ExternalStateObservation,
  JsonObject,
} from "@amca/protocol";
import { describe, expect, it } from "vitest";

import {
  reconcileAcceptedEvidence,
  type ReceiptStatusSummary,
} from "./reconciliation-engine.js";

const checkedAt = "2026-05-24T12:00:00.000Z";
const freshObservedAt = "2026-05-24T11:59:30.000Z";
const staleObservedAt = "2026-05-24T11:00:00.000Z";
const expiresAt = "2026-05-24T12:05:00.000Z";

describe("reconcileAcceptedEvidence", () => {
  it("detects drift when a fresh current-state observation differs", () => {
    const accepted = observation({
      observationId: "obs_accepted",
      observedState: { status: "pending" },
      observedAt: "2026-05-24T11:30:00.000Z",
    });
    const fresh = observation({
      observationId: "obs_fresh",
      observedState: { status: "complete" },
      observedAt: freshObservedAt,
    });

    const firstReport = reconcileAcceptedEvidence({
      runId: "run_reconciliation_drift",
      checkedAt,
      acceptedObservations: [accepted],
      freshObservations: [fresh],
      observationFreshnessMs: 60_000,
    });
    const secondReport = reconcileAcceptedEvidence({
      runId: "run_reconciliation_drift",
      checkedAt,
      acceptedObservations: [accepted],
      freshObservations: [fresh],
      observationFreshnessMs: 60_000,
    });

    expect(firstReport).toEqual(secondReport);
    expect(firstReport).toMatchObject({
      kind: "reconciliation_report",
      advisoryOnly: true,
      proofUsable: false,
      outcome: "drift_detected",
      observationsCompared: 1,
    });
    expect(firstReport.authority).toMatchObject({
      mutatesTruth: false,
      executesEffects: false,
      callsExternalSystems: false,
      admitsEvidence: false,
      supportsProof: false,
      releasesClaims: false,
    });
    const driftMismatch = firstReport.mismatches.find(
      (mismatch) => mismatch.type === "external_state_drift",
    );
    expect(driftMismatch?.target).toEqual({
      kind: "external_observation",
      observationId: "obs_accepted",
      observationType: "resource.snapshot",
      subjectType: "resource",
      subjectId: "resource_123",
    });
    expect(JSON.stringify(firstReport.mismatches)).not.toContain("complete");
  });

  it("marks stale fresh observations as reconciliation_needed", () => {
    const accepted = observation({
      observationId: "obs_accepted",
      observedState: { status: "pending" },
      observedAt: freshObservedAt,
    });
    const staleFresh = observation({
      observationId: "obs_stale",
      observedState: { status: "pending" },
      observedAt: staleObservedAt,
    });

    const report = reconcileAcceptedEvidence({
      runId: "run_reconciliation_stale",
      checkedAt,
      acceptedObservations: [accepted],
      freshObservations: [staleFresh],
      observationFreshnessMs: 60_000,
    });

    expect(report.outcome).toBe("reconciliation_needed");
    expect(report.quarantineRecommendations).toEqual([]);
    const staleMismatch = report.mismatches.find(
      (mismatch) => mismatch.type === "stale_observation",
    );
    expect(staleMismatch?.severity).toBe("warning");
    expect(staleMismatch?.expected).toEqual({
      checkedAt,
      freshnessRequirementMs: 60_000,
    });
  });

  it("recommends quarantine for missing receipts and uncertain external effects", () => {
    const request = effectRequest("effect_missing_receipt");
    const uncertainReceipt = receipt({
      effectId: "effect_uncertain_status",
      receiptId: "receipt_uncertain_status",
      status: "succeeded",
    });
    const uncertainStatus: ReceiptStatusSummary = {
      kind: "receipt_status_summary",
      runId: "run_reconciliation_quarantine",
      effectId: "effect_uncertain_status",
      receiptId: "receipt_uncertain_status",
      status: "unknown",
      certainty: "uncertain",
      observedAt: freshObservedAt,
    };

    const report = reconcileAcceptedEvidence({
      runId: "run_reconciliation_quarantine",
      checkedAt,
      acceptedEffectRequests: [request],
      acceptedReceipts: [uncertainReceipt],
      receiptStatusSummaries: [uncertainStatus],
    });

    expect(report.outcome).toBe("quarantine_recommended");
    expect(report.mismatches.map((mismatch) => mismatch.type)).toEqual([
      "receipt_missing",
      "uncertain_external_effect",
    ]);
    expect(
      report.quarantineRecommendations.map(
        (recommendation) => recommendation.reason,
      ),
    ).toEqual(["missing_receipt", "uncertain_external_effect"]);
  });

  it("stays domain-agnostic and contains no external execution hooks", () => {
    const forbiddenTokens = [
      "github",
      "pull_request",
      "weather",
      "genomics",
      "trading",
      "fetch(",
      "XMLHttpRequest",
      "child_process",
      "exec(",
      "spawn(",
      "Temporal",
      "LangGraph",
    ];
    const sourceRoot = fileURLToPath(new URL("./", import.meta.url));

    for (const sourceFile of sourceFiles(sourceRoot)) {
      if (sourceFile.endsWith(".test.ts")) {
        continue;
      }

      const source = readFileSync(sourceFile, "utf8");
      for (const token of forbiddenTokens) {
        expect(source, `${sourceFile} must not contain ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});

function observation(input: {
  readonly observationId: string;
  readonly observedState: JsonObject;
  readonly observedAt: string;
}): ExternalStateObservation {
  const payloadHash = canonicalObjectHash(input.observedState);
  return {
    observationId: input.observationId,
    runId: "run_reconciliation",
    observationType: "resource.snapshot",
    subjectType: "resource",
    subjectId: "resource_123",
    observedState: input.observedState,
    observedAt: input.observedAt,
    expiresAt,
    payloadHash,
    evidence: [
      evidenceRef({
        evidenceId: `ev_${input.observationId}`,
        kind: "external_observation",
        sourceEventId: `evt_${input.observationId}`,
        hash: payloadHash,
        observedAt: input.observedAt,
      }),
    ],
  };
}

function effectRequest(effectId: string): EffectRequest {
  return {
    effectId,
    commandId: `cmd_${effectId}`,
    runId: "run_reconciliation_quarantine",
    capabilityId: "capability.record",
    toolId: "tool.record",
    args: { id: effectId },
    sideEffectClass: "idempotent_write",
    requestedAt: freshObservedAt,
    idempotencyKey: `idem_${effectId}`,
  };
}

function receipt(input: {
  readonly effectId: string;
  readonly receiptId: string;
  readonly status: EffectReceipt["status"];
}): EffectReceipt {
  const payload = {
    actionVerb: "updated",
    subjectType: "actor",
    targetType: "record",
  };
  const payloadHash = canonicalObjectHash(payload);

  return {
    receiptId: input.receiptId,
    effectId: input.effectId,
    runId: "run_reconciliation_quarantine",
    capabilityId: "capability.record",
    receiptType: "record.updated",
    status: input.status,
    payload,
    payloadHash,
    evidence: [
      evidenceRef({
        evidenceId: `ev_${input.receiptId}`,
        kind: "effect_receipt",
        sourceEventId: `evt_${input.receiptId}`,
        hash: payloadHash,
        observedAt: freshObservedAt,
      }),
    ],
    observedAt: freshObservedAt,
  };
}

function evidenceRef(
  input: Pick<
    EvidenceRef,
    "evidenceId" | "kind" | "sourceEventId" | "hash" | "observedAt"
  >,
): EvidenceRef {
  return {
    ...input,
    sensitivity: "internal",
  };
}

function sourceFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...sourceFiles(fullPath));
      continue;
    }

    if (fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}
