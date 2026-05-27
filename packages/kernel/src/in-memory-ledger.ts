import type { RunEvent, RunEventType } from "@amca/protocol";

import {
  cloneRunEvent,
  EventValidationError,
  orderAndValidateRunEvents,
  prepareRunEvent,
  type RunEventAppendInput,
} from "./events.js";

export interface InMemoryLedgerOptions {
  runId: string;
  initialEvents?: readonly RunEvent[];
}

export class InMemoryLedger {
  readonly runId: string;

  #events: RunEvent[] = [];
  #eventIds = new Set<string>();

  constructor(options: InMemoryLedgerOptions) {
    if (options.runId.trim().length === 0) {
      throw new EventValidationError(
        "empty_run_id",
        "In-memory ledger runId must be a non-empty string.",
      );
    }

    this.runId = options.runId;

    if (options.initialEvents !== undefined) {
      for (const event of orderAndValidateRunEvents(
        options.initialEvents,
        this.runId,
      )) {
        this.#events.push(event);
        this.#eventIds.add(event.eventId);
      }
    }
  }

  get lastSequence(): number {
    return this.#events.length;
  }

  append<TType extends RunEventType>(
    input: RunEventAppendInput<TType>,
  ): RunEvent<TType> {
    if (this.#eventIds.has(input.eventId)) {
      throw new EventValidationError(
        "duplicate_event_id",
        `Event ${input.eventId} already exists in run ${this.runId}.`,
      );
    }

    if (
      input.causationId !== undefined &&
      input.causationId !== null &&
      !this.#eventIds.has(input.causationId)
    ) {
      throw new EventValidationError(
        "invalid_causation_id",
        `Event ${input.eventId} causationId ${input.causationId} does not reference an earlier event.`,
      );
    }

    const event = prepareRunEvent(input, this.runId, this.lastSequence + 1);
    this.#events.push(event);
    this.#eventIds.add(event.eventId);
    return cloneRunEvent(event);
  }

  events(): RunEvent[] {
    return this.#events.map(cloneRunEvent);
  }

  replay(): RunEvent[] {
    return orderAndValidateRunEvents(this.#events, this.runId);
  }
}
