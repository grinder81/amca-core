import { parseRunEvent } from "@amca/contracts";
import {
  InMemorySemanticLedger,
  LedgerError,
  type AppendRunEventResult,
  type LedgerCertificationManifest,
  type SemanticLedger,
  cloneRunEvent,
  validateOrderedRunEvents,
} from "@amca/ledger";
import type { RunEvent } from "@amca/protocol";

export {
  assertLedgerCertificationManifest,
  validateLedgerCertificationManifest,
  type LedgerCertificationEvidence,
  type LedgerCertificationLevel,
  type LedgerCertificationValidationIssue,
  type LedgerCertificationValidationResult,
} from "@amca/ledger";

export const LEDGER_POSTGRES_CERTIFICATION: LedgerCertificationManifest = {
  packageName: "@amca/ledger-postgres",
  currentLevel: "live_integration_certified",
  targetLevel: "durable_production_certified",
  allowedAuthority: [
    "implement the SemanticLedger contract against a query-client boundary",
    "validate append ordering with the in-memory ledger contract before insert",
    "map stored Postgres rows back into strict AMCA RunEvent objects",
    "store and read accepted AMCA RunEvent streams against a configured Postgres service after live integration certification",
  ],
  forbiddenAuthority: [
    "durable production certification",
    "proof authority",
    "release decision",
    "effect dispatch",
  ],
  evidence: {
    phaseReports: ["docs/ledger.md#postgres-ledger"],
    missionTests: [
      "packages/testing/src/mission/postgres-ledger-adapter.mission.test.ts",
    ],
    focusedCommands: [
      "pnpm exec vitest run packages/ledger-postgres/src/postgres-semantic-ledger.test.ts",
      "AMCA_LEDGER_POSTGRES_TEST_URL=<postgres-url> pnpm exec vitest run packages/ledger-postgres/src/postgres-semantic-ledger.live.test.ts",
    ],
    liveIntegrationTests: [
      "migration-from-scratch-real-postgres",
      "append-only-update-delete-real-postgres",
      "duplicate-event-id-real-postgres",
      "duplicate-run-sequence-real-postgres",
      "transaction-rollback-no-partial-event-real-postgres",
      "payload-hash-tamper-rejected-real-postgres",
      "projection-snapshot-rejected-real-postgres",
      "connection-failure-does-not-synthesize-event-real-postgres",
      "concurrent-append-same-run-sequence-race-real-postgres",
      "concurrent-append-different-runs-allowed-real-postgres",
      "read-after-write-consistency-real-postgres",
    ],
    durabilityTests: [],
  },
};

export interface PostgresQueryResult<TRow = Record<string, unknown>> {
  readonly rows: readonly TRow[];
}

export interface PostgresQueryClient {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<TRow>>;
}

export interface PostgresSemanticLedgerOptions {
  readonly client: PostgresQueryClient;
}

interface StoredRunEventRow {
  readonly eventId: unknown;
  readonly runId: unknown;
  readonly sequence: unknown;
  readonly type: unknown;
  readonly payload: unknown;
  readonly payloadHash: unknown;
  readonly causationId: unknown;
  readonly correlationId: unknown;
  readonly occurredAt: unknown;
}

interface ExistsRow {
  readonly exists: unknown;
}

const selectRunEventsSql = `
SELECT
  event_id AS "eventId",
  run_id AS "runId",
  sequence,
  type,
  payload,
  payload_hash AS "payloadHash",
  causation_id AS "causationId",
  correlation_id AS "correlationId",
  occurred_at AS "occurredAt"
FROM amca_run_events
WHERE run_id = $1
ORDER BY sequence ASC`;

const selectRunEventsForAppendSql = `${selectRunEventsSql}
FOR UPDATE`;

const insertRunEventSql = `
INSERT INTO amca_run_events (
  event_id,
  run_id,
  sequence,
  type,
  payload,
  payload_hash,
  causation_id,
  correlation_id,
  occurred_at
) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`;

const hasRunSql = `
SELECT true AS "exists"
FROM amca_run_events
WHERE run_id = $1
LIMIT 1`;

const lockRunForAppendSql = `
SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`;

export class PostgresSemanticLedger implements SemanticLedger {
  readonly #client: PostgresQueryClient;

  constructor(options: PostgresSemanticLedgerOptions) {
    this.#client = options.client;
  }

  async appendAcceptedEvent(event: RunEvent): Promise<AppendRunEventResult> {
    return this.appendAcceptedEventToRun(event.runId, event);
  }

  async appendAcceptedEventToRun(
    runId: string,
    event: RunEvent,
  ): Promise<AppendRunEventResult> {
    assertNonEmptyId("runId", runId, "empty_run_id");
    const acceptedEvent = parseAppendRunEvent(event);

    await this.#client.query("BEGIN");
    try {
      await this.#client.query(lockRunForAppendSql, [runId]);
      const existingEvents = await this.selectRunEvents(runId, {
        lockForAppend: true,
        requireExistingRun: false,
      });
      const validator = new InMemorySemanticLedger({
        initialEvents: existingEvents,
      });
      const result = await validator.appendAcceptedEventToRun(
        runId,
        acceptedEvent,
      );

      await this.#client.query(insertRunEventSql, [
        acceptedEvent.eventId,
        acceptedEvent.runId,
        acceptedEvent.sequence,
        acceptedEvent.type,
        JSON.stringify(acceptedEvent.payload),
        acceptedEvent.payloadHash,
        acceptedEvent.causationId,
        acceptedEvent.correlationId,
        acceptedEvent.occurredAt,
      ]);
      await this.#client.query("COMMIT");

      return result;
    } catch (error) {
      await rollbackQuietly(this.#client);
      throw mapPostgresError(error, event);
    }
  }

  async readRunEvents(runId: string): Promise<RunEvent[]> {
    assertNonEmptyId("runId", runId, "empty_run_id");
    return this.selectRunEvents(runId, {
      lockForAppend: false,
      requireExistingRun: true,
    });
  }

  async getRunEvent(runId: string, eventId: string): Promise<RunEvent> {
    assertNonEmptyId("runId", runId, "empty_run_id");
    assertNonEmptyId("eventId", eventId, "empty_event_id");

    const events = await this.readRunEvents(runId);
    const event = events.find((candidate) => candidate.eventId === eventId);
    if (event === undefined) {
      throw new LedgerError(
        "event_not_found",
        `Event ${eventId} does not exist in run ${runId}.`,
      );
    }

    return event;
  }

  async hasRun(runId: string): Promise<boolean> {
    assertNonEmptyId("runId", runId, "empty_run_id");
    const result = await this.#client.query<ExistsRow>(hasRunSql, [runId]);
    return result.rows.length > 0;
  }

  async verifyRunIntegrity(runId: string): Promise<void> {
    await this.readRunEvents(runId);
  }

  private async selectRunEvents(
    runId: string,
    options: {
      readonly lockForAppend: boolean;
      readonly requireExistingRun: boolean;
    },
  ): Promise<RunEvent[]> {
    const result = await this.#client.query<StoredRunEventRow>(
      options.lockForAppend ? selectRunEventsForAppendSql : selectRunEventsSql,
      [runId],
    );

    if (result.rows.length === 0) {
      if (options.requireExistingRun) {
        throw new LedgerError(
          "run_not_found",
          `Run ${runId} does not exist in the Postgres semantic ledger.`,
        );
      }

      return [];
    }

    const events = result.rows.map((row, index) =>
      parseStoredRunEvent(row, runId, index),
    );
    return validateOrderedRunEvents(events, runId);
  }
}

function parseAppendRunEvent(event: RunEvent): RunEvent {
  try {
    return cloneRunEvent(parseRunEvent(event));
  } catch (error) {
    if (error instanceof LedgerError) {
      throw error;
    }

    throw new LedgerError(
      "integrity_violation",
      `RunEvent failed strict validation before Postgres append: ${formatError(
        error,
      )}`,
    );
  }
}

function parseStoredRunEvent(
  row: StoredRunEventRow,
  runId: string,
  index: number,
): RunEvent {
  try {
    return cloneRunEvent(
      parseRunEvent({
        eventId: row.eventId,
        runId: row.runId,
        sequence: row.sequence,
        type: row.type,
        payload: row.payload,
        payloadHash: row.payloadHash,
        causationId: row.causationId,
        correlationId: row.correlationId,
        occurredAt: normalizeOccurredAt(row.occurredAt),
      }),
    );
  } catch (error) {
    if (error instanceof LedgerError) {
      throw error;
    }

    throw new LedgerError(
      "tamper_detected",
      `Postgres run ${runId} row ${String(
        index + 1,
      )} is not a valid RunEvent: ${formatError(error)}`,
    );
  }
}

function normalizeOccurredAt(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
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

async function rollbackQuietly(client: PostgresQueryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the append/read validation error that forced the rollback.
  }
}

function mapPostgresError(error: unknown, event: RunEvent): unknown {
  if (!isPostgresError(error)) {
    return error;
  }

  if (error.code === "23505") {
    if (error.constraint === "amca_run_events_sequence_unique") {
      return new LedgerError(
        "duplicate_sequence",
        `Run ${event.runId} already has an event at sequence ${String(
          event.sequence,
        )}.`,
      );
    }

    if (error.constraint === "amca_run_events_pkey") {
      return new LedgerError(
        "duplicate_event_id",
        `Event ${event.eventId} already exists in run ${event.runId}.`,
      );
    }
  }

  if (error.code === "23514") {
    return new LedgerError(
      "integrity_violation",
      `Postgres rejected RunEvent ${event.eventId}: ${error.message}`,
    );
  }

  return error;
}

function isPostgresError(error: unknown): error is {
  readonly code: string;
  readonly constraint?: string;
  readonly message: string;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
