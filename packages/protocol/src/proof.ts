import type { Claim } from "./claims.js";
import type { EvidenceRef } from "./evidence.js";
import type { Mismatch } from "./mismatch.js";
import type { ISODateTimeString } from "./shared.js";

export type ProofVerdict = "pass" | "fail" | "needs_repair" | "quarantine";

export interface ClaimProof {
  claimId: string;
  supported: boolean;
  evidenceRefs: EvidenceRef[];
  mismatchIds: string[];
}

export interface ProofObject {
  proofId: string;
  runId: string;
  candidateId: string;
  generatedAt: ISODateTimeString;
  verdict: ProofVerdict;
  claims: ClaimProof[];
  approvedClaimIds: string[];
  rejectedClaimIds: string[];
  blockingMismatches: Mismatch[];
  evaluatedClaims: Claim[];
}
