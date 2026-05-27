import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { LedgerError, hashRunEventPayload } from "@amca/ledger";
import type { RunEvent, Sha256Hash } from "@amca/protocol";

import {
  PostgresSemanticLedger,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "./index.js";

const runId = "run_postgres_ledger";
const otherRunId = "run_other";
const occurredAt = "2026-05-24T12:00:00.000Z";
const migrationUrl = new URL(
  "../migrations/0001_run_events.sql",
  import.meta.url,
);
const badHash =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" satisfies Sha256Hash;

describe("PostgresSemanticLedger", () => {
  it("appends a valid accepted RunEvent and exposes the ledger port queries", async () => {
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });

    await expect(ledger.hasRun(runId)).resolves.toBe(false);
    await expect(ledger.appendAcceptedEvent(startedEvent())).resolves.toEqual({
      runId,
      eventId: "evt_001",
      sequence: 1,
    });

    await expect(ledger.hasRun(runId)).resolves.toBe(true);
    await expect(ledger.getRunEvent(runId, "evt_001")).resolves.toMatchObject({
      eventId: "evt_001",
      sequence: 1,
    });
    await expect(ledger.verifyRunIntegrity(runId)).resolves.toBeUndefined();
    expect(client.rows).toHaveLength(1);
  });

  it("rejects duplicate event IDs and duplicate sequences before inserting", async () => {
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });
    await ledger.appendAcceptedEvent(startedEvent());

    await expectLedgerError(
      () => ledger.appendAcceptedEvent(startedEvent()),
      "duplicate_event_id",
    );
    await expectLedgerError(
      () =>
        ledger.appendAcceptedEvent(
          proposalEvent({ eventId: "evt_duplicate_sequence", sequence: 1 }),
        ),
      "duplicate_sequence",
    );
    expect(client.rows).toHaveLength(1);
  });

  it("maps same-run concurrent duplicate-sequence races to one success and one deterministic conflict", async () => {
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });
    const left = startedEvent({
      eventId: "evt_same_run_left",
      runId: "run_concurrent_same",
    });
    const right = startedEvent({
      eventId: "evt_same_run_right",
      runId: "run_concurrent_same",
    });

    const results = await Promise.allSettled([
      ledger.appendAcceptedEvent(left),
      ledger.appendAcceptedEvent(right),
    ]);

    expect(results.filter(isFulfilled)).toHaveLength(1);
    const rejection = results.find(isRejected);
    expect(rejection?.reason).toBeInstanceOf(LedgerError);
    expect((rejection?.reason as LedgerError | undefined)?.code).toBe(
      "duplicate_sequence",
    );
    expect(client.rows).toHaveLength(1);
    await expect(ledger.readRunEvents("run_concurrent_same")).resolves.toEqual([
      expect.objectContaining({ sequence: 1 }),
    ]);
  });

  it("allows concurrent appends for different run streams", async () => {
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });
    const firstRun = startedEvent({
      eventId: "evt_first_run",
      runId: "run_concurrent_first",
    });
    const secondRun = startedEvent({
      eventId: "evt_second_run",
      runId: "run_concurrent_second",
    });

    await expect(
      Promise.all([
        ledger.appendAcceptedEvent(firstRun),
        ledger.appendAcceptedEvent(secondRun),
      ]),
    ).resolves.toEqual([
      {
        runId: "run_concurrent_first",
        eventId: "evt_first_run",
        sequence: 1,
      },
      {
        runId: "run_concurrent_second",
        eventId: "evt_second_run",
        sequence: 1,
      },
    ]);
    expect(client.rows.map((row) => row.runId).sort()).toEqual([
      "run_concurrent_first",
      "run_concurrent_second",
    ]);
  });

  it("rejects non-contiguous sequences", async () => {
    const ledger = new PostgresSemanticLedger({
      client: new MockPostgresQueryClient(),
    });
    await ledger.appendAcceptedEvent(startedEvent());

    await expectLedgerError(
      () =>
        ledger.appendAcceptedEvent(
          proposalEvent({ eventId: "evt_003", sequence: 3 }),
        ),
      "non_contiguous_sequence",
    );
  });

  it("rejects payload hash mismatches", async () => {
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });

    await expectLedgerError(
      () =>
        ledger.appendAcceptedEvent({
          ...startedEvent(),
          payloadHash: badHash,
        }),
      "payload_hash_mismatch",
    );
    expect(client.rows).toHaveLength(0);
  });

  it("rejects appending an event to the wrong run stream", async () => {
    const ledger = new PostgresSemanticLedger({
      client: new MockPostgresQueryClient(),
    });

    await expectLedgerError(
      () => ledger.appendAcceptedEventToRun(otherRunId, startedEvent()),
      "run_id_mismatch",
    );
  });

  it("reads accepted streams in deterministic sequence order", async () => {
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });
    await ledger.appendAcceptedEvent(startedEvent());
    await ledger.appendAcceptedEvent(proposalEvent({ sequence: 2 }));
    client.rows.reverse();

    const events = await ledger.readRunEvents(runId);

    expect(events.map((event) => event.eventId)).toEqual([
      "evt_001",
      "evt_002",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("does not expose staged transaction writes before commit", async () => {
    const client = new TransactionalMockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });
    const commitPause = client.pauseNextCommit();
    const append = ledger.appendAcceptedEvent(
      startedEvent({ runId: "run_transaction_visibility" }),
    );
    await commitPause.waitForPendingCommit();

    await expectLedgerError(
      () => ledger.readRunEvents("run_transaction_visibility"),
      "run_not_found",
    );

    commitPause.release();
    await expect(append).resolves.toEqual({
      runId: "run_transaction_visibility",
      eventId: "evt_001",
      sequence: 1,
    });
    await expect(
      ledger.readRunEvents("run_transaction_visibility"),
    ).resolves.toHaveLength(1);
  });

  it("uses per-run transaction advisory locks and locked ordered reads for appends", async () => {
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });

    await ledger.appendAcceptedEvent(startedEvent());
    client.statements.length = 0;
    await ledger.appendAcceptedEvent(proposalEvent({ sequence: 2 }));

    expect(client.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pg_advisory_xact_lock"),
        expect.stringContaining("FOR UPDATE"),
      ]),
    );

    client.statements.length = 0;
    await ledger.readRunEvents(runId);

    expect(client.statements).toEqual(
      expect.not.arrayContaining([expect.stringContaining("FOR UPDATE")]),
    );
  });

  it("validates the append-only run_events migration contract", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS amca_run_events");
    expect(sql).toContain(
      "CONSTRAINT amca_run_events_pkey PRIMARY KEY (run_id, event_id)",
    );
    expect(sql).toContain(
      "CONSTRAINT amca_run_events_sequence_unique UNIQUE (run_id, sequence)",
    );
    expect(sql).toContain(
      "CONSTRAINT amca_run_events_run_id_non_empty CHECK (length(trim(run_id)) > 0)",
    );
    expect(sql).toContain(
      "CONSTRAINT amca_run_events_event_id_non_empty CHECK (length(trim(event_id)) > 0)",
    );
    expect(sql).toContain("CHECK (sequence > 0)");
    expect(sql).toContain("payload_hash ~ '^sha256:[a-f0-9]{64}$'");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON amca_run_events");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION amca_reject_run_event_mutation()",
    );
    expect(sql).toContain("RAISE EXCEPTION");
  });

  it("keeps the migration constrained to accepted AMCA RunEvent types", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    for (const eventType of [
      "RunStarted",
      "ProposalReceived",
      "EffectRequested",
      "WritePreflightRequested",
      "WritePreflightDecided",
      "WriteQuarantined",
      "EffectReceiptRecorded",
      "ExternalStateObserved",
      "ProofGenerated",
      "MismatchDetected",
      "ReleaseDecided",
      "FinalReleased",
    ]) {
      expect(sql).toContain(`'${eventType}'`);
    }

    expect(sql).toContain("CONSTRAINT amca_run_events_type_allowed CHECK");
    expect(sql).not.toContain("'ProjectionSnapshot'");
    expect(sql).not.toContain("'ReplayCompleted'");
  });

  it("rejects projection and non-proof artifacts at the schema contract layer", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      "CONSTRAINT amca_run_events_reject_projection_snapshot CHECK",
    );
    expect(sql).toContain("payload ? 'projection'");
    expect(sql).toContain("payload ? 'projectionSnapshot'");
    expect(sql).toContain("payload ? 'snapshot'");
    expect(sql).toContain("payload ? 'replay'");
    expect(sql).toContain("payload ? 'benchmark'");
    expect(sql).toContain("payload ? 'eval'");
  });

  it("requires replayable object payloads and non-empty optional causation fields", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      "CONSTRAINT amca_run_events_payload_object CHECK (jsonb_typeof(payload) = 'object')",
    );
    expect(sql).toContain(
      "CONSTRAINT amca_run_events_causation_id_non_empty CHECK",
    );
    expect(sql).toContain(
      "causation_id IS NULL OR length(trim(causation_id)) > 0",
    );
    expect(sql).toContain(
      "CONSTRAINT amca_run_events_correlation_id_non_empty CHECK",
    );
    expect(sql).toContain(
      "correlation_id IS NULL OR length(trim(correlation_id)) > 0",
    );
  });

  it("exports no update or delete helper for accepted history", async () => {
    const moduleExports = await import("./index.js");
    const exportedMutationHelpers = Object.keys(moduleExports).filter((name) =>
      /update|delete/iu.test(name),
    );
    const prototypeMutationHelpers = Object.getOwnPropertyNames(
      PostgresSemanticLedger.prototype,
    ).filter((name) => /update|delete/iu.test(name));

    expect(exportedMutationHelpers).toEqual([]);
    expect(prototypeMutationHelpers).toEqual([]);
  });
});

interface StoredRow {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly causationId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
}

class MockPostgresQueryClient implements PostgresQueryClient {
  readonly rows: StoredRow[] = [];
  readonly statements: string[] = [];

  async query<TRow = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<TRow>> {
    await Promise.resolve();
    this.statements.push(text);
    const normalized = text.trim();

    if (
      normalized === "BEGIN" ||
      normalized === "COMMIT" ||
      normalized === "ROLLBACK"
    ) {
      return result([]);
    }

    if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
      return result([]);
    }

    if (normalized.startsWith('SELECT true AS "exists"')) {
      const targetRunId = requireString(values[0], "runId");
      return result(
        this.rows.some((row) => row.runId === targetRunId)
          ? [{ exists: true }]
          : [],
      );
    }

    if (
      normalized.startsWith("SELECT") &&
      normalized.includes("FROM amca_run_events") &&
      normalized.includes("ORDER BY sequence ASC")
    ) {
      const targetRunId = requireString(values[0], "runId");
      return result(
        [...this.rows]
          .filter((row) => row.runId === targetRunId)
          .sort((left, right) => left.sequence - right.sequence)
          .map(cloneStoredRow),
      );
    }

    if (normalized.startsWith("INSERT INTO amca_run_events")) {
      const row = rowFromInsertValues(values);
      if (
        this.rows.some(
          (candidate) =>
            candidate.runId === row.runId && candidate.eventId === row.eventId,
        )
      ) {
        throw postgresConstraintError("23505", "amca_run_events_pkey");
      }
      if (
        this.rows.some(
          (candidate) =>
            candidate.runId === row.runId &&
            candidate.sequence === row.sequence,
        )
      ) {
        throw postgresConstraintError(
          "23505",
          "amca_run_events_sequence_unique",
        );
      }

      this.rows.push(row);
      return result([]);
    }

    throw new Error(`Unexpected SQL in mock Postgres client: ${normalized}`);
  }
}

class TransactionalMockPostgresQueryClient implements PostgresQueryClient {
  readonly rows: StoredRow[] = [];
  readonly statements: string[] = [];
  #pendingRows: StoredRow[] = [];
  #commitPause: CommitPause | undefined;

  pauseNextCommit(): CommitPause {
    const pause = new CommitPause();
    this.#commitPause = pause;
    return pause;
  }

  async query<TRow = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<TRow>> {
    await Promise.resolve();
    this.statements.push(text);
    const normalized = text.trim();

    if (normalized === "BEGIN") {
      this.#pendingRows = [];
      return result([]);
    }

    if (normalized === "ROLLBACK") {
      this.#pendingRows = [];
      return result([]);
    }

    if (normalized === "COMMIT") {
      const pause = this.#commitPause;
      this.#commitPause = undefined;
      if (pause !== undefined) {
        pause.markPending();
        await pause.waitForRelease();
      }

      this.rows.push(...this.#pendingRows);
      this.#pendingRows = [];
      return result([]);
    }

    if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
      return result([]);
    }

    if (normalized.startsWith('SELECT true AS "exists"')) {
      const targetRunId = requireString(values[0], "runId");
      return result(
        this.rows.some((row) => row.runId === targetRunId)
          ? [{ exists: true }]
          : [],
      );
    }

    if (
      normalized.startsWith("SELECT") &&
      normalized.includes("FROM amca_run_events") &&
      normalized.includes("ORDER BY sequence ASC")
    ) {
      const targetRunId = requireString(values[0], "runId");
      return result(
        [...this.rows]
          .filter((row) => row.runId === targetRunId)
          .sort((left, right) => left.sequence - right.sequence)
          .map(cloneStoredRow),
      );
    }

    if (normalized.startsWith("INSERT INTO amca_run_events")) {
      const row = rowFromInsertValues(values);
      const visibleRows = [...this.rows, ...this.#pendingRows];
      if (
        visibleRows.some(
          (candidate) =>
            candidate.runId === row.runId && candidate.eventId === row.eventId,
        )
      ) {
        throw postgresConstraintError("23505", "amca_run_events_pkey");
      }
      if (
        visibleRows.some(
          (candidate) =>
            candidate.runId === row.runId &&
            candidate.sequence === row.sequence,
        )
      ) {
        throw postgresConstraintError(
          "23505",
          "amca_run_events_sequence_unique",
        );
      }

      this.#pendingRows.push(row);
      return result([]);
    }

    throw new Error(
      `Unexpected SQL in transactional mock Postgres client: ${normalized}`,
    );
  }
}

class CommitPause {
  #pendingResolver: (() => void) | undefined;
  #releaseResolver: (() => void) | undefined;
  readonly #pending = new Promise<void>((resolve) => {
    this.#pendingResolver = resolve;
  });
  readonly #released = new Promise<void>((resolve) => {
    this.#releaseResolver = resolve;
  });

  markPending(): void {
    this.#pendingResolver?.();
  }

  waitForPendingCommit(): Promise<void> {
    return this.#pending;
  }

  release(): void {
    this.#releaseResolver?.();
  }

  waitForRelease(): Promise<void> {
    return this.#released;
  }
}

interface StartedEventOptions {
  readonly eventId?: string;
  readonly runId?: string;
  readonly sequence?: number;
}

function startedEvent(
  options: StartedEventOptions = {},
): RunEvent<"RunStarted"> {
  const targetRunId = options.runId ?? runId;
  const payload = { runId: targetRunId, profile: "standard" };
  return {
    eventId: options.eventId ?? "evt_001",
    runId: targetRunId,
    sequence: options.sequence ?? 1,
    type: "RunStarted",
    payload,
    payloadHash: hashRunEventPayload(payload),
    causationId: null,
    correlationId: null,
    occurredAt,
  };
}

interface ProposalEventOptions {
  readonly eventId?: string;
  readonly runId?: string;
  readonly sequence: number;
  readonly causationId?: string;
}

function proposalEvent(
  options: ProposalEventOptions,
): RunEvent<"ProposalReceived"> {
  const targetRunId = options.runId ?? runId;
  const payload = {
    proposal: {
      kind: "tool_command_request" as const,
      commandId: "command_test_001",
      runId: targetRunId,
      capabilityId: "shell.run_tests",
      toolId: "pnpm.test",
      args: {
        command: "pnpm test",
      },
      sideEffectClass: "compute" as const,
    },
  };
  return {
    eventId: options.eventId ?? "evt_002",
    runId: targetRunId,
    sequence: options.sequence,
    type: "ProposalReceived",
    payload,
    payloadHash: hashRunEventPayload(payload),
    causationId: options.causationId ?? "evt_001",
    correlationId: "corr_phase_28",
    occurredAt,
  };
}

function isFulfilled<T>(
  result: PromiseSettledResult<T>,
): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled";
}

function isRejected<T>(
  result: PromiseSettledResult<T>,
): result is PromiseRejectedResult {
  return result.status === "rejected";
}

async function expectLedgerError(
  operation: () => Promise<unknown>,
  code: LedgerError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    return;
  }

  throw new Error(`Expected LedgerError with code ${code}.`);
}

function rowFromInsertValues(values: readonly unknown[]): StoredRow {
  return {
    eventId: requireString(values[0], "eventId"),
    runId: requireString(values[1], "runId"),
    sequence: requireNumber(values[2], "sequence"),
    type: requireString(values[3], "type"),
    payload: JSON.parse(requireString(values[4], "payload")) as unknown,
    payloadHash: requireString(values[5], "payloadHash"),
    causationId: requireNullOrString(values[6], "causationId"),
    correlationId: requireNullOrString(values[7], "correlationId"),
    occurredAt: requireString(values[8], "occurredAt"),
  };
}

function cloneStoredRow(row: StoredRow): StoredRow {
  return {
    ...row,
    payload: JSON.parse(JSON.stringify(row.payload)) as unknown,
  };
}

function result<TRow>(rows: readonly unknown[]): PostgresQueryResult<TRow> {
  return { rows: rows as readonly TRow[] };
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${fieldName} to be a string.`);
  }

  return value;
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected ${fieldName} to be a number.`);
  }

  return value;
}

function requireNullOrString(value: unknown, fieldName: string): string | null {
  if (value === null || typeof value === "string") {
    return value;
  }

  throw new Error(`Expected ${fieldName} to be a string or null.`);
}

function postgresConstraintError(code: string, constraint: string): Error {
  const error = new Error(`Postgres constraint ${constraint} failed.`);
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    constraint: { value: constraint, enumerable: true },
  });
  return error;
}
