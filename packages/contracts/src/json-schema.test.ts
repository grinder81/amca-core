import { describe, expect, it } from "vitest";

import { generateV0JsonSchemas, toContractJsonSchema } from "./json-schema.js";

describe("contract JSON Schema export", () => {
  it("exports the locked AMCA schema set", () => {
    const schemas = generateV0JsonSchemas();

    expect(Object.keys(schemas).sort()).toEqual([
      "approvalDenial",
      "approvalExpiry",
      "approvalGrant",
      "approvalRequest",
      "blockedDecision",
      "claim",
      "claimPredicate",
      "claimProof",
      "currentStatePredicate",
      "effectReceipt",
      "effectRequest",
      "evidenceRef",
      "externalStateObservation",
      "externalStateObservationCandidate",
      "finalCandidate",
      "historicalActionPredicate",
      "mismatch",
      "mutationCommandRequest",
      "mutationCommitted",
      "needsRepairDecision",
      "pendingEvidenceRef",
      "proofObject",
      "proposal",
      "quarantinedDecision",
      "receiptCandidate",
      "releaseDecision",
      "releasedDecision",
      "runEvent",
      "testResultPredicate",
      "toolCommandRequest",
      "writePreflightCandidate",
      "writePreflightDecision",
      "writeQuarantineState",
    ]);
  });

  it("keeps strict object boundaries in exported schemas", () => {
    const evidenceSchema = toContractJsonSchema("evidenceRef");
    const pendingEvidenceSchema = toContractJsonSchema("pendingEvidenceRef");

    expect(evidenceSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        evidenceId: { minLength: 1, type: "string" },
        kind: {
          enum: [
            "effect_receipt",
            "external_observation",
            "artifact",
            "test_output",
            "ledger_event",
          ],
          type: "string",
        },
        hash: {
          pattern: "^sha256:[a-f0-9]{64}$",
          type: "string",
        },
      },
      type: "object",
    });
    expect(pendingEvidenceSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        admissionStatus: { const: "pending", type: "string" },
        pendingAdmissionToken: { minLength: 1, type: "string" },
      },
      type: "object",
    });
    expect(pendingEvidenceSchema.properties).not.toHaveProperty(
      "sourceEventId",
    );
  });
});
