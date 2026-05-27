import type {
  ApprovalDenial,
  ApprovalExpiry,
  ApprovalGrant,
  ApprovalRequest,
  Claim,
  ClaimPredicate,
  EffectReceipt,
  EffectRequest,
  EvidenceRef,
  ExternalStateObservation,
  ExternalStateObservationCandidate,
  FinalCandidate,
  Mismatch,
  MutationCommandRequest,
  MutationCommitted,
  PendingEvidenceRef,
  Proposal,
  ProofObject,
  ReceiptCandidate,
  ReleaseDecision,
  RunEvent,
  ToolCommandRequest,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
} from "@amca/protocol";
import type { ZodType } from "zod";

import {
  ClaimPredicateSchema,
  ClaimSchema,
  ApprovalDenialSchema,
  ApprovalExpirySchema,
  ApprovalGrantSchema,
  ApprovalRequestSchema,
  EffectReceiptSchema,
  EffectRequestSchema,
  EvidenceRefSchema,
  ExternalStateObservationSchema,
  ExternalStateObservationCandidateSchema,
  FinalCandidateSchema,
  MismatchSchema,
  MutationCommandRequestSchema,
  MutationCommittedSchema,
  PendingEvidenceRefSchema,
  ProposalSchema,
  ProofObjectSchema,
  ReceiptCandidateSchema,
  ReleaseDecisionSchema,
  RunEventSchema,
  ToolCommandRequestSchema,
  WritePreflightCandidateSchema,
  WritePreflightDecisionSchema,
  WriteQuarantineStateSchema,
} from "./schemas.js";

export interface ContractValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export type ContractValidationResult<T> =
  | {
      readonly success: true;
      readonly data: T;
    }
  | {
      readonly success: false;
      readonly issues: readonly ContractValidationIssue[];
    };

export class ContractValidationError extends Error {
  readonly issues: readonly ContractValidationIssue[];

  constructor(
    readonly contractName: string,
    issues: readonly ContractValidationIssue[],
  ) {
    super(`${contractName} validation failed`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function validateContract<T>(
  schema: ZodType<T>,
  input: unknown,
): ContractValidationResult<T> {
  const result = schema.safeParse(input);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
    })),
  };
}

export function parseContract<T>(
  schema: ZodType<T>,
  input: unknown,
  contractName = "AMCA contract",
): T {
  const result = validateContract(schema, input);

  if (result.success) {
    return result.data;
  }

  throw new ContractValidationError(contractName, result.issues);
}

function makeValidator<T>(
  schema: ZodType<T>,
): (input: unknown) => ContractValidationResult<T> {
  return (input) => validateContract(schema, input);
}

function makeParser<T>(
  schema: ZodType<T>,
  contractName: string,
): (input: unknown) => T {
  return (input) => parseContract(schema, input, contractName);
}

export const validateEvidenceRef =
  makeValidator<EvidenceRef>(EvidenceRefSchema);
export const parseEvidenceRef = makeParser<EvidenceRef>(
  EvidenceRefSchema,
  "EvidenceRef",
);

export const validatePendingEvidenceRef = makeValidator<PendingEvidenceRef>(
  PendingEvidenceRefSchema,
);
export const parsePendingEvidenceRef = makeParser<PendingEvidenceRef>(
  PendingEvidenceRefSchema,
  "PendingEvidenceRef",
);

export const validateExternalStateObservation =
  makeValidator<ExternalStateObservation>(ExternalStateObservationSchema);
export const parseExternalStateObservation =
  makeParser<ExternalStateObservation>(
    ExternalStateObservationSchema,
    "ExternalStateObservation",
  );

export const validateExternalStateObservationCandidate =
  makeValidator<ExternalStateObservationCandidate>(
    ExternalStateObservationCandidateSchema,
  );
export const parseExternalStateObservationCandidate =
  makeParser<ExternalStateObservationCandidate>(
    ExternalStateObservationCandidateSchema,
    "ExternalStateObservationCandidate",
  );

export const validateEffectRequest =
  makeValidator<EffectRequest>(EffectRequestSchema);
export const parseEffectRequest = makeParser<EffectRequest>(
  EffectRequestSchema,
  "EffectRequest",
);

export const validateEffectReceipt =
  makeValidator<EffectReceipt>(EffectReceiptSchema);
export const parseEffectReceipt = makeParser<EffectReceipt>(
  EffectReceiptSchema,
  "EffectReceipt",
);

export const validateReceiptCandidate = makeValidator<ReceiptCandidate>(
  ReceiptCandidateSchema,
);
export const parseReceiptCandidate = makeParser<ReceiptCandidate>(
  ReceiptCandidateSchema,
  "ReceiptCandidate",
);

export const validateClaimPredicate =
  makeValidator<ClaimPredicate>(ClaimPredicateSchema);
export const parseClaimPredicate = makeParser<ClaimPredicate>(
  ClaimPredicateSchema,
  "ClaimPredicate",
);

export const validateClaim = makeValidator<Claim>(ClaimSchema);
export const parseClaim = makeParser<Claim>(ClaimSchema, "Claim");

export const validateToolCommandRequest = makeValidator<ToolCommandRequest>(
  ToolCommandRequestSchema,
);
export const parseToolCommandRequest = makeParser<ToolCommandRequest>(
  ToolCommandRequestSchema,
  "ToolCommandRequest",
);

export const validateFinalCandidate =
  makeValidator<FinalCandidate>(FinalCandidateSchema);
export const parseFinalCandidate = makeParser<FinalCandidate>(
  FinalCandidateSchema,
  "FinalCandidate",
);

export const validateProposal = makeValidator<Proposal>(ProposalSchema);
export const parseProposal = makeParser<Proposal>(ProposalSchema, "Proposal");

export const validateMismatch = makeValidator<Mismatch>(MismatchSchema);
export const parseMismatch = makeParser<Mismatch>(MismatchSchema, "Mismatch");

export const validateProofObject =
  makeValidator<ProofObject>(ProofObjectSchema);
export const parseProofObject = makeParser<ProofObject>(
  ProofObjectSchema,
  "ProofObject",
);

export const validateReleaseDecision = makeValidator<ReleaseDecision>(
  ReleaseDecisionSchema,
);
export const parseReleaseDecision = makeParser<ReleaseDecision>(
  ReleaseDecisionSchema,
  "ReleaseDecision",
);

export const validateRunEvent = makeValidator<RunEvent>(RunEventSchema);
export const parseRunEvent = makeParser<RunEvent>(RunEventSchema, "RunEvent");

export const validateWritePreflightCandidate =
  makeValidator<WritePreflightCandidate>(WritePreflightCandidateSchema);
export const parseWritePreflightCandidate = makeParser<WritePreflightCandidate>(
  WritePreflightCandidateSchema,
  "WritePreflightCandidate",
);

export const validateWritePreflightDecision =
  makeValidator<WritePreflightDecision>(WritePreflightDecisionSchema);
export const parseWritePreflightDecision = makeParser<WritePreflightDecision>(
  WritePreflightDecisionSchema,
  "WritePreflightDecision",
);

export const validateWriteQuarantineState = makeValidator<WriteQuarantineState>(
  WriteQuarantineStateSchema,
);
export const parseWriteQuarantineState = makeParser<WriteQuarantineState>(
  WriteQuarantineStateSchema,
  "WriteQuarantineState",
);

export const validateMutationCommandRequest =
  makeValidator<MutationCommandRequest>(MutationCommandRequestSchema);
export const parseMutationCommandRequest = makeParser<MutationCommandRequest>(
  MutationCommandRequestSchema,
  "MutationCommandRequest",
);

export const validateMutationCommitted = makeValidator<MutationCommitted>(
  MutationCommittedSchema,
);
export const parseMutationCommitted = makeParser<MutationCommitted>(
  MutationCommittedSchema,
  "MutationCommitted",
);

export const validateApprovalRequest = makeValidator<ApprovalRequest>(
  ApprovalRequestSchema,
);
export const parseApprovalRequest = makeParser<ApprovalRequest>(
  ApprovalRequestSchema,
  "ApprovalRequest",
);

export const validateApprovalGrant =
  makeValidator<ApprovalGrant>(ApprovalGrantSchema);
export const parseApprovalGrant = makeParser<ApprovalGrant>(
  ApprovalGrantSchema,
  "ApprovalGrant",
);

export const validateApprovalDenial =
  makeValidator<ApprovalDenial>(ApprovalDenialSchema);
export const parseApprovalDenial = makeParser<ApprovalDenial>(
  ApprovalDenialSchema,
  "ApprovalDenial",
);

export const validateApprovalExpiry =
  makeValidator<ApprovalExpiry>(ApprovalExpirySchema);
export const parseApprovalExpiry = makeParser<ApprovalExpiry>(
  ApprovalExpirySchema,
  "ApprovalExpiry",
);
