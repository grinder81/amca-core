import { parseRunEvent } from "@amca/contracts";
import { rebuildRunProjection } from "@amca/projections";
import type { RunEvent } from "@amca/protocol";
import { replayRunEvents, type ReplayResult } from "@amca/replay";

export type EvalRegressionCode =
  | "replay_failed"
  | "release_status_changed"
  | "mismatch_types_changed"
  | "approved_claim_ids_changed";

export interface EvalExpectation {
  readonly releaseStatus?: string | undefined;
  readonly mismatchTypes?: readonly string[] | undefined;
  readonly approvedClaimIds?: readonly string[] | undefined;
}

export interface EvalRegression {
  readonly code: EvalRegressionCode;
  readonly message: string;
  readonly expected?: readonly string[] | string | undefined;
  readonly actual?: readonly string[] | string | undefined;
}

export interface EvaluateAcceptedRunInput {
  readonly runId?: string | undefined;
  readonly events: readonly RunEvent[];
  readonly expected: EvalExpectation;
}

export interface EvalRunResult {
  readonly status: "pass" | "fail";
  readonly runId?: string | undefined;
  readonly replay: ReplayResult;
  readonly regressions: readonly EvalRegression[];
}

export function evaluateAcceptedRun(
  input: EvaluateAcceptedRunInput,
): EvalRunResult {
  const events = input.events.map((event) => parseRunEvent(event));
  const runId = input.runId ?? events[0]?.runId;
  const replay = replayRunEvents({
    events,
    ...(runId === undefined ? {} : { runId }),
  });

  if (replay.status === "failed") {
    return {
      status: "fail",
      runId,
      replay,
      regressions: [
        {
          code: "replay_failed",
          message: replay.message,
          actual: replay.code,
        },
      ],
    };
  }

  const projection = rebuildRunProjection(replay.replayedEvents);
  const actualMismatchTypes = projection.mismatches.map(
    (mismatch) => mismatch.type,
  );
  const actualApprovedClaimIds =
    projection.releaseDecision?.approvedClaimIds ?? [];
  const actualReleaseStatus = projection.releaseDecision?.status ?? "running";
  const regressions: EvalRegression[] = [];

  if (
    input.expected.releaseStatus !== undefined &&
    input.expected.releaseStatus !== actualReleaseStatus
  ) {
    regressions.push({
      code: "release_status_changed",
      message: "Release status changed during eval.",
      expected: input.expected.releaseStatus,
      actual: actualReleaseStatus,
    });
  }

  if (
    input.expected.mismatchTypes !== undefined &&
    !sameValues(input.expected.mismatchTypes, actualMismatchTypes)
  ) {
    regressions.push({
      code: "mismatch_types_changed",
      message: "Blocking mismatch types changed during eval.",
      expected: input.expected.mismatchTypes,
      actual: actualMismatchTypes,
    });
  }

  if (
    input.expected.approvedClaimIds !== undefined &&
    !sameValues(input.expected.approvedClaimIds, actualApprovedClaimIds)
  ) {
    regressions.push({
      code: "approved_claim_ids_changed",
      message: "Approved claim IDs changed during eval.",
      expected: input.expected.approvedClaimIds,
      actual: actualApprovedClaimIds,
    });
  }

  return {
    status: regressions.length === 0 ? "pass" : "fail",
    runId,
    replay,
    regressions,
  };
}

export function renderEvalMarkdown(result: EvalRunResult): string {
  return [
    `# AMCA Eval Report`,
    ``,
    `- runId: ${result.runId ?? "unknown"}`,
    `- status: ${result.status}`,
    `- replay: ${result.replay.status}`,
    `- regressions: ${String(result.regressions.length)}`,
    ...result.regressions.map(
      (regression) => `- ${regression.code}: ${regression.message}`,
    ),
    ``,
  ].join("\n");
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}
