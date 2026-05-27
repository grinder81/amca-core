import type {
  JsonObject,
  JsonValue,
  RunEvent,
  RunEventPayloadByType,
  RunEventType,
  Sha256Hash,
} from "@amca/protocol";
import {
  canonicalHash as canonicalJsonHash,
  canonicalJson as serializeCanonicalJson,
} from "@amca/contracts";

export type EventValidationErrorCode =
  | "duplicate_event_id"
  | "empty_event_id"
  | "empty_run_id"
  | "invalid_causation_id"
  | "invalid_payload"
  | "invalid_sequence"
  | "payload_hash_mismatch"
  | "run_id_mismatch";

export class EventValidationError extends Error {
  readonly code: EventValidationErrorCode;

  constructor(code: EventValidationErrorCode, message: string) {
    super(message);
    this.name = "EventValidationError";
    this.code = code;
  }
}

export interface RunEventAppendInput<
  TType extends RunEventType = RunEventType,
> {
  eventId: string;
  runId: string;
  sequence?: number;
  type: TType;
  payload: RunEventPayloadByType[TType];
  payloadHash?: Sha256Hash;
  causationId?: string | null;
  correlationId?: string | null;
  occurredAt: string;
}

export function canonicalJson(value: unknown): string {
  try {
    return serializeCanonicalJson(toJsonValue(value));
  } catch (error) {
    if (error instanceof EventValidationError) {
      throw error;
    }

    throw new EventValidationError(
      "invalid_payload",
      "Event payload must be JSON-compatible for deterministic hashing.",
    );
  }
}

export function hashRunEventPayload(payload: unknown): Sha256Hash {
  try {
    return canonicalJsonHash(toJsonValue(payload));
  } catch (error) {
    if (error instanceof EventValidationError) {
      throw error;
    }

    throw new EventValidationError(
      "invalid_payload",
      "Event payload must be JSON-compatible for deterministic hashing.",
    );
  }
}

export function prepareRunEvent<TType extends RunEventType>(
  input: RunEventAppendInput<TType>,
  expectedRunId: string,
  expectedSequence: number,
): RunEvent<TType> {
  assertNonEmptyId("eventId", input.eventId, "empty_event_id");
  assertNonEmptyId("runId", input.runId, "empty_run_id");

  if (input.runId !== expectedRunId) {
    throw new EventValidationError(
      "run_id_mismatch",
      `Event runId ${input.runId} does not match ledger runId ${expectedRunId}.`,
    );
  }

  const sequence = input.sequence ?? expectedSequence;
  assertExpectedSequence(sequence, expectedSequence);

  const payloadHash = hashRunEventPayload(input.payload);
  if (input.payloadHash !== undefined && input.payloadHash !== payloadHash) {
    throw new EventValidationError(
      "payload_hash_mismatch",
      `Event ${input.eventId} payloadHash does not match its canonical payload.`,
    );
  }

  return {
    eventId: input.eventId,
    runId: input.runId,
    sequence,
    type: input.type,
    payload: cloneJsonCompatible(input.payload),
    payloadHash,
    causationId: input.causationId ?? null,
    correlationId: input.correlationId ?? null,
    occurredAt: input.occurredAt,
  };
}

export function orderAndValidateRunEvents(
  events: readonly RunEvent[],
  expectedRunId?: string,
): RunEvent[] {
  const ordered = [...events].sort((left, right) => {
    if (left.sequence === right.sequence) {
      return left.eventId.localeCompare(right.eventId);
    }

    return left.sequence - right.sequence;
  });

  const runId = expectedRunId ?? ordered[0]?.runId;
  if (runId === undefined) {
    return [];
  }

  const seenEventIds = new Set<string>();
  for (const [index, event] of ordered.entries()) {
    assertNonEmptyId("eventId", event.eventId, "empty_event_id");
    assertNonEmptyId("runId", event.runId, "empty_run_id");

    if (event.runId !== runId) {
      throw new EventValidationError(
        "run_id_mismatch",
        `Event runId ${event.runId} does not match replay runId ${runId}.`,
      );
    }

    if (seenEventIds.has(event.eventId)) {
      throw new EventValidationError(
        "duplicate_event_id",
        `Event ${event.eventId} appears more than once in the run sequence.`,
      );
    }

    assertExpectedSequence(event.sequence, index + 1);
    assertPayloadHashMatches(event);

    if (event.causationId !== null && !seenEventIds.has(event.causationId)) {
      throw new EventValidationError(
        "invalid_causation_id",
        `Event ${event.eventId} causationId ${event.causationId} does not reference an earlier event.`,
      );
    }

    seenEventIds.add(event.eventId);
  }

  return ordered.map(cloneRunEvent);
}

export function assertPayloadHashMatches(event: RunEvent): void {
  const payloadHash = hashRunEventPayload(event.payload);
  if (event.payloadHash !== payloadHash) {
    throw new EventValidationError(
      "payload_hash_mismatch",
      `Event ${event.eventId} payloadHash does not match its canonical payload.`,
    );
  }
}

function assertExpectedSequence(
  sequence: number,
  expectedSequence: number,
): void {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new EventValidationError(
      "invalid_sequence",
      `Event sequence must be a positive integer; received ${String(sequence)}.`,
    );
  }

  if (sequence !== expectedSequence) {
    throw new EventValidationError(
      "invalid_sequence",
      `Event sequence must be contiguous; expected ${String(
        expectedSequence,
      )}, received ${String(sequence)}.`,
    );
  }
}

function assertNonEmptyId(
  fieldName: "eventId" | "runId",
  value: string,
  code: "empty_event_id" | "empty_run_id",
): void {
  if (value.trim().length === 0) {
    throw new EventValidationError(
      code,
      `Event ${fieldName} must be a non-empty string.`,
    );
  }
}

export function cloneRunEvent<TType extends RunEventType>(
  event: RunEvent<TType>,
): RunEvent<TType> {
  return {
    ...event,
    payload: cloneJsonCompatible(event.payload),
  };
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
        throw new EventValidationError(
          "invalid_payload",
          "Event payload numbers must be finite.",
        );
      }
      return value;

    case "object":
      if (Array.isArray(value)) {
        return toJsonArray(value);
      }

      return toJsonObject(value);

    default:
      throw new EventValidationError(
        "invalid_payload",
        "Event payload must contain only JSON-compatible values.",
      );
  }
}

function toJsonArray(values: readonly unknown[]): JsonValue[] {
  const jsonValues: JsonValue[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (!(index in values)) {
      throw new EventValidationError(
        "invalid_payload",
        "Event payload arrays must not contain sparse entries.",
      );
    }

    jsonValues.push(toJsonValue(values[index]));
  }

  return jsonValues;
}

function toJsonObject(value: object): JsonObject {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EventValidationError(
      "invalid_payload",
      "Event payload objects must be plain JSON objects.",
    );
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).map((key) => [key, toJsonValue(record[key])]),
  );
}
