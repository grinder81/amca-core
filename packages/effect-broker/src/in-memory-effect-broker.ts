import type { CapabilityContract } from "@amca/capabilities";
import {
  canonicalObjectHash,
  parseEffectRequest,
  parseToolCommandRequest,
  parseWritePreflightCandidate,
  parseWritePreflightDecision,
} from "@amca/contracts";
import type {
  AdapterCertification,
  AdapterKind,
  EffectAdapter,
  ExternalStateObservationCandidate,
  ReceiptCandidate,
} from "@amca/effect-sdk";
import type {
  EffectRequest,
  JsonObject,
  JsonValue,
  SideEffectClass,
  ToolCommandRequest,
  WritePreflightCandidate,
  WritePreflightDecision,
  WriteQuarantineState,
  WriteSideEffectClass,
} from "@amca/protocol";

import {
  EffectBrokerError,
  type DispatchEffectOptions,
  type EffectDispatchResult,
  type DispatchWithPreflightOptions,
  type InMemoryEffectBrokerOptions,
  type WritePreflightOptions,
} from "./types.js";

const governedWriteClasses = new Set<SideEffectClass>([
  "idempotent_write",
  "reversible_write",
  "irreversible_write",
]);
const writeCapableClasses = new Set<SideEffectClass>([
  ...governedWriteClasses,
  "critical_write",
]);

const defaultAllowedAdapterKinds = new Set<AdapterKind>([
  "deterministic_fake",
  "deterministic_in_memory",
]);
const certificationKeys = new Set([
  "adapterId",
  "adapterKind",
  "capabilityId",
  "certificationVersion",
  "declaredObservationTypes",
  "declaredReceiptTypes",
  "idempotency",
  "riskProfile",
  "sideEffectClass",
  "toolId",
  "writeLifecycle",
]);
const writeLifecycleKeys = new Set([
  "dispatch",
  "forbiddenAuthority",
  "idempotencyKey",
  "outcome",
  "preflight",
]);
const idempotencyPostures = new Set([
  "adapter_enforced",
  "not_required",
  "required_for_writes",
]);
const riskProfiles = new Set(["critical", "light", "regulated", "standard"]);
const writeLifecycleForbiddenAuthorities = new Set([
  "proof_authority",
  "receipt_admission",
  "release_authority",
]);
const releaseDecisionAuthorityKey = ["decide", "Release"].join("");
const releasePublishAuthorityKey = ["publish", "Release"].join("");
const forbiddenAdapterAuthorityKeys = new Set([
  "admitReceipt",
  releaseDecisionAuthorityKey,
  "generateProof",
  "proofEngine",
  releasePublishAuthorityKey,
  "recordEffectReceipt",
  "release",
  "verifyProof",
]);
const rawContentKeys = new Set([
  "body",
  "bytes",
  "content",
  "fileContents",
  "rawBody",
  "rawContent",
  "responseBody",
  "text",
]);
const sideEffectClasses = new Set<SideEffectClass>([
  "read",
  "compute",
  "idempotent_write",
  "reversible_write",
  "irreversible_write",
  "critical_write",
]);
const effectStatuses = new Set(["failed", "succeeded", "unknown"]);
const evidenceKinds = new Set([
  "artifact",
  "effect_receipt",
  "external_observation",
  "ledger_event",
  "test_output",
]);
const evidenceSensitivities = new Set([
  "confidential",
  "internal",
  "public",
  "restricted",
]);
const pendingEvidenceRefKeys = new Set([
  "admissionStatus",
  "artifactUri",
  "evidenceId",
  "expiresAt",
  "hash",
  "kind",
  "metadata",
  "observedAt",
  "pendingAdmissionToken",
  "sensitivity",
]);
const receiptCandidateKeys = new Set([
  "capabilityId",
  "effectId",
  "evidence",
  "externalRef",
  "observedAt",
  "payload",
  "payloadHash",
  "receiptId",
  "receiptType",
  "runId",
  "status",
]);
const externalStateObservationCandidateKeys = new Set([
  "evidence",
  "expiresAt",
  "observedAt",
  "observedState",
  "observationId",
  "observationType",
  "payloadHash",
  "runId",
  "subjectId",
  "subjectType",
]);
const effectAdapterResultKeys = new Set([
  "externalStateObservationCandidate",
  "receiptCandidate",
]);

interface CachedEffect {
  readonly fingerprint: string;
  readonly quarantine?: WriteQuarantineState;
  readonly result?: EffectDispatchResult;
}

interface PersistedWritePreflightDecision {
  readonly decision: WritePreflightDecision;
  readonly decisionHash: string;
  readonly fingerprint: string;
}

interface DispatchGovernance {
  readonly preflightDecision?: WritePreflightDecision;
}

export class InMemoryEffectBroker {
  readonly #capabilities = new Map<string, CapabilityContract>();
  readonly #adapters = new Map<string, EffectAdapter>();
  readonly #idempotencyCache = new Map<string, CachedEffect>();
  readonly #writePreflightDecisions = new Map<
    string,
    PersistedWritePreflightDecision
  >();
  readonly #clock: NonNullable<InMemoryEffectBrokerOptions["clock"]>;
  readonly #allowedAdapterKinds: ReadonlySet<AdapterKind>;

  constructor(options: InMemoryEffectBrokerOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#allowedAdapterKinds = new Set(
      options.allowedAdapterKinds ?? defaultAllowedAdapterKinds,
    );

    for (const capability of options.capabilities ?? []) {
      this.registerCapability(capability);
    }

    for (const adapter of options.adapters ?? []) {
      this.registerAdapter(adapter);
    }
  }

  registerCapability(capability: CapabilityContract): void {
    this.#capabilities.set(capability.capabilityId, capability);
  }

  registerAdapter(adapter: EffectAdapter): void {
    assertAdapterCertificationIsValid(adapter, this.#allowedAdapterKinds);
    this.#adapters.set(
      adapterKey(adapter.capabilityId, adapter.toolId),
      adapter,
    );
  }

  preflightWrite(
    command: ToolCommandRequest,
    options: WritePreflightOptions = {},
  ): WritePreflightDecision {
    const parsedCommand = parseToolCommandRequest(command);
    const candidate = createWritePreflightCandidate(parsedCommand, {
      requestedAt: options.requestedAt ?? this.#clock(),
      ...(options.preflightId === undefined
        ? {}
        : { preflightId: options.preflightId }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
    const decidedAt = options.decidedAt ?? this.#clock();

    if (candidate.sideEffectClass === "critical_write") {
      return this.#persistWritePreflightDecision(
        parsedCommand,
        quarantinedWritePreflightDecision(candidate, {
          decidedAt,
          reason: "critical_approval_required",
          message:
            "critical_write effects require a later human approval phase before dispatch.",
          ...(options.quarantineId === undefined
            ? {}
            : { quarantineId: options.quarantineId }),
        }),
      );
    }

    if (candidate.idempotencyKey === undefined) {
      return this.#persistWritePreflightDecision(
        parsedCommand,
        deniedWritePreflightDecision(candidate, {
          decidedAt,
          reason: "missing_idempotency_key",
          message: `${candidate.sideEffectClass} effects require an idempotencyKey before dispatch.`,
        }),
      );
    }

    try {
      const capability = this.#capabilityFor(parsedCommand);
      const adapter = this.#adapterFor(parsedCommand);

      assertAdapterCertificationIsValid(adapter, this.#allowedAdapterKinds);
      assertCapabilityMatchesCommand(capability, parsedCommand);
      assertAdapterMatchesCommand(adapter, parsedCommand);
      assertAdapterCertificationMatchesCapability(adapter, capability);
    } catch (error) {
      if (error instanceof EffectBrokerError) {
        return this.#persistWritePreflightDecision(
          parsedCommand,
          deniedWritePreflightDecision(candidate, {
            decidedAt,
            reason: preflightBlockReasonForBrokerError(error),
            message: error.message,
          }),
        );
      }

      throw error;
    }

    return this.#persistWritePreflightDecision(
      parsedCommand,
      allowedWritePreflightDecision(candidate, decidedAt),
    );
  }

  async dispatchWithPreflight(
    command: ToolCommandRequest,
    options: DispatchWithPreflightOptions,
  ): Promise<EffectDispatchResult> {
    const parsedCommand = parseToolCommandRequest(command);
    const decision = parseWritePreflightDecision(options.preflightDecision);

    assertWritePreflightAllowsDispatch(
      parsedCommand,
      decision,
      this.#writePreflightDecisions.get(decision.preflightId),
    );

    return this.#dispatch(parsedCommand, options, {
      preflightDecision: decision,
    });
  }

  async dispatch(
    command: ToolCommandRequest,
    options: DispatchEffectOptions = {},
  ): Promise<EffectDispatchResult> {
    const parsedCommand = parseToolCommandRequest(command);
    const capability = this.#capabilityFor(parsedCommand);
    const adapter = this.#adapterFor(parsedCommand);

    assertAdapterCertificationIsValid(adapter, this.#allowedAdapterKinds);
    assertCapabilityMatchesCommand(capability, parsedCommand);
    assertAdapterMatchesCommand(adapter, parsedCommand);
    assertAdapterCertificationMatchesCapability(adapter, capability);
    assertDirectDispatchAllowed(parsedCommand);

    return this.#dispatch(parsedCommand, options, {});
  }

  async #dispatch(
    parsedCommand: ToolCommandRequest,
    options: DispatchEffectOptions,
    governance: DispatchGovernance,
  ): Promise<EffectDispatchResult> {
    const capability = this.#capabilityFor(parsedCommand);
    const adapter = this.#adapterFor(parsedCommand);

    assertAdapterCertificationIsValid(adapter, this.#allowedAdapterKinds);
    assertCapabilityMatchesCommand(capability, parsedCommand);
    assertAdapterMatchesCommand(adapter, parsedCommand);
    assertAdapterCertificationMatchesCapability(adapter, capability);
    assertSideEffectIsDispatchable(parsedCommand);

    const fingerprint = idempotencyFingerprint(parsedCommand);
    const idempotencyKey = parsedCommand.idempotencyKey;
    if (idempotencyKey !== undefined) {
      const cached = this.#idempotencyCache.get(idempotencyKey);
      if (cached !== undefined) {
        if (cached.fingerprint !== fingerprint) {
          throw new EffectBrokerError(
            "duplicate_idempotency_key_conflict",
            `Idempotency key ${idempotencyKey} was reused for a different effect request.`,
          );
        }

        if (cached.quarantine !== undefined) {
          throw new EffectBrokerError(
            "adapter_write_quarantined",
            `Write idempotency key ${idempotencyKey} is already quarantined.`,
            { quarantine: cached.quarantine },
          );
        }

        if (cached.result === undefined) {
          throw new EffectBrokerError(
            "adapter_write_quarantined",
            `Write idempotency key ${idempotencyKey} has no admissible cached receipt candidate.`,
          );
        }

        return {
          ...cached.result,
          status: "cached",
        };
      }
    }

    const effectRequest = parseEffectRequest({
      effectId: options.effectId ?? defaultEffectId(parsedCommand),
      commandId: parsedCommand.commandId,
      runId: parsedCommand.runId,
      capabilityId: parsedCommand.capabilityId,
      toolId: parsedCommand.toolId,
      args: parsedCommand.args,
      sideEffectClass: parsedCommand.sideEffectClass,
      requestedAt: options.requestedAt ?? this.#clock(),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });

    let receiptCandidate: ReceiptCandidate;
    let externalStateObservationCandidate:
      | ExternalStateObservationCandidate
      | undefined;
    try {
      const adapterResult = await adapter.execute(
        {
          toolCommand: parsedCommand,
          effectRequest,
          capability,
        },
        {
          now: this.#clock,
        },
      );
      assertRecord(
        adapterResult,
        "adapter_receipt_invalid",
        `Adapter ${adapter.adapterId} result must be an object.`,
      );
      assertOnlyKeys(
        adapterResult,
        effectAdapterResultKeys,
        "adapter_receipt_invalid",
        `Adapter ${adapter.adapterId} result`,
      );

      if (adapterResult.receiptCandidate === undefined) {
        throw new EffectBrokerError(
          "adapter_receipt_missing",
          `Adapter ${adapter.adapterId} did not return a ReceiptCandidate.`,
        );
      }

      receiptCandidate = validateReceiptCandidate(
        adapterResult.receiptCandidate,
        effectRequest,
        capability,
        adapter.certification,
      );
      externalStateObservationCandidate =
        adapterResult.externalStateObservationCandidate === undefined
          ? undefined
          : validateExternalStateObservationCandidate(
              adapterResult.externalStateObservationCandidate,
              effectRequest,
              receiptCandidate,
              capability,
              adapter.certification,
            );
    } catch (error) {
      if (
        governance.preflightDecision !== undefined &&
        writeCapableClasses.has(parsedCommand.sideEffectClass)
      ) {
        const quarantine = writeDispatchQuarantineState({
          adapterId: adapter.adapterId,
          command: parsedCommand,
          effectId: effectRequest.effectId,
          message: writeQuarantineMessage(adapter.adapterId, error),
          preflightDecision: governance.preflightDecision,
          quarantinedAt: this.#clock(),
        });

        if (idempotencyKey !== undefined) {
          this.#idempotencyCache.set(idempotencyKey, {
            fingerprint,
            quarantine,
          });
        }

        throw new EffectBrokerError(
          "adapter_write_quarantined",
          quarantine.message,
          { quarantine },
        );
      }

      throw error;
    }
    const result: EffectDispatchResult = {
      status: "dispatched",
      effectRequest,
      receiptCandidate,
      ...(externalStateObservationCandidate === undefined
        ? {}
        : { externalStateObservationCandidate }),
    };

    if (idempotencyKey !== undefined) {
      this.#idempotencyCache.set(idempotencyKey, {
        fingerprint,
        result,
      });
    }

    return result;
  }

  #persistWritePreflightDecision(
    command: ToolCommandRequest,
    decision: WritePreflightDecision,
  ): WritePreflightDecision {
    this.#writePreflightDecisions.set(decision.preflightId, {
      decision,
      decisionHash: canonicalObjectHash(decision as unknown as JsonObject),
      fingerprint: writePreflightFingerprint(command),
    });
    return decision;
  }

  #capabilityFor(command: ToolCommandRequest): CapabilityContract {
    const capability = this.#capabilities.get(command.capabilityId);
    if (capability === undefined) {
      throw new EffectBrokerError(
        "capability_not_registered",
        `Capability ${command.capabilityId} is not registered.`,
      );
    }

    return capability;
  }

  #adapterFor(command: ToolCommandRequest): EffectAdapter {
    const adapter = this.#adapters.get(
      adapterKey(command.capabilityId, command.toolId),
    );
    if (adapter === undefined) {
      throw new EffectBrokerError(
        "tool_not_registered",
        `Tool ${command.toolId} is not registered for capability ${command.capabilityId}.`,
      );
    }

    return adapter;
  }
}

export function createWritePreflightCandidate(
  command: ToolCommandRequest,
  options: Pick<
    WritePreflightOptions,
    "metadata" | "preflightId" | "requestedAt"
  > = {},
): WritePreflightCandidate {
  const parsedCommand = parseToolCommandRequest(command);
  const sideEffectClass = assertWriteSideEffectClass(parsedCommand);

  return parseWritePreflightCandidate({
    kind: "write_preflight_candidate",
    preflightId: options.preflightId ?? defaultPreflightId(parsedCommand),
    runId: parsedCommand.runId,
    commandId: parsedCommand.commandId,
    capabilityId: parsedCommand.capabilityId,
    toolId: parsedCommand.toolId,
    sideEffectClass,
    argsHash: canonicalObjectHash(parsedCommand.args),
    requestedAt: options.requestedAt ?? systemClock(),
    ...(parsedCommand.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: parsedCommand.idempotencyKey }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  });
}

function allowedWritePreflightDecision(
  candidate: WritePreflightCandidate,
  decidedAt: string,
): WritePreflightDecision {
  if (candidate.idempotencyKey === undefined) {
    return deniedWritePreflightDecision(candidate, {
      decidedAt,
      reason: "missing_idempotency_key",
      message: `${candidate.sideEffectClass} effects require an idempotencyKey before dispatch.`,
    });
  }

  return parseWritePreflightDecision({
    kind: "write_preflight_decision",
    status: "allowed",
    runId: candidate.runId,
    preflightId: candidate.preflightId,
    commandId: candidate.commandId,
    capabilityId: candidate.capabilityId,
    toolId: candidate.toolId,
    sideEffectClass: candidate.sideEffectClass,
    idempotencyKey: candidate.idempotencyKey,
    decidedAt,
  });
}

function deniedWritePreflightDecision(
  candidate: WritePreflightCandidate,
  input: {
    readonly decidedAt: string;
    readonly message: string;
    readonly reason: WritePreflightDecisionReason;
  },
): WritePreflightDecision {
  return parseWritePreflightDecision({
    kind: "write_preflight_decision",
    status: "denied",
    runId: candidate.runId,
    preflightId: candidate.preflightId,
    commandId: candidate.commandId,
    capabilityId: candidate.capabilityId,
    toolId: candidate.toolId,
    sideEffectClass: candidate.sideEffectClass,
    reason: input.reason,
    message: input.message,
    decidedAt: input.decidedAt,
    ...(candidate.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: candidate.idempotencyKey }),
  });
}

function quarantinedWritePreflightDecision(
  candidate: WritePreflightCandidate,
  input: {
    readonly decidedAt: string;
    readonly message: string;
    readonly quarantineId?: string;
    readonly reason: WriteQuarantineState["reason"];
  },
): WritePreflightDecision {
  const quarantine: WriteQuarantineState = {
    kind: "write_quarantine_state",
    quarantineId:
      input.quarantineId ?? `quarantine_${sanitizeId(candidate.preflightId)}`,
    runId: candidate.runId,
    preflightId: candidate.preflightId,
    commandId: candidate.commandId,
    capabilityId: candidate.capabilityId,
    toolId: candidate.toolId,
    sideEffectClass: candidate.sideEffectClass,
    status: "quarantined",
    reason: input.reason,
    message: input.message,
    quarantinedAt: input.decidedAt,
    ...(candidate.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: candidate.idempotencyKey }),
  };

  return parseWritePreflightDecision({
    kind: "write_preflight_decision",
    status: "quarantined",
    runId: candidate.runId,
    preflightId: candidate.preflightId,
    commandId: candidate.commandId,
    capabilityId: candidate.capabilityId,
    toolId: candidate.toolId,
    sideEffectClass: candidate.sideEffectClass,
    quarantine,
    decidedAt: input.decidedAt,
    ...(candidate.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: candidate.idempotencyKey }),
  });
}

type WritePreflightDecisionReason = Extract<
  WritePreflightDecision,
  { status: "denied" }
>["reason"];

function assertWriteSideEffectClass(
  command: ToolCommandRequest,
): WriteSideEffectClass {
  if (!writeCapableClasses.has(command.sideEffectClass)) {
    throw new EffectBrokerError(
      "write_preflight_not_applicable",
      `Write preflight cannot be created for ${command.sideEffectClass} effects.`,
    );
  }

  return command.sideEffectClass as WriteSideEffectClass;
}

function assertDirectDispatchAllowed(command: ToolCommandRequest): void {
  if (writeCapableClasses.has(command.sideEffectClass)) {
    if (command.idempotencyKey === undefined) {
      throw new EffectBrokerError(
        "idempotency_key_required",
        `${command.sideEffectClass} effects require an idempotencyKey.`,
      );
    }

    throw new EffectBrokerError(
      "write_preflight_required",
      `${command.sideEffectClass} effects require a persisted broker preflight decision before dispatch.`,
    );
  }
}

function assertWritePreflightAllowsDispatch(
  command: ToolCommandRequest,
  decision: WritePreflightDecision,
  persistedDecision: PersistedWritePreflightDecision | undefined,
): void {
  const sideEffectClass = assertWriteSideEffectClass(command);

  if (decision.status === "denied") {
    throw new EffectBrokerError(
      "write_preflight_denied",
      `Write preflight ${decision.preflightId} denied dispatch: ${decision.message}`,
    );
  }

  if (decision.status === "quarantined") {
    throw new EffectBrokerError(
      "write_preflight_quarantined",
      `Write preflight ${decision.preflightId} quarantined dispatch: ${decision.quarantine.message}`,
    );
  }

  if (persistedDecision === undefined) {
    throw new EffectBrokerError(
      "write_preflight_mismatch",
      `Write preflight ${decision.preflightId} was not issued by this broker.`,
    );
  }

  if (
    canonicalObjectHash(decision as unknown as JsonObject) !==
      persistedDecision.decisionHash ||
    canonicalObjectHash(persistedDecision.decision as unknown as JsonObject) !==
      persistedDecision.decisionHash
  ) {
    throw new EffectBrokerError(
      "write_preflight_mismatch",
      `Write preflight ${decision.preflightId} does not match the broker-persisted decision.`,
    );
  }

  if (
    decision.runId !== command.runId ||
    decision.commandId !== command.commandId ||
    decision.capabilityId !== command.capabilityId ||
    decision.toolId !== command.toolId ||
    decision.sideEffectClass !== sideEffectClass ||
    decision.idempotencyKey !== command.idempotencyKey
  ) {
    throw new EffectBrokerError(
      "write_preflight_mismatch",
      `Write preflight ${decision.preflightId} does not match command ${command.commandId}.`,
    );
  }

  if (persistedDecision.fingerprint !== writePreflightFingerprint(command)) {
    throw new EffectBrokerError(
      "write_preflight_mismatch",
      `Write preflight ${decision.preflightId} does not match command ${command.commandId} arguments.`,
    );
  }
}

function preflightBlockReasonForBrokerError(
  error: EffectBrokerError,
): WritePreflightDecisionReason {
  switch (error.code) {
    case "capability_not_registered":
      return "capability_not_registered";
    case "tool_not_registered":
      return "tool_not_registered";
    case "critical_write_requires_approval":
      return "critical_approval_required";
    case "adapter_certification_invalid":
    case "adapter_certification_kind_forbidden":
    case "adapter_certification_missing":
    case "adapter_certification_mismatch":
    case "adapter_certification_undeclared_observation":
    case "adapter_certification_undeclared_receipt":
    case "adapter_write_lifecycle_invalid":
    case "adapter_write_lifecycle_missing":
      return "adapter_not_certified";
    default:
      return "policy_denied";
  }
}

function assertAdapterCertificationIsValid(
  adapter: EffectAdapter,
  allowedAdapterKinds: ReadonlySet<AdapterKind>,
): void {
  assertAdapterDoesNotClaimForbiddenAuthority(adapter);

  const certification = certificationForAdapter(adapter);

  if (!allowedAdapterKinds.has(certification.adapterKind)) {
    throw new EffectBrokerError(
      "adapter_certification_kind_forbidden",
      `Adapter kind ${certification.adapterKind} is not enabled for this broker profile.`,
    );
  }

  if (
    certification.adapterId !== adapter.adapterId ||
    certification.capabilityId !== adapter.capabilityId ||
    certification.toolId !== adapter.toolId
  ) {
    throw new EffectBrokerError(
      "adapter_certification_mismatch",
      `Adapter ${adapter.adapterId} certification does not match the adapter identity.`,
    );
  }

  if (certification.sideEffectClass === "critical_write") {
    throw new EffectBrokerError(
      "critical_write_requires_approval",
      "critical_write adapters fail closed until the human approval phase exists.",
    );
  }

  assertAdapterKindMatchesSideEffect(certification);
  assertWriteLifecycleCertification(certification);

  if (
    governedWriteClasses.has(certification.sideEffectClass) &&
    certification.idempotency === "not_required"
  ) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Write-capable adapter ${adapter.adapterId} must declare idempotency handling.`,
    );
  }
}

function assertAdapterDoesNotClaimForbiddenAuthority(
  adapter: EffectAdapter,
): void {
  const adapterRecord = adapter as unknown as Record<string, unknown>;
  const forbiddenKeys = Object.keys(adapterRecord).filter((key) =>
    forbiddenAdapterAuthorityKeys.has(key),
  );
  if (forbiddenKeys.length > 0) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Adapter ${adapter.adapterId} exposes forbidden authority fields: ${forbiddenKeys.join(", ")}.`,
    );
  }
}

function assertAdapterKindMatchesSideEffect(
  certification: AdapterCertification,
): void {
  if (
    (certification.adapterKind === "local_readonly" ||
      certification.adapterKind === "external_read") &&
    writeCapableClasses.has(certification.sideEffectClass)
  ) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Read-only adapter kind ${certification.adapterKind} cannot certify write-capable side-effect class ${certification.sideEffectClass}.`,
    );
  }

  if (
    certification.adapterKind === "external_write" &&
    !writeCapableClasses.has(certification.sideEffectClass)
  ) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      "external_write adapters must certify a write-capable side-effect class.",
    );
  }
}

function assertWriteLifecycleCertification(
  certification: AdapterCertification,
): void {
  if (!governedWriteClasses.has(certification.sideEffectClass)) {
    if (certification.writeLifecycle !== undefined) {
      throw new EffectBrokerError(
        "adapter_write_lifecycle_invalid",
        `Adapter ${certification.adapterId} declares write lifecycle certification for non-write side-effect class ${certification.sideEffectClass}.`,
      );
    }
    return;
  }

  const lifecycle = certification.writeLifecycle;
  if (lifecycle === undefined) {
    throw new EffectBrokerError(
      "adapter_write_lifecycle_missing",
      `Write-capable adapter ${certification.adapterId} must declare write lifecycle certification.`,
    );
  }

  assertRecord(
    lifecycle,
    "adapter_write_lifecycle_invalid",
    `Adapter ${certification.adapterId} write lifecycle certification must be an object.`,
  );
  const lifecycleRecord = lifecycle as Record<string, unknown>;
  assertOnlyKeys(
    lifecycleRecord,
    writeLifecycleKeys,
    "adapter_write_lifecycle_invalid",
    `Adapter ${certification.adapterId} write lifecycle certification`,
  );

  if (lifecycleRecord.preflight !== "required_before_dispatch") {
    throw new EffectBrokerError(
      "adapter_write_lifecycle_invalid",
      `Write-capable adapter ${certification.adapterId} must require preflight before dispatch.`,
    );
  }

  if (
    certification.idempotency !== "required_for_writes" ||
    lifecycleRecord.idempotencyKey !== "tool_command_required"
  ) {
    throw new EffectBrokerError(
      "adapter_write_lifecycle_invalid",
      `Write-capable adapter ${certification.adapterId} must require broker-visible idempotency keys.`,
    );
  }

  if (lifecycleRecord.dispatch !== "broker_governed") {
    throw new EffectBrokerError(
      "adapter_write_lifecycle_invalid",
      `Write-capable adapter ${certification.adapterId} must declare broker-governed dispatch.`,
    );
  }

  if (lifecycleRecord.outcome !== "receipt_candidate_or_quarantine_required") {
    throw new EffectBrokerError(
      "adapter_write_lifecycle_invalid",
      `Write-capable adapter ${certification.adapterId} must require receipt candidate or quarantine outcome.`,
    );
  }

  const forbiddenAuthority = lifecycleRecord.forbiddenAuthority;
  if (
    !Array.isArray(forbiddenAuthority) ||
    forbiddenAuthority.some(
      (authority) =>
        typeof authority !== "string" ||
        !writeLifecycleForbiddenAuthorities.has(authority),
    )
  ) {
    throw new EffectBrokerError(
      "adapter_write_lifecycle_invalid",
      `Write-capable adapter ${certification.adapterId} forbiddenAuthority must list supported authority boundaries.`,
    );
  }

  for (const authority of writeLifecycleForbiddenAuthorities) {
    if (!forbiddenAuthority.includes(authority)) {
      throw new EffectBrokerError(
        "adapter_write_lifecycle_invalid",
        `Write-capable adapter ${certification.adapterId} must explicitly forbid ${authority}.`,
      );
    }
  }
}

function certificationForAdapter(adapter: EffectAdapter): AdapterCertification {
  const rawCertification = (adapter as { readonly certification?: unknown })
    .certification;
  if (
    rawCertification === undefined ||
    rawCertification === null ||
    typeof rawCertification !== "object"
  ) {
    throw new EffectBrokerError(
      "adapter_certification_missing",
      `Adapter ${adapter.adapterId} is missing certification metadata.`,
    );
  }

  const certificationRecord = rawCertification as Record<string, unknown>;
  const unknownKeys = Object.keys(certificationRecord).filter(
    (key) => !certificationKeys.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Adapter ${adapter.adapterId} certification contains unknown fields: ${unknownKeys.join(", ")}.`,
    );
  }

  const certificationVersion = certificationRecord.certificationVersion;
  if (certificationVersion !== 1) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Adapter ${adapter.adapterId} has an unsupported certification version.`,
    );
  }

  if (
    typeof certificationRecord.adapterId !== "string" ||
    typeof certificationRecord.adapterKind !== "string" ||
    typeof certificationRecord.capabilityId !== "string" ||
    typeof certificationRecord.toolId !== "string" ||
    typeof certificationRecord.sideEffectClass !== "string" ||
    !Array.isArray(certificationRecord.declaredReceiptTypes) ||
    !certificationRecord.declaredReceiptTypes.every(
      (receiptType) => typeof receiptType === "string",
    ) ||
    (certificationRecord.declaredObservationTypes !== undefined &&
      (!Array.isArray(certificationRecord.declaredObservationTypes) ||
        !certificationRecord.declaredObservationTypes.every(
          (observationType) => typeof observationType === "string",
        ))) ||
    typeof certificationRecord.idempotency !== "string" ||
    typeof certificationRecord.riskProfile !== "string"
  ) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Adapter ${adapter.adapterId} certification has malformed fields.`,
    );
  }

  if (
    !sideEffectClasses.has(
      certificationRecord.sideEffectClass as SideEffectClass,
    ) ||
    !idempotencyPostures.has(certificationRecord.idempotency) ||
    !riskProfiles.has(certificationRecord.riskProfile)
  ) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Adapter ${adapter.adapterId} certification declares unsupported authority values.`,
    );
  }

  const certification = rawCertification as AdapterCertification;
  if (certification.declaredReceiptTypes.length === 0) {
    throw new EffectBrokerError(
      "adapter_certification_invalid",
      `Adapter ${adapter.adapterId} must declare at least one receipt type.`,
    );
  }

  return certification;
}

function assertCapabilityMatchesCommand(
  capability: CapabilityContract,
  command: ToolCommandRequest,
): void {
  if (capability.sideEffectClass !== command.sideEffectClass) {
    throw new EffectBrokerError(
      "side_effect_class_mismatch",
      `Capability ${capability.capabilityId} declares ${capability.sideEffectClass}, not ${command.sideEffectClass}.`,
    );
  }
}

function assertAdapterMatchesCommand(
  adapter: EffectAdapter,
  command: ToolCommandRequest,
): void {
  if (
    adapter.capabilityId !== command.capabilityId ||
    adapter.toolId !== command.toolId
  ) {
    throw new EffectBrokerError(
      "tool_not_registered",
      `Adapter ${adapter.adapterId} does not match the requested capability/tool.`,
    );
  }

  if (adapter.certification.sideEffectClass !== command.sideEffectClass) {
    throw new EffectBrokerError(
      "adapter_certification_mismatch",
      `Adapter ${adapter.adapterId} certification declares ${adapter.certification.sideEffectClass}, not ${command.sideEffectClass}.`,
    );
  }
}

function assertAdapterCertificationMatchesCapability(
  adapter: EffectAdapter,
  capability: CapabilityContract,
): void {
  const certification = adapter.certification;
  if (certification.sideEffectClass !== capability.sideEffectClass) {
    throw new EffectBrokerError(
      "adapter_certification_mismatch",
      `Adapter ${adapter.adapterId} certification declares ${certification.sideEffectClass}, not capability ${capability.sideEffectClass}.`,
    );
  }

  const declaredCapabilityReceiptTypes = new Set(
    capability.evidence
      .filter((evidence) => evidence.evidenceKind === "effect_receipt")
      .map((evidence) => evidence.receiptType),
  );
  for (const receiptType of certification.declaredReceiptTypes) {
    if (!declaredCapabilityReceiptTypes.has(receiptType)) {
      throw new EffectBrokerError(
        "adapter_certification_undeclared_receipt",
        `Adapter ${adapter.adapterId} certifies undeclared receipt type ${receiptType}.`,
      );
    }
  }

  const declaredCapabilityObservationTypes = new Set(
    capability.evidence
      .filter((evidence) => evidence.evidenceKind === "external_observation")
      .map((evidence) => evidence.observationType),
  );
  for (const observationType of certification.declaredObservationTypes ?? []) {
    if (!declaredCapabilityObservationTypes.has(observationType)) {
      throw new EffectBrokerError(
        "adapter_certification_undeclared_observation",
        `Adapter ${adapter.adapterId} certifies undeclared observation type ${observationType}.`,
      );
    }
  }
}

function assertSideEffectIsDispatchable(command: ToolCommandRequest): void {
  if (command.sideEffectClass === "critical_write") {
    throw new EffectBrokerError(
      "critical_write_requires_approval",
      "critical_write effects fail closed until the human approval phase exists.",
    );
  }

  if (
    governedWriteClasses.has(command.sideEffectClass) &&
    command.idempotencyKey === undefined
  ) {
    throw new EffectBrokerError(
      "idempotency_key_required",
      `${command.sideEffectClass} effects require an idempotencyKey.`,
    );
  }
}

function validateReceiptCandidate(
  receiptCandidate: unknown,
  effectRequest: EffectRequest,
  capability: CapabilityContract,
  certification: AdapterCertification,
): ReceiptCandidate {
  assertRecord(
    receiptCandidate,
    "adapter_receipt_invalid",
    "Adapter receipt candidate must be an object.",
  );
  assertOnlyKeys(
    receiptCandidate,
    receiptCandidateKeys,
    "adapter_receipt_invalid",
    "Adapter receipt candidate",
  );
  assertNonEmptyString(
    receiptCandidate.receiptId,
    "adapter_receipt_invalid",
    "Adapter receipt candidate receiptId must be a non-empty string.",
  );
  assertNonEmptyString(
    receiptCandidate.effectId,
    "adapter_receipt_invalid",
    "Adapter receipt candidate effectId must be a non-empty string.",
  );
  assertNonEmptyString(
    receiptCandidate.runId,
    "adapter_receipt_invalid",
    "Adapter receipt candidate runId must be a non-empty string.",
  );
  assertNonEmptyString(
    receiptCandidate.capabilityId,
    "adapter_receipt_invalid",
    "Adapter receipt candidate capabilityId must be a non-empty string.",
  );
  assertNonEmptyString(
    receiptCandidate.receiptType,
    "adapter_receipt_invalid",
    "Adapter receipt candidate receiptType must be a non-empty string.",
  );
  assertStatus(receiptCandidate.status, "adapter_receipt_invalid");
  assertJsonObject(
    receiptCandidate.payload,
    "adapter_receipt_invalid",
    "Adapter receipt candidate payload must be a JSON object.",
  );
  assertSha256Hash(
    receiptCandidate.payloadHash,
    "adapter_receipt_invalid",
    "Adapter receipt candidate payloadHash must be a sha256 hash.",
  );
  assertIsoDateTime(
    receiptCandidate.observedAt,
    "adapter_receipt_invalid",
    "Adapter receipt candidate observedAt must be an ISO date-time string.",
  );
  assertOptionalNonEmptyString(
    receiptCandidate.externalRef,
    "adapter_receipt_invalid",
    "Adapter receipt candidate externalRef must be a non-empty string.",
  );
  const receiptEvidence = validatePendingEvidenceRefs(
    receiptCandidate.evidence,
    "adapter_receipt_invalid",
    "Adapter receipt candidate evidence",
  );
  if (isReadAdapterKind(certification.adapterKind)) {
    assertNoRawContentKeys(
      receiptCandidate.payload,
      "adapter_receipt_invalid",
      "Adapter read receipt candidate payload",
    );
    assertNoRawContentKeys(
      receiptEvidence,
      "adapter_receipt_invalid",
      "Adapter read receipt candidate evidence",
    );
  }

  if (
    receiptCandidate.effectId !== effectRequest.effectId ||
    receiptCandidate.runId !== effectRequest.runId ||
    receiptCandidate.capabilityId !== effectRequest.capabilityId
  ) {
    throw new EffectBrokerError(
      "receipt_effect_mismatch",
      "Adapter receipt candidate does not match the dispatched effect request.",
    );
  }

  if (receiptCandidate.status === "unknown") {
    throw new EffectBrokerError(
      "adapter_receipt_unknown",
      "Adapter returned an unknown effect status candidate.",
    );
  }

  if (
    canonicalObjectHash(receiptCandidate.payload) !==
    receiptCandidate.payloadHash
  ) {
    throw new EffectBrokerError(
      "adapter_receipt_invalid",
      "Adapter receipt candidate payloadHash does not match the receipt payload.",
    );
  }

  if (
    !certification.declaredReceiptTypes.includes(receiptCandidate.receiptType)
  ) {
    throw new EffectBrokerError(
      "adapter_receipt_invalid",
      `Adapter receipt candidate type ${receiptCandidate.receiptType} is not declared by adapter certification.`,
    );
  }

  const declaredReceiptTypes = new Set(
    capability.evidence
      .filter((evidence) => evidence.evidenceKind === "effect_receipt")
      .map((evidence) => evidence.receiptType),
  );
  if (!declaredReceiptTypes.has(receiptCandidate.receiptType)) {
    throw new EffectBrokerError(
      "adapter_receipt_invalid",
      `Adapter receipt candidate type ${receiptCandidate.receiptType} is not declared by capability ${capability.capabilityId}.`,
    );
  }

  return {
    receiptId: receiptCandidate.receiptId,
    effectId: receiptCandidate.effectId,
    runId: receiptCandidate.runId,
    capabilityId: receiptCandidate.capabilityId,
    receiptType: receiptCandidate.receiptType,
    status: receiptCandidate.status,
    payload: receiptCandidate.payload,
    payloadHash: receiptCandidate.payloadHash,
    evidence: receiptEvidence,
    observedAt: receiptCandidate.observedAt,
    ...(receiptCandidate.externalRef === undefined
      ? {}
      : { externalRef: receiptCandidate.externalRef }),
  };
}

function validateExternalStateObservationCandidate(
  observationCandidate: unknown,
  effectRequest: EffectRequest,
  receiptCandidate: ReceiptCandidate,
  capability: CapabilityContract,
  certification: AdapterCertification,
): ExternalStateObservationCandidate {
  if (receiptCandidate.status !== "succeeded") {
    throw new EffectBrokerError(
      "adapter_observation_receipt_failed",
      "Adapter returned an external observation candidate for a non-succeeded receipt candidate.",
    );
  }

  assertRecord(
    observationCandidate,
    "adapter_observation_invalid",
    "Adapter external observation candidate must be an object.",
  );
  assertOnlyKeys(
    observationCandidate,
    externalStateObservationCandidateKeys,
    "adapter_observation_invalid",
    "Adapter external observation candidate",
  );
  assertNonEmptyString(
    observationCandidate.observationId,
    "adapter_observation_invalid",
    "Adapter observation candidate observationId must be a non-empty string.",
  );
  assertNonEmptyString(
    observationCandidate.runId,
    "adapter_observation_invalid",
    "Adapter observation candidate runId must be a non-empty string.",
  );
  assertNonEmptyString(
    observationCandidate.observationType,
    "adapter_observation_invalid",
    "Adapter observation candidate observationType must be a non-empty string.",
  );
  assertNonEmptyString(
    observationCandidate.subjectType,
    "adapter_observation_invalid",
    "Adapter observation candidate subjectType must be a non-empty string.",
  );
  assertNonEmptyString(
    observationCandidate.subjectId,
    "adapter_observation_invalid",
    "Adapter observation candidate subjectId must be a non-empty string.",
  );
  assertJsonObject(
    observationCandidate.observedState,
    "adapter_observation_invalid",
    "Adapter observation candidate observedState must be a JSON object.",
  );
  assertIsoDateTime(
    observationCandidate.observedAt,
    "adapter_observation_invalid",
    "Adapter observation candidate observedAt must be an ISO date-time string.",
  );
  assertIsoDateTime(
    observationCandidate.expiresAt,
    "adapter_observation_invalid",
    "Adapter observation candidate expiresAt must be an ISO date-time string.",
  );
  assertSha256Hash(
    observationCandidate.payloadHash,
    "adapter_observation_invalid",
    "Adapter observation candidate payloadHash must be a sha256 hash.",
  );
  const observationEvidence = validatePendingEvidenceRefs(
    observationCandidate.evidence,
    "adapter_observation_invalid",
    "Adapter observation candidate evidence",
  );
  if (isReadAdapterKind(certification.adapterKind)) {
    assertNoRawContentKeys(
      observationCandidate.observedState,
      "adapter_observation_invalid",
      "Adapter read observation candidate observedState",
    );
    assertNoRawContentKeys(
      observationEvidence,
      "adapter_observation_invalid",
      "Adapter read observation candidate evidence",
    );
  }

  if (observationCandidate.runId !== effectRequest.runId) {
    throw new EffectBrokerError(
      "adapter_observation_invalid",
      "Adapter observation candidate does not match the dispatched effect run.",
    );
  }

  if (
    canonicalObjectHash(observationCandidate.observedState) !==
    observationCandidate.payloadHash
  ) {
    throw new EffectBrokerError(
      "adapter_observation_invalid",
      "Adapter observation candidate payloadHash does not match the observed state.",
    );
  }

  if (
    Date.parse(observationCandidate.expiresAt) <=
    Date.parse(observationCandidate.observedAt)
  ) {
    throw new EffectBrokerError(
      "adapter_observation_invalid",
      "Adapter observation candidate expiresAt must be later than observedAt.",
    );
  }

  if (
    observationEvidence.length === 0 ||
    observationEvidence.some(
      (evidence) =>
        evidence.kind !== "external_observation" ||
        evidence.hash !== observationCandidate.payloadHash,
    )
  ) {
    throw new EffectBrokerError(
      "adapter_observation_invalid",
      "Adapter observation candidate evidence must be pending external_observation evidence hashed to the observed state.",
    );
  }

  const declaredObservationTypes = new Set(
    capability.evidence
      .filter((evidence) => evidence.evidenceKind === "external_observation")
      .map((evidence) => evidence.observationType),
  );
  if (!declaredObservationTypes.has(observationCandidate.observationType)) {
    throw new EffectBrokerError(
      "adapter_observation_undeclared",
      `Adapter observation candidate type ${observationCandidate.observationType} is not declared by capability ${capability.capabilityId}.`,
    );
  }

  if (
    !(certification.declaredObservationTypes ?? []).includes(
      observationCandidate.observationType,
    )
  ) {
    throw new EffectBrokerError(
      "adapter_observation_undeclared",
      `Adapter observation candidate type ${observationCandidate.observationType} is not declared by adapter certification.`,
    );
  }

  return {
    observationId: observationCandidate.observationId,
    runId: observationCandidate.runId,
    observationType: observationCandidate.observationType,
    subjectType: observationCandidate.subjectType,
    subjectId: observationCandidate.subjectId,
    observedState: observationCandidate.observedState,
    observedAt: observationCandidate.observedAt,
    expiresAt: observationCandidate.expiresAt,
    payloadHash: observationCandidate.payloadHash,
    evidence: observationEvidence,
  };
}

function validatePendingEvidenceRefs(
  evidenceRefs: unknown,
  code: "adapter_observation_invalid" | "adapter_receipt_invalid",
  label: string,
): ReceiptCandidate["evidence"] {
  if (!Array.isArray(evidenceRefs)) {
    throw new EffectBrokerError(code, `${label} must be an array.`);
  }

  for (const [index, evidenceRef] of evidenceRefs.entries()) {
    const indexedLabel = `${label}[${String(index)}]`;
    assertRecord(evidenceRef, code, `${indexedLabel} must be an object.`);
    assertOnlyKeys(evidenceRef, pendingEvidenceRefKeys, code, indexedLabel);
    assertNonEmptyString(
      evidenceRef.evidenceId,
      code,
      `${indexedLabel}.evidenceId must be a non-empty string.`,
    );
    assertEvidenceKind(
      evidenceRef.kind,
      code,
      `${indexedLabel}.kind is unsupported.`,
    );
    if (evidenceRef.admissionStatus !== "pending") {
      throw new EffectBrokerError(
        code,
        `${indexedLabel}.admissionStatus must be pending.`,
      );
    }
    assertNonEmptyString(
      evidenceRef.pendingAdmissionToken,
      code,
      `${indexedLabel}.pendingAdmissionToken must be a non-empty string.`,
    );
    assertSha256Hash(
      evidenceRef.hash,
      code,
      `${indexedLabel}.hash must be a sha256 hash.`,
    );
    assertIsoDateTime(
      evidenceRef.observedAt,
      code,
      `${indexedLabel}.observedAt must be an ISO date-time string.`,
    );
    assertEvidenceSensitivity(
      evidenceRef.sensitivity,
      code,
      `${indexedLabel}.sensitivity is unsupported.`,
    );
    assertOptionalNonEmptyString(
      evidenceRef.artifactUri,
      code,
      `${indexedLabel}.artifactUri must be a non-empty string.`,
    );
    assertOptionalIsoDateTime(
      evidenceRef.expiresAt,
      code,
      `${indexedLabel}.expiresAt must be an ISO date-time string.`,
    );
    assertOptionalJsonObject(
      evidenceRef.metadata,
      code,
      `${indexedLabel}.metadata must be a JSON object.`,
    );
  }

  return evidenceRefs as ReceiptCandidate["evidence"];
}

function assertRecord(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EffectBrokerError(code, message);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  code: EffectBrokerError["code"],
  label: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new EffectBrokerError(
      code,
      `${label} contains unknown fields: ${unknownKeys.join(", ")}.`,
    );
  }
}

function assertNonEmptyString(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EffectBrokerError(code, message);
  }
}

function assertOptionalNonEmptyString(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertNonEmptyString(value, code, message);
  }
}

function assertStatus(
  value: unknown,
  code: EffectBrokerError["code"],
): asserts value is ReceiptCandidate["status"] {
  if (typeof value !== "string" || !effectStatuses.has(value)) {
    throw new EffectBrokerError(
      code,
      "Adapter receipt candidate status is unsupported.",
    );
  }
}

function assertEvidenceKind(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is ReceiptCandidate["evidence"][number]["kind"] {
  if (typeof value !== "string" || !evidenceKinds.has(value)) {
    throw new EffectBrokerError(code, message);
  }
}

function assertEvidenceSensitivity(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is ReceiptCandidate["evidence"][number]["sensitivity"] {
  if (typeof value !== "string" || !evidenceSensitivities.has(value)) {
    throw new EffectBrokerError(code, message);
  }
}

function assertSha256Hash(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new EffectBrokerError(code, message);
  }
}

function assertIsoDateTime(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new EffectBrokerError(code, message);
  }
}

function assertOptionalIsoDateTime(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertIsoDateTime(value, code, message);
  }
}

function assertJsonObject(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new EffectBrokerError(code, message);
  }
}

function assertOptionalJsonObject(
  value: unknown,
  code: EffectBrokerError["code"],
  message: string,
): asserts value is JsonObject | undefined {
  if (value !== undefined) {
    assertJsonObject(value, code, message);
  }
}

function assertNoRawContentKeys(
  value: unknown,
  code: EffectBrokerError["code"],
  label: string,
): void {
  const leakedKey = firstRawContentKey(value);
  if (leakedKey !== undefined) {
    throw new EffectBrokerError(
      code,
      `${label} contains raw-content field ${leakedKey}.`,
    );
  }
}

function firstRawContentKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = firstRawContentKey(item);
      if (key !== undefined) {
        return key;
      }
    }
    return undefined;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (rawContentKeys.has(key)) {
        return key;
      }

      const nestedKey = firstRawContentKey(item);
      if (nestedKey !== undefined) {
        return nestedKey;
      }
    }
  }

  return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}

function isReadAdapterKind(adapterKind: AdapterKind): boolean {
  return adapterKind === "external_read" || adapterKind === "local_readonly";
}

function idempotencyFingerprint(command: ToolCommandRequest): string {
  return canonicalObjectHash({
    args: command.args,
    capabilityId: command.capabilityId,
    runId: command.runId,
    sideEffectClass: command.sideEffectClass,
    toolId: command.toolId,
    ...(command.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: command.idempotencyKey }),
  });
}

function writePreflightFingerprint(command: ToolCommandRequest): string {
  return canonicalObjectHash({
    argsHash: canonicalObjectHash(command.args),
    capabilityId: command.capabilityId,
    commandId: command.commandId,
    runId: command.runId,
    sideEffectClass: command.sideEffectClass,
    toolId: command.toolId,
    ...(command.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: command.idempotencyKey }),
  });
}

function writeDispatchQuarantineState(input: {
  readonly adapterId: string;
  readonly command: ToolCommandRequest;
  readonly effectId: string;
  readonly message: string;
  readonly preflightDecision: WritePreflightDecision;
  readonly quarantinedAt: string;
}): WriteQuarantineState {
  return {
    kind: "write_quarantine_state",
    quarantineId: `quarantine_${sanitizeId(input.preflightDecision.preflightId)}_dispatch`,
    runId: input.command.runId,
    preflightId: input.preflightDecision.preflightId,
    commandId: input.command.commandId,
    capabilityId: input.command.capabilityId,
    toolId: input.command.toolId,
    sideEffectClass: input.command.sideEffectClass as WriteSideEffectClass,
    status: "quarantined",
    reason: "uncertain_external_effect",
    message: input.message,
    quarantinedAt: input.quarantinedAt,
    ...(input.command.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.command.idempotencyKey }),
    metadata: {
      adapterId: input.adapterId,
      effectId: input.effectId,
      outcome: "adapter_error_or_unknown",
    },
  };
}

function writeQuarantineMessage(adapterId: string, error: unknown): string {
  if (error instanceof EffectBrokerError) {
    return `Write adapter ${adapterId} did not produce an admissible receipt candidate: ${error.code}.`;
  }

  return `Write adapter ${adapterId} outcome is uncertain after adapter error.`;
}

function defaultEffectId(command: ToolCommandRequest): string {
  return `effect_${sanitizeId(command.commandId)}`;
}

function defaultPreflightId(command: ToolCommandRequest): string {
  return `preflight_${sanitizeId(command.commandId)}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function adapterKey(capabilityId: string, toolId: string): string {
  return `${capabilityId}\0${toolId}`;
}

function systemClock(): string {
  return new Date().toISOString();
}
