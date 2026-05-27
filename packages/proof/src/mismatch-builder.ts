import type { JsonValue, Mismatch, MismatchType } from "@amca/protocol";

export interface BlockingMismatchInput {
  readonly mismatchId: string;
  readonly runId: string;
  readonly type: MismatchType;
  readonly message: string;
  readonly claimId?: string;
  readonly expected?: JsonValue;
  readonly actual?: JsonValue;
}

export function buildBlockingMismatch(input: BlockingMismatchInput): Mismatch {
  return {
    mismatchId: input.mismatchId,
    runId: input.runId,
    type: input.type,
    blocking: true,
    message: input.message,
    ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.actual === undefined ? {} : { actual: input.actual }),
  };
}

export function buildMismatchId(
  claimId: string,
  type: MismatchType,
  sequence: number,
): string {
  return `mismatch_${sanitizeIdPart(claimId)}_${type}_${String(sequence)}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
