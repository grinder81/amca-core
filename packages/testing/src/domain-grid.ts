import { defineCapability, type CapabilityContract } from "@amca/capabilities";
import { hashRunEventPayload, InMemoryRunKernel } from "@amca/kernel";
import type {
  Claim,
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  FinalCandidate,
  JsonObject,
  ReleaseDecision,
  RunEvent,
} from "@amca/protocol";

export type DomainGridDomainId =
  | "coding"
  | "genomics_dna_qc"
  | "trading_analysis"
  | "weather_analysis";

export type DomainGridCaseKind = "supported" | "blocked";

export interface DomainGridDomain {
  readonly domainId: DomainGridDomainId;
  readonly label: string;
  readonly capabilityId: string;
  readonly testSuiteId: string;
  readonly analysisKind: string;
  readonly supportedStatement: string;
  readonly blockedStatement: string;
}

export interface DomainGridScenarioResult {
  readonly domain: DomainGridDomain;
  readonly caseKind: DomainGridCaseKind;
  readonly capability: CapabilityContract;
  readonly finalCandidate: FinalCandidate;
  readonly releaseDecision: ReleaseDecision;
  readonly events: readonly RunEvent[];
}

export const domainGridDomains = [
  {
    domainId: "coding",
    label: "Coding static analysis",
    capabilityId: "coding.static_analysis_checks",
    testSuiteId: "coding.static_analysis",
    analysisKind: "static_analysis",
    supportedStatement: "Coding static analysis checks passed.",
    blockedStatement:
      "Coding static analysis checks passed without admitted evidence.",
  },
  {
    domainId: "trading_analysis",
    label: "Trading analysis controls",
    capabilityId: "trading.analysis_checks",
    testSuiteId: "trading.risk_analysis",
    analysisKind: "risk_analysis",
    supportedStatement: "Trading analysis controls passed.",
    blockedStatement:
      "Trading analysis controls passed without admitted evidence.",
  },
  {
    domainId: "genomics_dna_qc",
    label: "Genomics DNA QC",
    capabilityId: "genomics.dna_qc_checks",
    testSuiteId: "genomics.dna_qc",
    analysisKind: "quality_control",
    supportedStatement: "DNA QC checks passed.",
    blockedStatement: "DNA QC checks passed without admitted evidence.",
  },
  {
    domainId: "weather_analysis",
    label: "Weather analysis validation",
    capabilityId: "weather.analysis_checks",
    testSuiteId: "weather.forecast_validation",
    analysisKind: "forecast_validation",
    supportedStatement: "Weather analysis validation passed.",
    blockedStatement:
      "Weather analysis validation passed without admitted evidence.",
  },
] as const satisfies readonly DomainGridDomain[];

export const domainGridCapabilities = domainGridDomains.map((domain) =>
  defineCapability(domainCapability(domain)),
);

export function runDomainGridScenario(
  domain: DomainGridDomain,
  caseKind: DomainGridCaseKind,
): DomainGridScenarioResult {
  const runId = `domain_grid_${domain.domainId}_${caseKind}`;
  const kernel = new InMemoryRunKernel({
    runId,
    clock: () => "2026-05-25T12:00:10.000Z",
  });
  kernel.startRun({
    eventId: `evt_${runId}_started`,
    occurredAt: "2026-05-25T12:00:00.000Z",
    profile: "standard",
    metadata: {
      domainId: domain.domainId,
      domainGrid: true,
    },
  });

  let evidenceRefs: readonly EvidenceRef[] = [];
  if (caseKind === "supported") {
    const request = effectRequest(runId, domain);
    kernel.recordEffectRequest(request, {
      eventId: `evt_${runId}_effect_requested`,
      occurredAt: "2026-05-25T12:00:01.000Z",
    });
    const receiptPayload = domainReceiptPayload(domain, "passed");
    const receiptPayloadHash = hashRunEventPayload(receiptPayload);
    const receiptEventId = `evt_${runId}_effect_receipt`;
    const evidenceRef: EvidenceRef = {
      evidenceId: `ev_${runId}_test_run`,
      kind: "effect_receipt",
      sourceEventId: receiptEventId,
      hash: receiptPayloadHash,
      observedAt: "2026-05-25T12:00:02.000Z",
      sensitivity: "internal",
      metadata: {
        domainId: domain.domainId,
        redaction: "summary_only",
      },
    };
    const receipt: EffectReceipt = {
      receiptId: `receipt_${runId}_test_run`,
      effectId: request.effectId,
      runId,
      capabilityId: domain.capabilityId,
      receiptType: "test_run",
      status: "succeeded",
      payload: receiptPayload,
      payloadHash: receiptPayloadHash,
      evidence: [evidenceRef],
      observedAt: "2026-05-25T12:00:02.000Z",
    };
    kernel.recordEffectReceipt(receipt, {
      eventId: receiptEventId,
      occurredAt: "2026-05-25T12:00:02.000Z",
    });
    evidenceRefs = [evidenceRef];
  }

  const finalCandidate = candidateWith(runId, domain, evidenceRefs, caseKind);
  const result = kernel.submitFinalCandidate(finalCandidate, {
    eventId: `evt_${runId}_proposal`,
    proofEventId: `evt_${runId}_proof`,
    releaseEventId: `evt_${runId}_release`,
    finalReleasedEventId: `evt_${runId}_final_released`,
    occurredAt: "2026-05-25T12:00:05.000Z",
    generatedAt: "2026-05-25T12:00:05.000Z",
  });

  return {
    domain,
    caseKind,
    capability: defineCapability(domainCapability(domain)),
    finalCandidate,
    releaseDecision: result.decision,
    events: kernel.events(),
  };
}

function domainCapability(domain: DomainGridDomain): CapabilityContract {
  return {
    schemaVersion: 1,
    capabilityId: domain.capabilityId,
    profile: "standard",
    sideEffectClass: "compute",
    description:
      `${domain.label} capability contract. This is a domain-lite AMCA ` +
      "acceptance example; it declares schemas and deterministic proof requirements only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["testSuiteId", "analysisKind"],
      properties: {
        testSuiteId: {
          const: domain.testSuiteId,
        },
        analysisKind: {
          const: domain.analysisKind,
        },
      },
    },
    receiptSchema: {
      type: "object",
      additionalProperties: false,
      required: ["result", "testSuiteId", "analysisKind", "completedAt"],
      properties: {
        result: {
          enum: ["passed", "failed"],
        },
        testSuiteId: {
          const: domain.testSuiteId,
        },
        analysisKind: {
          const: domain.analysisKind,
        },
        completedAt: {
          type: "string",
          format: "date-time",
        },
      },
    },
    evidence: [
      {
        evidenceKind: "effect_receipt",
        receiptType: "test_run",
        description:
          "The domain-lite analysis receipt admitted by EffectReceiptRecorded.",
      },
    ],
    supportedClaims: [
      {
        claimType: "test_result",
        predicateKind: "test_result",
        requiredReceiptType: "test_run",
        expectedStatuses: ["passed"],
      },
    ],
    proofRules: [testResultProofRule()],
    metadata: {
      domainGrid: true,
      runtimeImplemented: false,
      coreModificationRequired: false,
    },
  };
}

function testResultProofRule(): CapabilityContract["proofRules"][number] {
  return {
    ruleId: "amca.v0.proof.test_result",
    version: 1,
    claimType: "test_result",
    predicateKind: "test_result",
    description:
      "A test-result claim is supported by a matching successful test-run receipt.",
    evidence: [
      {
        requirementId: "test_result.effect_receipt",
        evidenceKind: "effect_receipt",
        source: "claim.evidenceRefs",
        minimumCount: 1,
        resolvesTo: "effect_receipt",
      },
    ],
    match: {
      operator: "all",
      clauses: [
        {
          kind: "field_equals",
          left: {
            source: "effect_receipt",
            path: "effectReceipt.receiptType",
          },
          right: {
            source: "claim_predicate",
            path: "claim.predicate.requiredReceiptType",
          },
          presence: "always",
        },
        {
          kind: "field_equals",
          left: {
            source: "effect_receipt",
            path: "effectReceipt.status",
          },
          right: {
            source: "literal",
            value: "succeeded",
          },
          presence: "always",
        },
        {
          kind: "field_equals",
          left: {
            source: "effect_receipt",
            path: "effectReceipt.capabilityId",
          },
          right: {
            source: "claim_predicate",
            path: "claim.predicate.capabilityId",
          },
          presence: "always",
        },
        {
          kind: "field_equals",
          left: {
            source: "effect_receipt",
            path: "effectReceipt.payload.result",
          },
          right: {
            source: "claim_predicate",
            path: "claim.predicate.expectedStatus",
          },
          presence: "always",
        },
        {
          kind: "field_equals",
          left: {
            source: "effect_receipt",
            path: "effectReceipt.payload.testSuiteId",
          },
          right: {
            source: "claim_predicate",
            path: "claim.predicate.testSuiteId",
          },
          presence: "when_claim_field_present",
        },
      ],
    },
  };
}

function effectRequest(runId: string, domain: DomainGridDomain): EffectRequest {
  return {
    effectId: `effect_${runId}_analysis`,
    commandId: `command_${runId}_analysis`,
    runId,
    capabilityId: domain.capabilityId,
    toolId: `${domain.capabilityId}.contract_only`,
    args: {
      testSuiteId: domain.testSuiteId,
      analysisKind: domain.analysisKind,
    },
    sideEffectClass: "compute",
    requestedAt: "2026-05-25T12:00:01.000Z",
    idempotencyKey: `${runId}:${domain.testSuiteId}`,
  };
}

function candidateWith(
  runId: string,
  domain: DomainGridDomain,
  evidenceRefs: readonly EvidenceRef[],
  caseKind: DomainGridCaseKind,
): FinalCandidate {
  return {
    kind: "final_candidate",
    candidateId: `candidate_${runId}`,
    runId,
    claims: [domainClaim(domain, evidenceRefs, caseKind)],
  };
}

function domainClaim(
  domain: DomainGridDomain,
  evidenceRefs: readonly EvidenceRef[],
  caseKind: DomainGridCaseKind,
): Claim {
  return {
    claimId: `claim_${domain.domainId}_${caseKind}`,
    type: "test_result",
    statement:
      caseKind === "supported"
        ? domain.supportedStatement
        : domain.blockedStatement,
    predicate: {
      kind: "test_result",
      capabilityId: domain.capabilityId,
      expectedStatus: "passed",
      requiredReceiptType: "test_run",
      testSuiteId: domain.testSuiteId,
    },
    evidenceRefs: [...evidenceRefs],
    criticality: "medium",
  };
}

function domainReceiptPayload(
  domain: DomainGridDomain,
  result: "passed" | "failed",
): JsonObject {
  return {
    result,
    testSuiteId: domain.testSuiteId,
    analysisKind: domain.analysisKind,
    completedAt: "2026-05-25T12:00:02.000Z",
  };
}
