import type { JsonValue, RunEvent, Sha256Hash } from "@amca/protocol";
import {
  canonicalHash,
  canonicalJson as serializeCanonicalJson,
} from "@amca/contracts";

import { LedgerError } from "./errors.js";

export interface AppendRunEventResult {
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
}

export interface SemanticLedger {
  appendAcceptedEvent(event: RunEvent): Promise<AppendRunEventResult>;
  appendAcceptedEventToRun(
    runId: string,
    event: RunEvent,
  ): Promise<AppendRunEventResult>;
  readRunEvents(runId: string): Promise<RunEvent[]>;
  getRunEvent(runId: string, eventId: string): Promise<RunEvent>;
  hasRun(runId: string): Promise<boolean>;
  verifyRunIntegrity(runId: string): Promise<void>;
}

export interface InMemorySemanticLedgerOptions {
  readonly initialEvents?: readonly RunEvent[];
}

export class InMemorySemanticLedger implements SemanticLedger {
  readonly #eventsByRun = new Map<string, RunEvent[]>();
  readonly #eventIdsByRun = new Map<string, Set<string>>();

  constructor(options: InMemorySemanticLedgerOptions = {}) {
    for (const event of options.initialEvents ?? []) {
      this.appendAcceptedEventSync(event);
    }
  }

  appendAcceptedEvent(event: RunEvent): Promise<AppendRunEventResult> {
    return Promise.resolve().then(() => this.appendAcceptedEventSync(event));
  }

  appendAcceptedEventToRun(
    runId: string,
    event: RunEvent,
  ): Promise<AppendRunEventResult> {
    return Promise.resolve().then(() => {
      assertNonEmptyId("runId", runId, "empty_run_id");
      if (event.runId !== runId) {
        throw new LedgerError(
          "run_id_mismatch",
          `Event runId ${event.runId} does not match target runId ${runId}.`,
        );
      }

      return this.appendAcceptedEventSync(event);
    });
  }

  readRunEvents(runId: string): Promise<RunEvent[]> {
    return Promise.resolve().then(() => {
      assertNonEmptyId("runId", runId, "empty_run_id");
      const events = this.#eventsByRun.get(runId);
      if (events === undefined) {
        throw new LedgerError(
          "run_not_found",
          `Run ${runId} does not exist in the semantic ledger.`,
        );
      }

      return events.map(cloneRunEvent);
    });
  }

  getRunEvent(runId: string, eventId: string): Promise<RunEvent> {
    return Promise.resolve().then(() => {
      assertNonEmptyId("runId", runId, "empty_run_id");
      assertNonEmptyId("eventId", eventId, "empty_event_id");

      const events = this.#eventsByRun.get(runId);
      if (events === undefined) {
        throw new LedgerError(
          "run_not_found",
          `Run ${runId} does not exist in the semantic ledger.`,
        );
      }

      const event = events.find((candidate) => candidate.eventId === eventId);
      if (event === undefined) {
        throw new LedgerError(
          "event_not_found",
          `Event ${eventId} does not exist in run ${runId}.`,
        );
      }

      return cloneRunEvent(event);
    });
  }

  hasRun(runId: string): Promise<boolean> {
    return Promise.resolve().then(() => {
      assertNonEmptyId("runId", runId, "empty_run_id");
      return this.#eventsByRun.has(runId);
    });
  }

  verifyRunIntegrity(runId: string): Promise<void> {
    return Promise.resolve().then(() => {
      assertNonEmptyId("runId", runId, "empty_run_id");
      const events = this.#eventsByRun.get(runId);
      if (events === undefined) {
        throw new LedgerError(
          "run_not_found",
          `Run ${runId} does not exist in the semantic ledger.`,
        );
      }

      validateOrderedRunEvents(events, runId);
    });
  }

  private appendAcceptedEventSync(event: RunEvent): AppendRunEventResult {
    validateRunEventShape(event);
    assertPayloadHashMatches(event);

    const events = this.#eventsByRun.get(event.runId) ?? [];
    const eventIds = this.#eventIdsByRun.get(event.runId) ?? new Set<string>();
    const expectedSequence = events.length + 1;

    if (eventIds.has(event.eventId)) {
      throw new LedgerError(
        "duplicate_event_id",
        `Event ${event.eventId} already exists in run ${event.runId}.`,
      );
    }

    if (events.some((candidate) => candidate.sequence === event.sequence)) {
      throw new LedgerError(
        "duplicate_sequence",
        `Run ${event.runId} already has an event at sequence ${String(
          event.sequence,
        )}.`,
      );
    }

    if (event.sequence !== expectedSequence) {
      throw new LedgerError(
        "non_contiguous_sequence",
        `Run ${event.runId} expected sequence ${String(
          expectedSequence,
        )}, received ${String(event.sequence)}.`,
      );
    }

    if (event.causationId !== null && !eventIds.has(event.causationId)) {
      throw new LedgerError(
        "invalid_causation_id",
        `Event ${event.eventId} causationId ${event.causationId} does not reference an earlier accepted event.`,
      );
    }

    events.push(cloneRunEvent(event));
    eventIds.add(event.eventId);
    this.#eventsByRun.set(event.runId, events);
    this.#eventIdsByRun.set(event.runId, eventIds);

    return {
      runId: event.runId,
      eventId: event.eventId,
      sequence: event.sequence,
    };
  }
}

export function validateOrderedRunEvents(
  events: readonly RunEvent[],
  expectedRunId?: string,
): RunEvent[] {
  if (events.length === 0) {
    return [];
  }

  const runId = expectedRunId ?? events[0]?.runId;
  if (runId === undefined) {
    throw new LedgerError(
      "integrity_violation",
      "Run event stream must have a runId.",
    );
  }

  assertNonEmptyId("runId", runId, "empty_run_id");

  const seenEventIds = new Set<string>();
  const seenSequences = new Set<number>();

  for (const [index, event] of events.entries()) {
    validateRunEventShape(event);

    if (event.runId !== runId) {
      throw new LedgerError(
        "run_id_mismatch",
        `Event runId ${event.runId} does not match expected runId ${runId}.`,
      );
    }

    if (seenEventIds.has(event.eventId)) {
      throw new LedgerError(
        "duplicate_event_id",
        `Event ${event.eventId} appears more than once in run ${runId}.`,
      );
    }

    if (seenSequences.has(event.sequence)) {
      throw new LedgerError(
        "duplicate_sequence",
        `Sequence ${String(event.sequence)} appears more than once in run ${runId}.`,
      );
    }

    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new LedgerError(
        "non_contiguous_sequence",
        `Run ${runId} expected sequence ${String(
          expectedSequence,
        )}, received ${String(event.sequence)}.`,
      );
    }

    assertPayloadHashMatches(event);
    if (event.causationId !== null && !seenEventIds.has(event.causationId)) {
      throw new LedgerError(
        "invalid_causation_id",
        `Event ${event.eventId} causationId ${event.causationId} does not reference an earlier accepted event.`,
      );
    }

    seenEventIds.add(event.eventId);
    seenSequences.add(event.sequence);
  }

  return events.map(cloneRunEvent);
}

export function hashRunEventPayload(payload: unknown): Sha256Hash {
  try {
    return canonicalHash(toJsonValue(payload));
  } catch (error) {
    if (error instanceof LedgerError) {
      throw error;
    }

    throw new LedgerError(
      "invalid_payload",
      "RunEvent payload must be JSON-compatible for deterministic hashing.",
    );
  }
}

export function cloneRunEvent<TEvent extends RunEvent>(event: TEvent): TEvent {
  validateRunEventShape(event);
  const clonedPayload = cloneJsonCompatible(event.payload);

  return {
    ...event,
    payload: clonedPayload,
  };
}

export function assertPayloadHashMatches(event: RunEvent): void {
  const payloadHash = hashRunEventPayload(event.payload);
  if (event.payloadHash !== payloadHash) {
    throw new LedgerError(
      "payload_hash_mismatch",
      `Event ${event.eventId} payloadHash does not match its canonical payload.`,
    );
  }
}

function validateRunEventShape(event: unknown): asserts event is RunEvent {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new LedgerError("integrity_violation", "RunEvent must be an object.");
  }

  const candidate = event as Partial<RunEvent>;

  assertNonEmptyId("eventId", candidate.eventId, "empty_event_id");
  assertNonEmptyId("runId", candidate.runId, "empty_run_id");

  const sequence = candidate.sequence;
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    sequence < 1
  ) {
    throw new LedgerError(
      "invalid_sequence",
      `RunEvent sequence must be a positive integer; received ${String(
        sequence,
      )}.`,
    );
  }

  if (
    typeof candidate.type !== "string" ||
    candidate.type.trim().length === 0
  ) {
    throw new LedgerError(
      "integrity_violation",
      "RunEvent type must be a non-empty string.",
    );
  }

  if (
    typeof candidate.payloadHash !== "string" ||
    !candidate.payloadHash.startsWith("sha256:")
  ) {
    throw new LedgerError(
      "integrity_violation",
      "RunEvent payloadHash must be a sha256 hash string.",
    );
  }

  if (
    typeof candidate.occurredAt !== "string" ||
    candidate.occurredAt.length === 0
  ) {
    throw new LedgerError(
      "integrity_violation",
      "RunEvent occurredAt must be a non-empty string.",
    );
  }

  assertNullOrString("causationId", candidate.causationId);
  assertNullOrString("correlationId", candidate.correlationId);

  try {
    toJsonValue(candidate.payload);
  } catch (error) {
    if (error instanceof LedgerError) {
      throw error;
    }

    throw new LedgerError(
      "invalid_payload",
      "RunEvent payload must be JSON-compatible.",
    );
  }
}

function assertNullOrString(
  fieldName: "causationId" | "correlationId",
  value: unknown,
): void {
  if (value !== null && typeof value !== "string") {
    throw new LedgerError(
      "integrity_violation",
      `RunEvent ${fieldName} must be a string or null.`,
    );
  }
}

function assertNonEmptyId(
  fieldName: "eventId" | "runId",
  value: unknown,
  code: "empty_event_id" | "empty_run_id",
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LedgerError(
      code,
      `RunEvent ${fieldName} must be a non-empty string.`,
    );
  }
}

function cloneJsonCompatible<TValue>(value: TValue): TValue {
  const parsed: unknown = JSON.parse(
    serializeCanonicalJson(toJsonValue(value)),
  );
  return parsed as TValue;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;

    case "number":
      if (!Number.isFinite(value)) {
        throw new LedgerError(
          "invalid_payload",
          "RunEvent payload numbers must be finite.",
        );
      }
      return value;

    case "object":
      if (Array.isArray(value)) {
        return value.map(toJsonValue);
      }

      return toJsonObject(value);

    default:
      throw new LedgerError(
        "invalid_payload",
        "RunEvent payload must contain only JSON-compatible values.",
      );
  }
}

function toJsonObject(value: object): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};

  for (const [key, entryValue] of Object.entries(value)) {
    output[key] = toJsonValue(entryValue);
  }

  return output;
}
