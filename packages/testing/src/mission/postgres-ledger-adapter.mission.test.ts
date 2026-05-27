import {
  PostgresSemanticLedger,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "@amca/ledger-postgres";
import { hashRunEventPayload } from "@amca/kernel";
import { rebuildRunProjection } from "@amca/projections";
import type { RunEvent } from "@amca/protocol";
import { replayRunEvents } from "@amca/replay";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  GENERATED_AT,
  candidateWith,
  startedKernel,
  submitReleasedTestClaim,
  testResultClaim,
} from "./mission-helpers.js";

const liveDatabaseUrl = process.env.AMCA_LEDGER_POSTGRES_TEST_URL;
const describeLive =
  liveDatabaseUrl === undefined || liveDatabaseUrl.trim().length === 0
    ? describe.skip
    : describe;
const migrationUrl = new URL(
  "../../../ledger-postgres/migrations/0001_run_events.sql",
  import.meta.url,
);
const liveSchemasToDrop = new Set<string>();

describe("Mission Postgres semantic ledger adapter litmus", () => {
  it("returns accepted semantic events for projection and replay without owning their authority", async () => {
    const runId = "mission_postgres_ledger_projection_replay";
    const { kernel } = submitReleasedTestClaim(runId);
    const ledger = new PostgresSemanticLedger({
      client: new MockPostgresQueryClient(),
    });

    for (const event of kernel.events()) {
      await ledger.appendAcceptedEvent(event);
    }

    const eventsFromLedger = await ledger.readRunEvents(runId);
    const projection = rebuildRunProjection(eventsFromLedger);
    const replay = replayRunEvents({ events: eventsFromLedger });

    expect(projection.summary.status).toBe("released");
    expect(projection.finalReleased).toBe(true);
    expect(replay).toMatchObject({
      status: "passed",
      runId,
      storedDecision: { status: "released" },
    });
  });

  it("does not accept projection snapshots as semantic ledger truth", async () => {
    const runId = "mission_postgres_projection_not_truth";
    const { kernel } = submitReleasedTestClaim(runId);
    const ledger = new PostgresSemanticLedger({
      client: new MockPostgresQueryClient(),
    });
    const projection = rebuildRunProjection(kernel.events());

    await expect(
      ledger.appendAcceptedEvent(projection as unknown as RunEvent),
    ).rejects.toThrow();
  });

  it("fails closed when Postgres-returned event rows are tampered", async () => {
    const runId = "mission_postgres_tamper_closed";
    const { kernel } = submitReleasedTestClaim(runId);
    const client = new MockPostgresQueryClient();
    const ledger = new PostgresSemanticLedger({ client });

    for (const event of kernel.events()) {
      await ledger.appendAcceptedEvent(event);
    }

    client.replacePayloadAt(runId, 2, { forged: true });

    await expect(ledger.readRunEvents(runId)).rejects.toThrow();
  });
});

describeLive("Mission Postgres semantic ledger live parity litmus", () => {
  afterEach(async () => {
    await dropLiveSchemas();
  });

  it("kernel accepted released run persists through Postgres and replays as released", async () => {
    await withLiveMigratedSchema(async ({ ledger }) => {
      const runId = "mission_live_postgres_kernel_released";
      const { kernel } = submitReleasedTestClaim(runId);

      await appendAcceptedEvents(ledger, kernel.events());

      const eventsFromPostgres = await ledger.readRunEvents(runId);
      const replay = replayRunEvents({ events: eventsFromPostgres });

      expect(eventsFromPostgres).toEqual(kernel.events());
      expect(replay).toMatchObject({
        status: "passed",
        runId,
        replayedDecision: { status: "released" },
        storedDecision: { status: "released" },
      });
    });
  });

  it("kernel accepted blocked run persists through Postgres and replays as blocked", async () => {
    await withLiveMigratedSchema(async ({ ledger }) => {
      const runId = "mission_live_postgres_kernel_blocked";
      const kernel = startedKernel(runId);
      const claim = testResultClaim({
        evidenceRefs: [],
        testSuiteId: "unit",
      });
      const result = kernel.submitFinalCandidate(candidateWith(runId, claim), {
        occurredAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
      });

      await appendAcceptedEvents(ledger, kernel.events());

      const eventsFromPostgres = await ledger.readRunEvents(runId);
      const replay = replayRunEvents({ events: eventsFromPostgres });

      expect(result.decision.status).toBe("blocked");
      expect(eventsFromPostgres).toEqual(kernel.events());
      expect(replay).toMatchObject({
        status: "passed",
        runId,
        replayedDecision: { status: "blocked" },
        storedDecision: { status: "blocked" },
      });
    });
  });

  it("tampered Postgres-read events cannot be replayed as accepted release evidence", async () => {
    await withLiveMigratedSchema(async ({ ledger }) => {
      const runId = "mission_live_postgres_tampered_replay";
      const { kernel } = submitReleasedTestClaim(runId);
      await appendAcceptedEvents(ledger, kernel.events());

      const eventsFromPostgres = await ledger.readRunEvents(runId);
      const tamperedEvents = eventsFromPostgres.map((event): RunEvent => {
        if (event.type !== "ReleaseDecided") {
          return event;
        }

        return {
          ...event,
          payload: {
            decision: {
              status: "blocked",
              runId,
              proofId: "proof_tampered",
              approvedClaimIds: [],
              blockingMismatchIds: ["mismatch_tampered"],
            },
          },
        };
      });

      const replay = replayRunEvents({ events: tamperedEvents });

      expect(replay).toMatchObject({
        status: "failed",
        code: "event_stream_integrity_failed",
      });
      expect(replay.notes.join("\n")).toContain("payloadHash");
    });
  });

  it("Postgres read events feed replay but do not become proof authority by themselves", async () => {
    await withLiveMigratedSchema(async ({ ledger }) => {
      const runId = "mission_live_postgres_not_proof_authority";
      const events = releaseDecisionWithoutProofEvents(runId);

      await appendAcceptedEvents(ledger, events);

      const eventsFromPostgres = await ledger.readRunEvents(runId);
      const replay = replayRunEvents({ events: eventsFromPostgres });

      expect(eventsFromPostgres).toHaveLength(2);
      expect(replay).toMatchObject({
        status: "failed",
        code: "final_candidate_missing",
      });
    });
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
  readonly #rows: StoredRow[] = [];

  async query<TRow = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<TRow>> {
    await Promise.resolve();
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
        this.#rows.some((row) => row.runId === targetRunId)
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
        [...this.#rows]
          .filter((row) => row.runId === targetRunId)
          .sort((left, right) => left.sequence - right.sequence)
          .map(cloneStoredRow),
      );
    }

    if (normalized.startsWith("INSERT INTO amca_run_events")) {
      this.#rows.push(rowFromInsertValues(values));
      return result([]);
    }

    throw new Error(`Unexpected SQL in mock Postgres client: ${normalized}`);
  }

  replacePayloadAt(runId: string, sequence: number, payload: unknown): void {
    const index = this.#rows.findIndex(
      (row) => row.runId === runId && row.sequence === sequence,
    );
    if (index < 0) {
      throw new Error(
        `Expected mock Postgres row for ${runId} sequence ${String(sequence)}.`,
      );
    }

    const row = this.#rows[index];
    if (row === undefined) {
      throw new Error("Expected mock Postgres row.");
    }

    this.#rows[index] = {
      ...row,
      payload,
    };
  }
}

interface LiveMigratedSchemaContext {
  readonly client: Client;
  readonly ledger: PostgresSemanticLedger;
  readonly schema: string;
}

async function withLiveMigratedSchema(
  test: (context: LiveMigratedSchemaContext) => Promise<void>,
): Promise<void> {
  const schema = nextLiveSchemaName();
  await createLiveSchema(schema);
  const client = await connectToLiveSchema(schema);
  try {
    await client.query(await readFile(migrationUrl, "utf8"));
    await test({
      client,
      ledger: new PostgresSemanticLedger({ client }),
      schema,
    });
  } finally {
    await client.end();
  }
}

async function createLiveSchema(schema: string): Promise<void> {
  const client = await connectLive();
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    liveSchemasToDrop.add(schema);
  } finally {
    await client.end();
  }
}

async function dropLiveSchemas(): Promise<void> {
  for (const schema of [...liveSchemasToDrop]) {
    const client = await connectLive();
    try {
      await client.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
      );
      liveSchemasToDrop.delete(schema);
    } finally {
      await client.end();
    }
  }
}

async function connectToLiveSchema(schema: string): Promise<Client> {
  const client = await connectLive();
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
  return client;
}

async function connectLive(): Promise<Client> {
  if (liveDatabaseUrl === undefined || liveDatabaseUrl.trim().length === 0) {
    throw new Error(
      "AMCA_LEDGER_POSTGRES_TEST_URL is required for live tests.",
    );
  }

  const client = new Client({
    application_name: "amca_phase32_live_parity_tests",
    connectionString: liveDatabaseUrl,
  });
  await client.connect();
  return client;
}

async function appendAcceptedEvents(
  ledger: PostgresSemanticLedger,
  events: readonly RunEvent[],
): Promise<void> {
  for (const event of events) {
    await ledger.appendAcceptedEvent(event);
  }
}

function releaseDecisionWithoutProofEvents(runId: string): readonly RunEvent[] {
  const startedPayload = { runId, profile: "standard" };
  const startedEvent: RunEvent<"RunStarted"> = {
    eventId: `evt_${runId}_started`,
    runId,
    sequence: 1,
    type: "RunStarted",
    payload: startedPayload,
    payloadHash: hashRunEventPayload(startedPayload),
    causationId: null,
    correlationId: null,
    occurredAt: GENERATED_AT,
  };
  const releasePayload: RunEvent<"ReleaseDecided">["payload"] = {
    decision: {
      status: "released",
      runId,
      proofId: "proof_without_proof_event",
      approvedClaimIds: ["claim_without_proof"],
      blockingMismatchIds: [],
      finalMessage: "This release decision row is not proof authority.",
    },
  };
  const releaseEvent: RunEvent<"ReleaseDecided"> = {
    eventId: `evt_${runId}_release_without_proof`,
    runId,
    sequence: 2,
    type: "ReleaseDecided",
    payload: releasePayload,
    payloadHash: hashRunEventPayload(releasePayload),
    causationId: startedEvent.eventId,
    correlationId: null,
    occurredAt: GENERATED_AT,
  };

  return [startedEvent, releaseEvent];
}

let liveSchemaCounter = 0;

function nextLiveSchemaName(): string {
  liveSchemaCounter += 1;
  return `amca_phase32_${String(process.pid)}_${String(
    Date.now(),
  )}_${String(liveSchemaCounter)}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
