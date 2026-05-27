import type {
  EffectReceipt,
  FinalCandidate,
  JsonObject,
  RunEvent,
  ToolCommandRequest,
} from "@amca/protocol";
import type {
  LocalRunHarness,
  LocalRunHarnessDispatchResult,
  LocalRunHarnessRunResult,
} from "@amca/harness";
import type { RunProjection } from "@amca/projections";
import type { ReplayResult } from "@amca/replay";
import type { ReleaseAuditReport, SecurityContext } from "@amca/security";

export type ServiceErrorCode =
  | "authority_bypass_blocked"
  | "run_already_exists"
  | "run_not_found";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export interface StartRunServiceInput {
  readonly context: SecurityContext;
  readonly runId: string;
  readonly profile?: string;
  readonly metadata?: JsonObject;
}

export interface DispatchToolCommandServiceInput {
  readonly context: SecurityContext;
  readonly runId: string;
  readonly toolCommand: ToolCommandRequest;
}

export interface RunToReleaseServiceInput {
  readonly context: SecurityContext;
  readonly runId: string;
  readonly toolCommand: ToolCommandRequest;
  readonly finalCandidate: FinalCandidate;
}

export interface SubmitFinalCandidateServiceInput {
  readonly context: SecurityContext;
  readonly runId: string;
  readonly finalCandidate: FinalCandidate;
}

export interface RunReadServiceInput {
  readonly context: SecurityContext;
  readonly runId: string;
}

export interface DirectReleaseBypassInput {
  readonly context: SecurityContext;
  readonly runId: string;
  readonly decision: unknown;
}

export interface DirectReceiptAdmissionBypassInput {
  readonly context: SecurityContext;
  readonly runId: string;
  readonly receipt: EffectReceipt;
}

export interface InspectRunServiceResult {
  readonly runId: string;
  readonly projection: RunProjection;
  readonly events: readonly RunEvent[];
  readonly redactedEvents: readonly JsonObject[];
}

export interface StartRunServiceResult {
  readonly runId: string;
  readonly event: RunEvent<"RunStarted">;
}

export interface SubmitFinalCandidateServiceResult {
  readonly runId: string;
  readonly result: ReturnType<LocalRunHarness["submitFinalCandidate"]>;
}

export type ServiceOperation =
  | { readonly type: "start_run"; readonly input: StartRunServiceInput }
  | {
      readonly type: "dispatch_tool_command";
      readonly input: DispatchToolCommandServiceInput;
    }
  | {
      readonly type: "run_to_release";
      readonly input: RunToReleaseServiceInput;
    }
  | {
      readonly type: "submit_final_candidate";
      readonly input: SubmitFinalCandidateServiceInput;
    }
  | { readonly type: "inspect_run"; readonly input: RunReadServiceInput }
  | { readonly type: "replay_run"; readonly input: RunReadServiceInput }
  | { readonly type: "export_audit"; readonly input: RunReadServiceInput }
  | {
      readonly type: "direct_release";
      readonly input: DirectReleaseBypassInput;
    }
  | {
      readonly type: "direct_receipt_admission";
      readonly input: DirectReceiptAdmissionBypassInput;
    };

export type ServiceOperationResult =
  | StartRunServiceResult
  | LocalRunHarnessDispatchResult
  | LocalRunHarnessRunResult
  | SubmitFinalCandidateServiceResult
  | InspectRunServiceResult
  | ReplayResult
  | ReleaseAuditReport;
