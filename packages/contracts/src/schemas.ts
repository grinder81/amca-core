import type {
  ApprovalDenial,
  ApprovalDeniedPayload,
  ApprovalExpiry,
  ApprovalExpiredPayload,
  ApprovalGrant,
  ApprovalGrantedPayload,
  ApprovalRequest,
  ApprovalRequestedPayload,
  ApprovalScope,
  BlockedDecision,
  Claim,
  ClaimPredicate,
  ClaimProof,
  ClaimType,
  Criticality,
  CurrentStateOperator,
  CurrentStatePredicate,
  EffectReceipt,
  EffectReceiptRecordedPayload,
  EffectRequest,
  EffectRequestedPayload,
  EffectStatus,
  EvidenceAdmissionStatus,
  EvidenceKind,
  EvidenceRef,
  EvidenceSensitivity,
  ExternalStateObservation,
  ExternalStateObservationCandidate,
  ExternalStateObservedPayload,
  FinalCandidate,
  FinalReleasedPayload,
  HistoricalActionPredicate,
  HistoricalActionVerb,
  ISODateTimeString,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  Mismatch,
  MismatchDetectedPayload,
  MismatchType,
  MutationCommandRequest,
  MutationCommitted,
  MutationCommittedPayload,
  MutationDeleteOperation,
  MutationMergeOperation,
  MutationOperation,
  MutationPrecondition,
  MutationProvenance,
  MutationProvenanceKind,
  MutationSetOperation,
  MutationTarget,
  NeedsRepairDecision,
  PendingEvidenceRef,
  Proposal,
  ProposalReceivedPayload,
  ProofGeneratedPayload,
  ProofObject,
  ProofVerdict,
  QuarantineReason,
  QuarantinedDecision,
  ReceiptCandidate,
  ReleaseDecidedPayload,
  ReleaseDecision,
  ReleasedDecision,
  RunEvent,
  RunEventType,
  RunStartedPayload,
  Sha256Hash,
  SideEffectClass,
  TestResultPredicate,
  ToolCommandRequest,
  WritePreflightBlockReason,
  WritePreflightCandidate,
  WritePreflightDecidedPayload,
  WritePreflightDecision,
  WritePreflightRequestedPayload,
  WritePreflightStatus,
  WriteQuarantineReason,
  WriteQuarantineState,
  WriteQuarantineStatus,
  WriteQuarantinedPayload,
  WriteSideEffectClass,
  WritePreflightApprovalScope,
  MutationApprovalScope,
} from "@amca/protocol";
import { z } from "zod";

function protocolSchema<T>(schema: z.ZodType): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

export const NonEmptyStringSchema = z.string().min(1);

export const ISODateTimeStringSchema = z.iso.datetime({
  offset: true,
}) satisfies z.ZodType<ISODateTimeString>;

export const Sha256HashSchema = protocolSchema<Sha256Hash>(
  z.string().regex(/^sha256:[a-f0-9]{64}$/, {
    message: "Expected a sha256-prefixed lowercase hex digest",
  }),
);

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]) satisfies z.ZodType<JsonPrimitive>;

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(
  z.string(),
  JsonValueSchema,
) satisfies z.ZodType<JsonObject>;

export const SideEffectClassSchema = z.enum([
  "read",
  "compute",
  "idempotent_write",
  "reversible_write",
  "irreversible_write",
  "critical_write",
]) satisfies z.ZodType<SideEffectClass>;

export const WriteSideEffectClassSchema = z.enum([
  "idempotent_write",
  "reversible_write",
  "irreversible_write",
  "critical_write",
]) satisfies z.ZodType<WriteSideEffectClass>;

export const EffectStatusSchema = z.enum([
  "succeeded",
  "failed",
  "unknown",
]) satisfies z.ZodType<EffectStatus>;

export const WritePreflightStatusSchema = z.enum([
  "allowed",
  "denied",
  "quarantined",
]) satisfies z.ZodType<WritePreflightStatus>;

export const WritePreflightBlockReasonSchema = z.enum([
  "adapter_not_certified",
  "capability_not_registered",
  "critical_approval_required",
  "missing_idempotency_key",
  "policy_denied",
  "tool_not_registered",
  "unsupported_side_effect_class",
]) satisfies z.ZodType<WritePreflightBlockReason>;

export const WriteQuarantineReasonSchema = z.enum([
  "adapter_not_certified",
  "critical_approval_required",
  "uncertain_external_effect",
  "unsupported_side_effect_class",
]) satisfies z.ZodType<WriteQuarantineReason>;

export const WriteQuarantineStatusSchema = z.enum([
  "quarantined",
]) satisfies z.ZodType<WriteQuarantineStatus>;

export const EvidenceKindSchema = z.enum([
  "effect_receipt",
  "external_observation",
  "artifact",
  "test_output",
  "ledger_event",
]) satisfies z.ZodType<EvidenceKind>;

export const EvidenceSensitivitySchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]) satisfies z.ZodType<EvidenceSensitivity>;

export const EvidenceAdmissionStatusSchema = z.enum([
  "pending",
  "admitted",
]) satisfies z.ZodType<EvidenceAdmissionStatus>;

export const CriticalitySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]) satisfies z.ZodType<Criticality>;

export const ClaimTypeSchema = z.enum([
  "historical_action",
  "test_result",
  "current_state",
]) satisfies z.ZodType<ClaimType>;

export const HistoricalActionVerbSchema = z.enum([
  "created",
  "updated",
  "deleted",
  "sent",
  "opened",
  "executed",
]) satisfies z.ZodType<HistoricalActionVerb>;

export const CurrentStateOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
]) satisfies z.ZodType<CurrentStateOperator>;

export const ProofVerdictSchema = z.enum([
  "pass",
  "fail",
  "needs_repair",
  "quarantine",
]) satisfies z.ZodType<ProofVerdict>;

export const MismatchTypeSchema = z.enum([
  "missing_evidence",
  "unsupported_claim",
  "stale_external_state",
  "unverified_receipt",
  "policy_violation",
  "unauthorized_tool",
  "schema_mismatch",
  "uncertain_external_effect",
]) satisfies z.ZodType<MismatchType>;

export const QuarantineReasonSchema = z.enum([
  "uncertain_external_effect",
  "inconsistent_evidence",
  "policy_required",
  "unrecoverable_schema_error",
]) satisfies z.ZodType<QuarantineReason>;

export const RunEventTypeSchema = z.enum([
  "RunStarted",
  "ProposalReceived",
  "EffectRequested",
  "WritePreflightRequested",
  "WritePreflightDecided",
  "WriteQuarantined",
  "MutationCommitted",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalDenied",
  "ApprovalExpired",
  "EffectReceiptRecorded",
  "ExternalStateObserved",
  "ProofGenerated",
  "MismatchDetected",
  "ReleaseDecided",
  "FinalReleased",
]) satisfies z.ZodType<RunEventType>;

export const EvidenceRefSchema = protocolSchema<EvidenceRef>(
  z.strictObject({
    admissionStatus: z.literal("admitted").optional(),
    evidenceId: NonEmptyStringSchema,
    kind: EvidenceKindSchema,
    sourceEventId: NonEmptyStringSchema,
    hash: Sha256HashSchema,
    observedAt: ISODateTimeStringSchema,
    sensitivity: EvidenceSensitivitySchema,
    artifactUri: NonEmptyStringSchema.optional(),
    expiresAt: ISODateTimeStringSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  }),
);

export const PendingEvidenceRefSchema = protocolSchema<PendingEvidenceRef>(
  z.strictObject({
    admissionStatus: z.literal("pending"),
    pendingAdmissionToken: NonEmptyStringSchema,
    evidenceId: NonEmptyStringSchema,
    kind: EvidenceKindSchema,
    hash: Sha256HashSchema,
    observedAt: ISODateTimeStringSchema,
    sensitivity: EvidenceSensitivitySchema,
    artifactUri: NonEmptyStringSchema.optional(),
    expiresAt: ISODateTimeStringSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  }),
);

export const ExternalStateObservationSchema =
  protocolSchema<ExternalStateObservation>(
    z.strictObject({
      observationId: NonEmptyStringSchema,
      runId: NonEmptyStringSchema,
      observationType: NonEmptyStringSchema,
      subjectType: NonEmptyStringSchema,
      subjectId: NonEmptyStringSchema,
      observedState: JsonObjectSchema,
      observedAt: ISODateTimeStringSchema,
      expiresAt: ISODateTimeStringSchema,
      payloadHash: Sha256HashSchema,
      evidence: z.array(EvidenceRefSchema),
    }),
  );

export const ExternalStateObservationCandidateSchema =
  protocolSchema<ExternalStateObservationCandidate>(
    z.strictObject({
      observationId: NonEmptyStringSchema,
      runId: NonEmptyStringSchema,
      observationType: NonEmptyStringSchema,
      subjectType: NonEmptyStringSchema,
      subjectId: NonEmptyStringSchema,
      observedState: JsonObjectSchema,
      observedAt: ISODateTimeStringSchema,
      expiresAt: ISODateTimeStringSchema,
      payloadHash: Sha256HashSchema,
      evidence: z.array(PendingEvidenceRefSchema),
    }),
  );

export const EffectRequestSchema = protocolSchema<EffectRequest>(
  z.strictObject({
    effectId: NonEmptyStringSchema,
    commandId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    capabilityId: NonEmptyStringSchema,
    toolId: NonEmptyStringSchema,
    args: JsonObjectSchema,
    sideEffectClass: SideEffectClassSchema,
    requestedAt: ISODateTimeStringSchema,
    idempotencyKey: NonEmptyStringSchema.optional(),
  }),
);

export const EffectReceiptSchema = protocolSchema<EffectReceipt>(
  z.strictObject({
    receiptId: NonEmptyStringSchema,
    effectId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    capabilityId: NonEmptyStringSchema,
    receiptType: NonEmptyStringSchema,
    status: EffectStatusSchema,
    payload: JsonObjectSchema,
    payloadHash: Sha256HashSchema,
    evidence: z.array(EvidenceRefSchema),
    observedAt: ISODateTimeStringSchema,
    externalRef: NonEmptyStringSchema.optional(),
  }),
);

export const ReceiptCandidateSchema = protocolSchema<ReceiptCandidate>(
  z.strictObject({
    receiptId: NonEmptyStringSchema,
    effectId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    capabilityId: NonEmptyStringSchema,
    receiptType: NonEmptyStringSchema,
    status: EffectStatusSchema,
    payload: JsonObjectSchema,
    payloadHash: Sha256HashSchema,
    evidence: z.array(PendingEvidenceRefSchema),
    observedAt: ISODateTimeStringSchema,
    externalRef: NonEmptyStringSchema.optional(),
  }),
);

export const WritePreflightCandidateSchema =
  protocolSchema<WritePreflightCandidate>(
    z.strictObject({
      kind: z.literal("write_preflight_candidate"),
      preflightId: NonEmptyStringSchema,
      runId: NonEmptyStringSchema,
      commandId: NonEmptyStringSchema,
      capabilityId: NonEmptyStringSchema,
      toolId: NonEmptyStringSchema,
      sideEffectClass: WriteSideEffectClassSchema,
      argsHash: Sha256HashSchema,
      requestedAt: ISODateTimeStringSchema,
      idempotencyKey: NonEmptyStringSchema.optional(),
      metadata: JsonObjectSchema.optional(),
    }),
  );

export const WriteQuarantineStateSchema = protocolSchema<WriteQuarantineState>(
  z.strictObject({
    kind: z.literal("write_quarantine_state"),
    quarantineId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    preflightId: NonEmptyStringSchema,
    commandId: NonEmptyStringSchema,
    capabilityId: NonEmptyStringSchema,
    toolId: NonEmptyStringSchema,
    sideEffectClass: WriteSideEffectClassSchema,
    status: WriteQuarantineStatusSchema,
    reason: WriteQuarantineReasonSchema,
    message: NonEmptyStringSchema,
    quarantinedAt: ISODateTimeStringSchema,
    idempotencyKey: NonEmptyStringSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  }),
);

export const WritePreflightAllowedDecisionSchema = z.strictObject({
  kind: z.literal("write_preflight_decision"),
  status: z.literal("allowed"),
  runId: NonEmptyStringSchema,
  preflightId: NonEmptyStringSchema,
  commandId: NonEmptyStringSchema,
  capabilityId: NonEmptyStringSchema,
  toolId: NonEmptyStringSchema,
  sideEffectClass: WriteSideEffectClassSchema,
  idempotencyKey: NonEmptyStringSchema,
  decidedAt: ISODateTimeStringSchema,
  approvalId: NonEmptyStringSchema.optional(),
});

export const WritePreflightDeniedDecisionSchema = z.strictObject({
  kind: z.literal("write_preflight_decision"),
  status: z.literal("denied"),
  runId: NonEmptyStringSchema,
  preflightId: NonEmptyStringSchema,
  commandId: NonEmptyStringSchema,
  capabilityId: NonEmptyStringSchema,
  toolId: NonEmptyStringSchema,
  sideEffectClass: WriteSideEffectClassSchema,
  reason: WritePreflightBlockReasonSchema,
  message: NonEmptyStringSchema,
  decidedAt: ISODateTimeStringSchema,
  idempotencyKey: NonEmptyStringSchema.optional(),
});

export const WritePreflightQuarantinedDecisionSchema = z.strictObject({
  kind: z.literal("write_preflight_decision"),
  status: z.literal("quarantined"),
  runId: NonEmptyStringSchema,
  preflightId: NonEmptyStringSchema,
  commandId: NonEmptyStringSchema,
  capabilityId: NonEmptyStringSchema,
  toolId: NonEmptyStringSchema,
  sideEffectClass: WriteSideEffectClassSchema,
  quarantine: WriteQuarantineStateSchema,
  decidedAt: ISODateTimeStringSchema,
  idempotencyKey: NonEmptyStringSchema.optional(),
});

export const WritePreflightDecisionSchema =
  protocolSchema<WritePreflightDecision>(
    z.discriminatedUnion("status", [
      WritePreflightAllowedDecisionSchema,
      WritePreflightDeniedDecisionSchema,
      WritePreflightQuarantinedDecisionSchema,
    ]),
  );

export const MutationSetOperationSchema = protocolSchema<MutationSetOperation>(
  z.strictObject({
    kind: z.literal("set"),
    path: NonEmptyStringSchema,
    value: JsonValueSchema,
  }),
);

export const MutationMergeOperationSchema =
  protocolSchema<MutationMergeOperation>(
    z.strictObject({
      kind: z.literal("merge"),
      path: NonEmptyStringSchema,
      value: JsonObjectSchema,
    }),
  );

export const MutationDeleteOperationSchema =
  protocolSchema<MutationDeleteOperation>(
    z.strictObject({
      kind: z.literal("delete"),
      path: NonEmptyStringSchema,
    }),
  );

export const MutationOperationSchema = protocolSchema<MutationOperation>(
  z.union([
    MutationSetOperationSchema,
    MutationMergeOperationSchema,
    MutationDeleteOperationSchema,
  ]),
);

export const MutationTargetSchema = protocolSchema<MutationTarget>(
  z.strictObject({
    stateRef: NonEmptyStringSchema,
  }),
);

export const MutationPreconditionSchema = protocolSchema<MutationPrecondition>(
  z.strictObject({
    expectedRevision: z.number().int().nonnegative(),
  }),
);

export const MutationProvenanceKindSchema = z.enum([
  "effect_receipt",
  "external_observation",
  "human_input",
  "system_policy",
]) satisfies z.ZodType<MutationProvenanceKind>;

export const MutationProvenanceSchema = protocolSchema<MutationProvenance>(
  z.strictObject({
    kind: MutationProvenanceKindSchema,
    sourceEventId: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    actorId: NonEmptyStringSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  }),
);

export const MutationCommandRequestSchema =
  protocolSchema<MutationCommandRequest>(
    z.strictObject({
      kind: z.literal("mutation_command_request"),
      commandId: NonEmptyStringSchema,
      mutationId: NonEmptyStringSchema,
      runId: NonEmptyStringSchema,
      target: MutationTargetSchema,
      operation: MutationOperationSchema,
      precondition: MutationPreconditionSchema,
      provenance: MutationProvenanceSchema,
      requestedAt: ISODateTimeStringSchema,
      payloadHash: Sha256HashSchema,
      metadata: JsonObjectSchema.optional(),
    }),
  );

export const MutationCommittedSchema = protocolSchema<MutationCommitted>(
  z.strictObject({
    kind: z.literal("mutation_committed"),
    mutationId: NonEmptyStringSchema,
    commandId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    stateRef: NonEmptyStringSchema,
    previousRevision: z.number().int().nonnegative(),
    newRevision: z.number().int().positive(),
    operation: MutationOperationSchema,
    provenance: MutationProvenanceSchema,
    committedAt: ISODateTimeStringSchema,
    payloadHash: Sha256HashSchema,
    metadata: JsonObjectSchema.optional(),
  }),
).refine((mutation) => mutation.newRevision === mutation.previousRevision + 1, {
  message: "MutationCommitted newRevision must advance previousRevision by one",
  path: ["newRevision"],
});

export const WritePreflightApprovalScopeSchema =
  protocolSchema<WritePreflightApprovalScope>(
    z.strictObject({
      kind: z.literal("write_preflight"),
      preflightId: NonEmptyStringSchema,
      commandId: NonEmptyStringSchema,
      capabilityId: NonEmptyStringSchema,
      toolId: NonEmptyStringSchema,
      sideEffectClass: WriteSideEffectClassSchema,
      idempotencyKey: NonEmptyStringSchema.optional(),
    }),
  );

export const MutationApprovalScopeSchema =
  protocolSchema<MutationApprovalScope>(
    z.strictObject({
      kind: z.literal("mutation"),
      commandId: NonEmptyStringSchema,
      mutationId: NonEmptyStringSchema,
      stateRef: NonEmptyStringSchema,
    }),
  );

export const ApprovalScopeSchema = protocolSchema<ApprovalScope>(
  z.union([WritePreflightApprovalScopeSchema, MutationApprovalScopeSchema]),
);

export const ApprovalRequestSchema = protocolSchema<ApprovalRequest>(
  z.strictObject({
    kind: z.literal("approval_request"),
    approvalId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    requestedBy: NonEmptyStringSchema,
    scope: ApprovalScopeSchema,
    criticality: CriticalitySchema,
    reason: NonEmptyStringSchema,
    requestedAt: ISODateTimeStringSchema,
    expiresAt: ISODateTimeStringSchema,
    metadata: JsonObjectSchema.optional(),
  }),
).refine(
  (request) => Date.parse(request.requestedAt) <= Date.parse(request.expiresAt),
  {
    message: "ApprovalRequest expiresAt must be at or after requestedAt",
    path: ["expiresAt"],
  },
);

export const ApprovalGrantSchema = protocolSchema<ApprovalGrant>(
  z.strictObject({
    kind: z.literal("approval_grant"),
    approvalId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    approverId: NonEmptyStringSchema,
    scope: ApprovalScopeSchema,
    grantedAt: ISODateTimeStringSchema,
    expiresAt: ISODateTimeStringSchema,
    metadata: JsonObjectSchema.optional(),
  }),
).refine(
  (grant) => Date.parse(grant.grantedAt) <= Date.parse(grant.expiresAt),
  {
    message: "ApprovalGrant expiresAt must be at or after grantedAt",
    path: ["expiresAt"],
  },
);

export const ApprovalDenialSchema = protocolSchema<ApprovalDenial>(
  z.strictObject({
    kind: z.literal("approval_denial"),
    approvalId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    approverId: NonEmptyStringSchema,
    scope: ApprovalScopeSchema,
    reason: NonEmptyStringSchema,
    deniedAt: ISODateTimeStringSchema,
    metadata: JsonObjectSchema.optional(),
  }),
);

export const ApprovalExpirySchema = protocolSchema<ApprovalExpiry>(
  z.strictObject({
    kind: z.literal("approval_expiry"),
    approvalId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    scope: ApprovalScopeSchema,
    expiredAt: ISODateTimeStringSchema,
    reason: z.literal("expired"),
    metadata: JsonObjectSchema.optional(),
  }),
);

export const HistoricalActionPredicateSchema =
  protocolSchema<HistoricalActionPredicate>(
    z.strictObject({
      kind: z.literal("historical_action"),
      actionVerb: HistoricalActionVerbSchema,
      subjectType: NonEmptyStringSchema,
      targetType: NonEmptyStringSchema,
      capabilityId: NonEmptyStringSchema,
      requiredReceiptType: NonEmptyStringSchema,
      subjectId: NonEmptyStringSchema.optional(),
      targetId: NonEmptyStringSchema.optional(),
    }),
  );

export const TestResultPredicateSchema = protocolSchema<TestResultPredicate>(
  z.strictObject({
    kind: z.literal("test_result"),
    capabilityId: NonEmptyStringSchema,
    expectedStatus: z.enum(["passed", "failed"]),
    requiredReceiptType: z.literal("test_run"),
    testSuiteId: NonEmptyStringSchema.optional(),
  }),
);

export const CurrentStatePredicateSchema =
  protocolSchema<CurrentStatePredicate>(
    z.strictObject({
      kind: z.literal("current_state"),
      subjectType: NonEmptyStringSchema,
      subjectId: NonEmptyStringSchema,
      property: NonEmptyStringSchema,
      operator: CurrentStateOperatorSchema,
      expectedValue: z.union([z.string(), z.number(), z.boolean()]),
      observationType: NonEmptyStringSchema,
      freshnessRequirementMs: z.number().int().positive(),
    }),
  );

export const ClaimPredicateSchema = protocolSchema<ClaimPredicate>(
  z.union([
    HistoricalActionPredicateSchema,
    TestResultPredicateSchema,
    CurrentStatePredicateSchema,
  ]),
);

export const ClaimSchema = protocolSchema<Claim>(
  z
    .strictObject({
      claimId: NonEmptyStringSchema,
      type: ClaimTypeSchema,
      statement: NonEmptyStringSchema,
      predicate: ClaimPredicateSchema,
      evidenceRefs: z.array(EvidenceRefSchema),
      criticality: CriticalitySchema,
    })
    .refine((claim) => claim.type === claim.predicate.kind, {
      message: "Claim type must match predicate kind",
      path: ["predicate", "kind"],
    }),
);

export const ToolCommandRequestSchema = protocolSchema<ToolCommandRequest>(
  z.strictObject({
    kind: z.literal("tool_command_request"),
    commandId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    capabilityId: NonEmptyStringSchema,
    toolId: NonEmptyStringSchema,
    args: JsonObjectSchema,
    sideEffectClass: SideEffectClassSchema,
    idempotencyKey: NonEmptyStringSchema.optional(),
    requiredEvidence: z.array(EvidenceRefSchema).optional(),
  }),
);

export const MutationCommandProposalSchema =
  protocolSchema<MutationCommandRequest>(MutationCommandRequestSchema);

export const FinalCandidateSchema = protocolSchema<FinalCandidate>(
  z.strictObject({
    kind: z.literal("final_candidate"),
    candidateId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    claims: z.array(ClaimSchema).min(1),
    narrativeDraft: NonEmptyStringSchema.optional(),
  }),
);

export const ProposalSchema = protocolSchema<Proposal>(
  z.union([
    ToolCommandRequestSchema,
    MutationCommandProposalSchema,
    FinalCandidateSchema,
  ]),
);

export const MismatchSchema = protocolSchema<Mismatch>(
  z.strictObject({
    mismatchId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    type: MismatchTypeSchema,
    blocking: z.boolean(),
    message: NonEmptyStringSchema,
    claimId: NonEmptyStringSchema.optional(),
    expected: JsonValueSchema.optional(),
    actual: JsonValueSchema.optional(),
  }),
);

export const ClaimProofSchema = protocolSchema<ClaimProof>(
  z.strictObject({
    claimId: NonEmptyStringSchema,
    supported: z.boolean(),
    evidenceRefs: z.array(EvidenceRefSchema),
    mismatchIds: z.array(NonEmptyStringSchema),
  }),
);

export const ProofObjectSchema = protocolSchema<ProofObject>(
  z.strictObject({
    proofId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    candidateId: NonEmptyStringSchema,
    generatedAt: ISODateTimeStringSchema,
    verdict: ProofVerdictSchema,
    claims: z.array(ClaimProofSchema),
    approvedClaimIds: z.array(NonEmptyStringSchema),
    rejectedClaimIds: z.array(NonEmptyStringSchema),
    blockingMismatches: z.array(MismatchSchema),
    evaluatedClaims: z.array(ClaimSchema),
  }),
);

export const ReleasedDecisionSchema = protocolSchema<ReleasedDecision>(
  z.strictObject({
    status: z.literal("released"),
    runId: NonEmptyStringSchema,
    proofId: NonEmptyStringSchema,
    approvedClaimIds: z.array(NonEmptyStringSchema),
    blockingMismatchIds: z.tuple([]),
    finalMessage: NonEmptyStringSchema.optional(),
  }),
);

export const BlockedDecisionSchema = protocolSchema<BlockedDecision>(
  z.strictObject({
    status: z.literal("blocked"),
    runId: NonEmptyStringSchema,
    proofId: NonEmptyStringSchema,
    approvedClaimIds: z.array(NonEmptyStringSchema),
    blockingMismatchIds: z.array(NonEmptyStringSchema).min(1),
    repairHints: z.array(NonEmptyStringSchema).optional(),
  }),
);

export const NeedsRepairDecisionSchema = protocolSchema<NeedsRepairDecision>(
  z.strictObject({
    status: z.literal("needs_repair"),
    runId: NonEmptyStringSchema,
    proofId: NonEmptyStringSchema,
    approvedClaimIds: z.array(NonEmptyStringSchema),
    blockingMismatchIds: z.array(NonEmptyStringSchema).min(1),
    repairInstructions: z.array(NonEmptyStringSchema).min(1),
  }),
);

export const QuarantinedDecisionSchema = protocolSchema<QuarantinedDecision>(
  z.strictObject({
    status: z.literal("quarantined"),
    runId: NonEmptyStringSchema,
    approvedClaimIds: z.array(NonEmptyStringSchema),
    blockingMismatchIds: z.array(NonEmptyStringSchema).min(1),
    reason: QuarantineReasonSchema,
    proofId: NonEmptyStringSchema.optional(),
  }),
);

export const ReleaseDecisionSchema = protocolSchema<ReleaseDecision>(
  z.union([
    ReleasedDecisionSchema,
    BlockedDecisionSchema,
    NeedsRepairDecisionSchema,
    QuarantinedDecisionSchema,
  ]),
);

export const RunStartedPayloadSchema = protocolSchema<RunStartedPayload>(
  z.strictObject({
    runId: NonEmptyStringSchema,
    profile: NonEmptyStringSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  }),
);

export const ProposalReceivedPayloadSchema =
  protocolSchema<ProposalReceivedPayload>(
    z.strictObject({
      proposal: ProposalSchema,
    }),
  );

export const EffectRequestedPayloadSchema =
  protocolSchema<EffectRequestedPayload>(
    z.strictObject({
      effectRequest: EffectRequestSchema,
    }),
  );

export const WritePreflightRequestedPayloadSchema =
  protocolSchema<WritePreflightRequestedPayload>(
    z.strictObject({
      candidate: WritePreflightCandidateSchema,
    }),
  );

export const WritePreflightDecidedPayloadSchema =
  protocolSchema<WritePreflightDecidedPayload>(
    z.strictObject({
      decision: WritePreflightDecisionSchema,
    }),
  );

export const WriteQuarantinedPayloadSchema =
  protocolSchema<WriteQuarantinedPayload>(
    z.strictObject({
      quarantine: WriteQuarantineStateSchema,
    }),
  );

export const MutationCommittedPayloadSchema =
  protocolSchema<MutationCommittedPayload>(
    z.strictObject({
      mutation: MutationCommittedSchema,
    }),
  );

export const ApprovalRequestedPayloadSchema =
  protocolSchema<ApprovalRequestedPayload>(
    z.strictObject({
      request: ApprovalRequestSchema,
    }),
  );

export const ApprovalGrantedPayloadSchema =
  protocolSchema<ApprovalGrantedPayload>(
    z.strictObject({
      grant: ApprovalGrantSchema,
    }),
  );

export const ApprovalDeniedPayloadSchema =
  protocolSchema<ApprovalDeniedPayload>(
    z.strictObject({
      denial: ApprovalDenialSchema,
    }),
  );

export const ApprovalExpiredPayloadSchema =
  protocolSchema<ApprovalExpiredPayload>(
    z.strictObject({
      expiry: ApprovalExpirySchema,
    }),
  );

export const EffectReceiptRecordedPayloadSchema =
  protocolSchema<EffectReceiptRecordedPayload>(
    z.strictObject({
      receipt: EffectReceiptSchema,
    }),
  );

export const ExternalStateObservedPayloadSchema =
  protocolSchema<ExternalStateObservedPayload>(
    z.strictObject({
      observation: ExternalStateObservationSchema,
    }),
  );

export const ProofGeneratedPayloadSchema =
  protocolSchema<ProofGeneratedPayload>(
    z.strictObject({
      proof: ProofObjectSchema,
    }),
  );

export const MismatchDetectedPayloadSchema =
  protocolSchema<MismatchDetectedPayload>(
    z.strictObject({
      mismatch: MismatchSchema,
    }),
  );

export const ReleaseDecidedPayloadSchema =
  protocolSchema<ReleaseDecidedPayload>(
    z.strictObject({
      decision: ReleaseDecisionSchema,
    }),
  );

export const FinalReleasedPayloadSchema = protocolSchema<FinalReleasedPayload>(
  z.strictObject({
    decision: ReleasedDecisionSchema,
    candidate: FinalCandidateSchema,
  }),
);

const runEventBaseShape = {
  eventId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  sequence: z.number().int().nonnegative(),
  payloadHash: Sha256HashSchema,
  causationId: z.union([NonEmptyStringSchema, z.null()]),
  correlationId: z.union([NonEmptyStringSchema, z.null()]),
  occurredAt: ISODateTimeStringSchema,
} as const;

export const RunStartedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("RunStarted"),
  payload: RunStartedPayloadSchema,
});

export const ProposalReceivedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ProposalReceived"),
  payload: ProposalReceivedPayloadSchema,
});

export const EffectRequestedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("EffectRequested"),
  payload: EffectRequestedPayloadSchema,
});

export const WritePreflightRequestedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("WritePreflightRequested"),
  payload: WritePreflightRequestedPayloadSchema,
});

export const WritePreflightDecidedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("WritePreflightDecided"),
  payload: WritePreflightDecidedPayloadSchema,
});

export const WriteQuarantinedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("WriteQuarantined"),
  payload: WriteQuarantinedPayloadSchema,
});

export const MutationCommittedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("MutationCommitted"),
  payload: MutationCommittedPayloadSchema,
});

export const ApprovalRequestedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ApprovalRequested"),
  payload: ApprovalRequestedPayloadSchema,
});

export const ApprovalGrantedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ApprovalGranted"),
  payload: ApprovalGrantedPayloadSchema,
});

export const ApprovalDeniedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ApprovalDenied"),
  payload: ApprovalDeniedPayloadSchema,
});

export const ApprovalExpiredEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ApprovalExpired"),
  payload: ApprovalExpiredPayloadSchema,
});

export const EffectReceiptRecordedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("EffectReceiptRecorded"),
  payload: EffectReceiptRecordedPayloadSchema,
});

export const ExternalStateObservedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ExternalStateObserved"),
  payload: ExternalStateObservedPayloadSchema,
});

export const ProofGeneratedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ProofGenerated"),
  payload: ProofGeneratedPayloadSchema,
});

export const MismatchDetectedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("MismatchDetected"),
  payload: MismatchDetectedPayloadSchema,
});

export const ReleaseDecidedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("ReleaseDecided"),
  payload: ReleaseDecidedPayloadSchema,
});

export const FinalReleasedEventSchema = z.strictObject({
  ...runEventBaseShape,
  type: z.literal("FinalReleased"),
  payload: FinalReleasedPayloadSchema,
});

export const RunEventSchema = protocolSchema<RunEvent>(
  z.discriminatedUnion("type", [
    RunStartedEventSchema,
    ProposalReceivedEventSchema,
    EffectRequestedEventSchema,
    WritePreflightRequestedEventSchema,
    WritePreflightDecidedEventSchema,
    WriteQuarantinedEventSchema,
    MutationCommittedEventSchema,
    ApprovalRequestedEventSchema,
    ApprovalGrantedEventSchema,
    ApprovalDeniedEventSchema,
    ApprovalExpiredEventSchema,
    EffectReceiptRecordedEventSchema,
    ExternalStateObservedEventSchema,
    ProofGeneratedEventSchema,
    MismatchDetectedEventSchema,
    ReleaseDecidedEventSchema,
    FinalReleasedEventSchema,
  ]),
);

export const V0ProtocolSchemas = {
  blockedDecision: BlockedDecisionSchema,
  claim: ClaimSchema,
  claimPredicate: ClaimPredicateSchema,
  claimProof: ClaimProofSchema,
  currentStatePredicate: CurrentStatePredicateSchema,
  effectReceipt: EffectReceiptSchema,
  effectRequest: EffectRequestSchema,
  evidenceRef: EvidenceRefSchema,
  externalStateObservation: ExternalStateObservationSchema,
  externalStateObservationCandidate: ExternalStateObservationCandidateSchema,
  finalCandidate: FinalCandidateSchema,
  historicalActionPredicate: HistoricalActionPredicateSchema,
  mismatch: MismatchSchema,
  needsRepairDecision: NeedsRepairDecisionSchema,
  pendingEvidenceRef: PendingEvidenceRefSchema,
  proposal: ProposalSchema,
  proofObject: ProofObjectSchema,
  quarantinedDecision: QuarantinedDecisionSchema,
  receiptCandidate: ReceiptCandidateSchema,
  releaseDecision: ReleaseDecisionSchema,
  releasedDecision: ReleasedDecisionSchema,
  runEvent: RunEventSchema,
  testResultPredicate: TestResultPredicateSchema,
  toolCommandRequest: ToolCommandRequestSchema,
  writePreflightCandidate: WritePreflightCandidateSchema,
  writePreflightDecision: WritePreflightDecisionSchema,
  writeQuarantineState: WriteQuarantineStateSchema,
  mutationCommandRequest: MutationCommandRequestSchema,
  mutationCommitted: MutationCommittedSchema,
  approvalRequest: ApprovalRequestSchema,
  approvalGrant: ApprovalGrantSchema,
  approvalDenial: ApprovalDenialSchema,
  approvalExpiry: ApprovalExpirySchema,
} as const;
