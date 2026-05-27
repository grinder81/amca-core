import type {
  EffectReceipt,
  EvidenceKind,
  EvidenceRef,
  ExternalStateObservation,
} from "@amca/protocol";

export interface ResolvedEffectReceipt {
  readonly receipt: EffectReceipt;
  readonly claimEvidenceRef: EvidenceRef;
  readonly receiptEvidenceRef: EvidenceRef;
}

export interface ResolvedExternalStateObservation {
  readonly observation: ExternalStateObservation;
  readonly claimEvidenceRef: EvidenceRef;
  readonly observationEvidenceRef: EvidenceRef;
}

export function filterEvidenceRefsByKind(
  evidenceRefs: readonly EvidenceRef[],
  kind: EvidenceKind,
): EvidenceRef[] {
  return evidenceRefs.filter((evidenceRef) => evidenceRef.kind === kind);
}

export function resolveEffectReceipts(
  evidenceRefs: readonly EvidenceRef[],
  effectReceipts: readonly EffectReceipt[],
): ResolvedEffectReceipt[] {
  const resolved: ResolvedEffectReceipt[] = [];

  for (const claimEvidenceRef of evidenceRefs) {
    for (const receipt of effectReceipts) {
      const receiptEvidenceRef = receipt.evidence.find((evidenceRef) =>
        evidenceRefsMatch(claimEvidenceRef, evidenceRef),
      );

      if (receiptEvidenceRef !== undefined) {
        resolved.push({
          receipt,
          claimEvidenceRef,
          receiptEvidenceRef,
        });
      }
    }
  }

  return resolved;
}

export function resolveExternalStateObservations(
  evidenceRefs: readonly EvidenceRef[],
  externalStateObservations: readonly ExternalStateObservation[],
): ResolvedExternalStateObservation[] {
  const resolved: ResolvedExternalStateObservation[] = [];

  for (const claimEvidenceRef of evidenceRefs) {
    for (const observation of externalStateObservations) {
      const observationEvidenceRef = observation.evidence.find((evidenceRef) =>
        evidenceRefsMatch(claimEvidenceRef, evidenceRef),
      );

      if (observationEvidenceRef !== undefined) {
        resolved.push({
          observation,
          claimEvidenceRef,
          observationEvidenceRef,
        });
      }
    }
  }

  return resolved;
}

export function evidenceRefsMatch(
  claimEvidenceRef: EvidenceRef,
  sourceEvidenceRef: EvidenceRef,
): boolean {
  return (
    claimEvidenceRef.evidenceId === sourceEvidenceRef.evidenceId &&
    claimEvidenceRef.kind === sourceEvidenceRef.kind &&
    claimEvidenceRef.sourceEventId === sourceEvidenceRef.sourceEventId &&
    claimEvidenceRef.hash === sourceEvidenceRef.hash
  );
}
