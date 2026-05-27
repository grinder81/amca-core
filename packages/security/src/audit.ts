import { parseRunEvent } from "@amca/contracts";
import type { RunEvent } from "@amca/protocol";

import { assertCapability } from "./policy.js";
import { redactRunEvents } from "./redaction.js";
import type {
  AuditExportInput,
  ReleaseAuditDecisionSummary,
  ReleaseAuditMismatchSummary,
  ReleaseAuditReport,
} from "./types.js";

export function exportReleaseAuditReport(
  input: AuditExportInput,
): ReleaseAuditReport {
  assertCapability(input.context, "audit:export");

  const events = input.events.map((event) => parseRunEvent(event));
  const decisions: ReleaseAuditDecisionSummary[] = [];
  const mismatches: ReleaseAuditMismatchSummary[] = [];

  for (const event of events) {
    if (event.type === "ReleaseDecided") {
      const decision = (event as RunEvent<"ReleaseDecided">).payload.decision;
      decisions.push({
        status: decision.status,
        ...(decision.proofId === undefined
          ? {}
          : { proofId: decision.proofId }),
        approvedClaimIds: decision.approvedClaimIds,
        blockingMismatchIds: decision.blockingMismatchIds,
      });
    }

    if (event.type === "MismatchDetected") {
      const mismatch = (event as RunEvent<"MismatchDetected">).payload.mismatch;
      mismatches.push({
        mismatchId: mismatch.mismatchId,
        type: mismatch.type,
        ...(mismatch.claimId === undefined
          ? {}
          : { claimId: mismatch.claimId }),
      });
    }
  }

  return {
    runId: input.runId,
    generatedFor: {
      tenantId: input.context.tenantId,
      principalId: input.context.principal.principalId,
    },
    proofUsable: false,
    containsRawEvidence: false,
    decisions,
    mismatches,
    eventCount: events.length,
    redactedEvents: redactRunEvents(events, input.context),
  };
}
