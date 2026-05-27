import { readFile } from "node:fs/promises";

import { LedgerError, hashRunEventPayload } from "@amca/ledger";
import type { JsonObject, RunEvent } from "@amca/protocol";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { PostgresSemanticLedger } from "./index.js";

const liveDatabaseUrl = process.env.AMCA_LEDGER_POSTGRES_TEST_URL;
const describeLive =
  liveDatabaseUrl === undefined || liveDatabaseUrl.trim().length === 0
    ? describe.skip
    : describe;
const migrationUrl = new URL(
  "../migrations/0001_run_events.sql",
  import.meta.url,
);
const occurredAt = "2026-05-25T12:00:00.000Z";
const schemasToDrop = new Set<string>();

describeLive("PostgresSemanticLedger live integration", () => {
  afterEach(async () => {
    await dropCreatedSchemas();
  });

  it("migration-from-scratch-real-postgres", async () => {
    await withMigratedSchema(async ({ client }) => {
      const table = await client.query<{ exists: string | null }>(
        "SELECT to_regclass('amca_run_events')::text AS exists",
      );
      expect(table.rows[0]?.exists).toBe("amca_run_events");

      const constraints = await client.query<{ conname: string }>(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'amca_run_events'::regclass
        ORDER BY conname`);
      expect(constraints.rows.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          "amca_run_events_pkey",
          "amca_run_events_sequence_unique",
          "amca_run_events_payload_hash_sha256",
          "amca_run_events_reject_projection_snapshot",
        ]),
      );

      const triggers = await client.query<{ tgname: string }>(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = 'amca_run_events'::regclass
          AND NOT tgisinternal
        ORDER BY tgname`);
      expect(triggers.rows.map((row) => row.tgname)).toContain(
        "amca_run_events_append_only",
      );
    });
  });

  it("append-only-update-delete-real-postgres", async () => {
    await withMigratedSchema(async ({ client, ledger }) => {
      await ledger.appendAcceptedEvent(startedEvent("live_append_only"));

      await expect(
        client.query("UPDATE amca_run_events SET type = type"),
      ).rejects.toThrow(/append-only|not permitted/iu);
      await expect(client.query("DELETE FROM amca_run_events")).rejects.toThrow(
        /append-only|not permitted/iu,
      );

      await expect(
        ledger.readRunEvents("live_append_only"),
      ).resolves.toHaveLength(1);
    });
  });

  it("duplicate-event-id-real-postgres", async () => {
    await withMigratedSchema(async ({ client }) => {
      const event = startedEvent("live_duplicate_event_id");
      await insertRawEvent(client, event);

      await expect(insertRawEvent(client, event)).rejects.toMatchObject({
        code: "23505",
        constraint: "amca_run_events_pkey",
      });
    });
  });

  it("duplicate-run-sequence-real-postgres", async () => {
    await withMigratedSchema(async ({ client }) => {
      const first = startedEvent("live_duplicate_sequence", {
        eventId: "evt_duplicate_sequence_left",
      });
      const second = startedEvent("live_duplicate_sequence", {
        eventId: "evt_duplicate_sequence_right",
      });
      await insertRawEvent(client, first);

      await expect(insertRawEvent(client, second)).rejects.toMatchObject({
        code: "23505",
        constraint: "amca_run_events_sequence_unique",
      });
    });
  });

  it("transaction-rollback-no-partial-event-real-postgres", async () => {
    await withMigratedSchema(async ({ client, ledger }) => {
      await client.query("BEGIN");
      await insertRawEvent(client, startedEvent("live_rollback"));
      await client.query("ROLLBACK");

      await expectLedgerError(
        () => ledger.readRunEvents("live_rollback"),
        "run_not_found",
      );
    });
  });

  it("payload-hash-tamper-rejected-real-postgres", async () => {
    await withMigratedSchema(async ({ client, ledger }) => {
      await ledger.appendAcceptedEvent(startedEvent("live_tamper"));
      await client.query(
        "ALTER TABLE amca_run_events DISABLE TRIGGER amca_run_events_append_only",
      );
      await client.query(
        "UPDATE amca_run_events SET payload = $1::jsonb WHERE run_id = $2",
        [JSON.stringify({ runId: "live_tamper", forged: true }), "live_tamper"],
      );
      await client.query(
        "ALTER TABLE amca_run_events ENABLE TRIGGER amca_run_events_append_only",
      );

      await expectLedgerError(
        () => ledger.readRunEvents("live_tamper"),
        "tamper_detected",
      );
    });
  });

  it("projection-snapshot-rejected-real-postgres", async () => {
    await withMigratedSchema(async ({ client }) => {
      const payload = { projection: { status: "released" } };
      const projectionEvent = rawEvent("live_projection_snapshot", {
        payload,
        payloadHash: hashRunEventPayload(payload),
      });

      await expect(
        insertRawEvent(client, projectionEvent),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "amca_run_events_reject_projection_snapshot",
      });
    });
  });

  it("connection-failure-does-not-synthesize-event-real-postgres", async () => {
    await withMigratedSchema(async ({ client, schema }) => {
      const failedClient = await connectToSchema(schema);
      const failedLedger = new PostgresSemanticLedger({
        client: failedClient,
      });
      await failedClient.end();

      await expect(
        failedLedger.appendAcceptedEvent(startedEvent("live_connection_loss")),
      ).rejects.toThrow();

      const healthyLedger = new PostgresSemanticLedger({ client });
      await expectLedgerError(
        () => healthyLedger.readRunEvents("live_connection_loss"),
        "run_not_found",
      );
    });
  });

  it("concurrent-append-same-run-sequence-race-real-postgres", async () => {
    await withMigratedSchema(async ({ client, schema }) => {
      const leftClient = await connectToSchema(schema);
      const rightClient = await connectToSchema(schema);
      try {
        const leftLedger = new PostgresSemanticLedger({ client: leftClient });
        const rightLedger = new PostgresSemanticLedger({ client: rightClient });
        const results = await Promise.allSettled([
          leftLedger.appendAcceptedEvent(
            startedEvent("live_concurrent_same", {
              eventId: "evt_live_concurrent_left",
            }),
          ),
          rightLedger.appendAcceptedEvent(
            startedEvent("live_concurrent_same", {
              eventId: "evt_live_concurrent_right",
            }),
          ),
        ]);

        expect(results.filter(isFulfilled)).toHaveLength(1);
        const rejection = results.find(isRejected);
        expect(rejection?.reason).toBeInstanceOf(LedgerError);
        expect((rejection?.reason as LedgerError | undefined)?.code).toBe(
          "duplicate_sequence",
        );
        await expect(
          new PostgresSemanticLedger({ client }).readRunEvents(
            "live_concurrent_same",
          ),
        ).resolves.toHaveLength(1);
      } finally {
        await leftClient.end();
        await rightClient.end();
      }
    });
  });

  it("concurrent-append-different-runs-allowed-real-postgres", async () => {
    await withMigratedSchema(async ({ client, schema }) => {
      const leftClient = await connectToSchema(schema);
      const rightClient = await connectToSchema(schema);
      try {
        const leftLedger = new PostgresSemanticLedger({ client: leftClient });
        const rightLedger = new PostgresSemanticLedger({ client: rightClient });

        await expect(
          Promise.all([
            leftLedger.appendAcceptedEvent(startedEvent("live_run_left")),
            rightLedger.appendAcceptedEvent(startedEvent("live_run_right")),
          ]),
        ).resolves.toHaveLength(2);

        const ledger = new PostgresSemanticLedger({ client });
        await expect(
          ledger.readRunEvents("live_run_left"),
        ).resolves.toHaveLength(1);
        await expect(
          ledger.readRunEvents("live_run_right"),
        ).resolves.toHaveLength(1);
      } finally {
        await leftClient.end();
        await rightClient.end();
      }
    });
  });

  it("read-after-write-consistency-real-postgres", async () => {
    await withMigratedSchema(async ({ ledger }) => {
      await ledger.appendAcceptedEvent(startedEvent("live_read_after_write"));

      await expect(
        ledger.getRunEvent("live_read_after_write", "evt_001"),
      ).resolves.toMatchObject({
        runId: "live_read_after_write",
        eventId: "evt_001",
        sequence: 1,
      });
      await expect(
        ledger.readRunEvents("live_read_after_write"),
      ).resolves.toHaveLength(1);
    });
  });
});

interface MigratedSchemaContext {
  readonly schema: string;
  readonly client: Client;
  readonly ledger: PostgresSemanticLedger;
}

async function withMigratedSchema(
  test: (context: MigratedSchemaContext) => Promise<void>,
): Promise<void> {
  const schema = nextSchemaName();
  await createSchema(schema);
  const client = await connectToSchema(schema);
  try {
    await client.query(await readFile(migrationUrl, "utf8"));
    await test({
      schema,
      client,
      ledger: new PostgresSemanticLedger({ client }),
    });
  } finally {
    await client.end();
  }
}

async function createSchema(schema: string): Promise<void> {
  const client = await connect();
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemasToDrop.add(schema);
  } finally {
    await client.end();
  }
}

async function dropCreatedSchemas(): Promise<void> {
  for (const schema of [...schemasToDrop]) {
    const client = await connect();
    try {
      await client.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
      );
      schemasToDrop.delete(schema);
    } finally {
      await client.end();
    }
  }
}

async function connectToSchema(schema: string): Promise<Client> {
  const client = await connect();
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
  return client;
}

async function connect(): Promise<Client> {
  if (liveDatabaseUrl === undefined || liveDatabaseUrl.trim().length === 0) {
    throw new Error(
      "AMCA_LEDGER_POSTGRES_TEST_URL is required for live tests.",
    );
  }

  const client = new Client({
    application_name: "amca_phase31_live_ledger_tests",
    connectionString: liveDatabaseUrl,
  });
  await client.connect();
  return client;
}

function rawEvent(
  runId: string,
  options: {
    readonly eventId?: string;
    readonly sequence?: number;
    readonly payload?: JsonObject;
    readonly payloadHash?: RunEvent["payloadHash"];
  } = {},
): RunEvent<"RunStarted", JsonObject> {
  const payload = options.payload ?? { runId, profile: "standard" };
  return {
    eventId: options.eventId ?? "evt_001",
    runId,
    sequence: options.sequence ?? 1,
    type: "RunStarted",
    payload,
    payloadHash: options.payloadHash ?? hashRunEventPayload(payload),
    causationId: null,
    correlationId: null,
    occurredAt,
  };
}

function startedEvent(
  runId: string,
  options: {
    readonly eventId?: string;
    readonly sequence?: number;
  } = {},
): RunEvent<"RunStarted"> {
  const payload = { runId, profile: "standard" };
  return {
    eventId: options.eventId ?? "evt_001",
    runId,
    sequence: options.sequence ?? 1,
    type: "RunStarted",
    payload,
    payloadHash: hashRunEventPayload(payload),
    causationId: null,
    correlationId: null,
    occurredAt,
  };
}

interface InsertableRunEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: JsonObject | RunEvent["payload"];
  readonly payloadHash: RunEvent["payloadHash"];
  readonly causationId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
}

async function insertRawEvent(
  client: Client,
  event: InsertableRunEvent,
): Promise<void> {
  await client.query(
    `
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
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      event.eventId,
      event.runId,
      event.sequence,
      event.type,
      JSON.stringify(event.payload),
      event.payloadHash,
      event.causationId,
      event.correlationId,
      event.occurredAt,
    ],
  );
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

let schemaCounter = 0;

function nextSchemaName(): string {
  schemaCounter += 1;
  return `amca_phase31_${String(process.pid)}_${String(Date.now())}_${String(
    schemaCounter,
  )}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
