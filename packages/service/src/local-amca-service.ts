import { LocalRunHarness } from "@amca/harness";
import type {
  LocalRunHarnessDispatchResult,
  LocalRunHarnessRunResult,
} from "@amca/harness";
import { rebuildRunProjection } from "@amca/projections";
import { replayRunEvents } from "@amca/replay";
import {
  assertCapability,
  assertTenantAccess,
  exportReleaseAuditReport,
  redactRunEvents,
} from "@amca/security";

import {
  ServiceError,
  type DirectReceiptAdmissionBypassInput,
  type DirectReleaseBypassInput,
  type DispatchToolCommandServiceInput,
  type InspectRunServiceResult,
  type RunReadServiceInput,
  type RunToReleaseServiceInput,
  type ServiceOperation,
  type ServiceOperationResult,
  type StartRunServiceInput,
  type StartRunServiceResult,
  type SubmitFinalCandidateServiceInput,
  type SubmitFinalCandidateServiceResult,
} from "./types.js";

interface ManagedRun {
  readonly tenantId: string;
  readonly harness: LocalRunHarness;
}

export class LocalAmcaService {
  readonly #runs = new Map<string, ManagedRun>();

  startRun(input: StartRunServiceInput): StartRunServiceResult {
    assertCapability(input.context, "run:start");

    if (this.#runs.has(input.runId)) {
      throw new ServiceError(
        "run_already_exists",
        `Run ${input.runId} is already managed by this service.`,
      );
    }

    const harness = new LocalRunHarness({ runId: input.runId });
    const event = harness.startRun({
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      metadata: {
        ...(input.metadata ?? {}),
        tenantId: input.context.tenantId,
      },
    });
    this.#runs.set(input.runId, {
      tenantId: input.context.tenantId,
      harness,
    });

    return {
      runId: input.runId,
      event,
    };
  }

  async dispatchToolCommand(
    input: DispatchToolCommandServiceInput,
  ): Promise<LocalRunHarnessDispatchResult> {
    assertCapability(input.context, "run:execute");
    const managedRun = this.#managedRunFor(input);
    return managedRun.harness.dispatchToolCommand(input.toolCommand);
  }

  async runToRelease(
    input: RunToReleaseServiceInput,
  ): Promise<LocalRunHarnessRunResult> {
    assertCapability(input.context, "run:execute");
    assertCapability(input.context, "final:submit");
    const managedRun = this.#managedRunFor(input);
    return managedRun.harness.runToRelease({
      toolCommand: input.toolCommand,
      finalCandidate: input.finalCandidate,
    });
  }

  submitFinalCandidate(
    input: SubmitFinalCandidateServiceInput,
  ): SubmitFinalCandidateServiceResult {
    assertCapability(input.context, "final:submit");
    const managedRun = this.#managedRunFor(input);
    const result = managedRun.harness.submitFinalCandidate(
      input.finalCandidate,
    );

    return {
      runId: input.runId,
      result,
    };
  }

  inspectRun(input: RunReadServiceInput): InspectRunServiceResult {
    assertCapability(input.context, "run:inspect");
    const managedRun = this.#managedRunFor(input);
    const events = managedRun.harness.replay().events;

    return {
      runId: input.runId,
      projection: rebuildRunProjection(events),
      events,
      redactedEvents: redactRunEvents(events, input.context),
    };
  }

  replayRun(input: RunReadServiceInput): ReturnType<typeof replayRunEvents> {
    assertCapability(input.context, "run:replay");
    const managedRun = this.#managedRunFor(input);
    return replayRunEvents({
      runId: input.runId,
      events: managedRun.harness.replay().events,
    });
  }

  exportAudit(
    input: RunReadServiceInput,
  ): ReturnType<typeof exportReleaseAuditReport> {
    const managedRun = this.#managedRunFor(input);
    return exportReleaseAuditReport({
      context: input.context,
      runId: input.runId,
      events: managedRun.harness.replay().events,
    });
  }

  requestDirectRelease(input: DirectReleaseBypassInput): never {
    this.#assertRunExistsAndTenant(input);
    throw new ServiceError(
      "authority_bypass_blocked",
      "The service API cannot issue ReleaseDecision or FinalReleased authority directly; submit a FinalCandidate through the kernel/release gate path.",
    );
  }

  requestDirectReceiptAdmission(
    input: DirectReceiptAdmissionBypassInput,
  ): never {
    this.#assertRunExistsAndTenant(input);
    throw new ServiceError(
      "authority_bypass_blocked",
      "The service API cannot admit EffectReceipt authority directly; dispatch through the harness and broker admission path.",
    );
  }

  async handleOperation(
    operation: ServiceOperation,
  ): Promise<ServiceOperationResult> {
    switch (operation.type) {
      case "start_run":
        return this.startRun(operation.input);
      case "dispatch_tool_command":
        return this.dispatchToolCommand(operation.input);
      case "run_to_release":
        return this.runToRelease(operation.input);
      case "submit_final_candidate":
        return this.submitFinalCandidate(operation.input);
      case "inspect_run":
        return this.inspectRun(operation.input);
      case "replay_run":
        return this.replayRun(operation.input);
      case "export_audit":
        return this.exportAudit(operation.input);
      case "direct_release":
        return this.requestDirectRelease(operation.input);
      case "direct_receipt_admission":
        return this.requestDirectReceiptAdmission(operation.input);
    }
  }

  #managedRunFor(input: RunReadServiceInput): ManagedRun {
    const managedRun = this.#runs.get(input.runId);
    if (managedRun === undefined) {
      throw new ServiceError(
        "run_not_found",
        `Run ${input.runId} is not managed by this service.`,
      );
    }

    assertTenantAccess(input.context, managedRun.tenantId);
    return managedRun;
  }

  #assertRunExistsAndTenant(input: RunReadServiceInput): void {
    void this.#managedRunFor(input);
  }
}
