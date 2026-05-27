import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseRunEvent } from "@amca/contracts";
import {
  InMemorySemanticLedger,
  LedgerError,
  type AppendRunEventResult,
  type SemanticLedger,
  validateOrderedRunEvents,
} from "@amca/ledger";
import type { RunEvent } from "@amca/protocol";

export interface LocalJsonlSemanticLedgerOptions {
  readonly rootDir: string;
}

export class LocalJsonlSemanticLedger implements SemanticLedger {
  readonly rootDir: string;

  constructor(options: LocalJsonlSemanticLedgerOptions) {
    if (options.rootDir.trim().length === 0) {
      throw new LedgerError(
        "integrity_violation",
        "Local ledger rootDir must be a non-empty path.",
      );
    }

    this.rootDir = options.rootDir;
  }

  async appendAcceptedEvent(event: RunEvent): Promise<AppendRunEventResult> {
    return this.appendAcceptedEventToRun(event.runId, event);
  }

  async appendAcceptedEventToRun(
    runId: string,
    event: RunEvent,
  ): Promise<AppendRunEventResult> {
    const existingEvents = await this.readRunEventsOrEmpty(runId);
    const validator = new InMemorySemanticLedger({
      initialEvents: existingEvents,
    });
    const result = await validator.appendAcceptedEventToRun(runId, event);

    await mkdir(this.runDir(runId), { recursive: true });
    await appendFile(
      localRunEventsPath(this.rootDir, runId),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );

    return result;
  }

  async readRunEvents(runId: string): Promise<RunEvent[]> {
    const content = await this.readEventsContent(runId);
    const events = parseEventsJsonl(content, runId);
    return validateOrderedRunEvents(events, runId);
  }

  async getRunEvent(runId: string, eventId: string): Promise<RunEvent> {
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
    try {
      await this.readRunEvents(runId);
      return true;
    } catch (error) {
      if (error instanceof LedgerError && error.code === "run_not_found") {
        return false;
      }

      throw error;
    }
  }

  async verifyRunIntegrity(runId: string): Promise<void> {
    await this.readRunEvents(runId);
  }

  private async readRunEventsOrEmpty(runId: string): Promise<RunEvent[]> {
    try {
      return await this.readRunEvents(runId);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "run_not_found") {
        return [];
      }

      throw error;
    }
  }

  private async readEventsContent(runId: string): Promise<string> {
    try {
      return await readFile(localRunEventsPath(this.rootDir, runId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new LedgerError(
          "run_not_found",
          `Run ${runId} does not exist in local ledger ${this.rootDir}.`,
        );
      }

      throw error;
    }
  }

  private runDir(runId: string): string {
    return path.join(this.rootDir, runId);
  }
}

export function localRunEventsPath(rootDir: string, runId: string): string {
  return path.join(rootDir, runId, "events.jsonl");
}

function parseEventsJsonl(content: string, runId: string): RunEvent[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new LedgerError(
      "integrity_violation",
      `Run ${runId} events.jsonl must contain at least one event.`,
    );
  }

  return lines.map((line, index) => {
    try {
      return parseRunEvent(JSON.parse(line));
    } catch (error) {
      throw new LedgerError(
        "tamper_detected",
        `Run ${runId} events.jsonl line ${String(
          index + 1,
        )} is not a valid RunEvent: ${formatError(error)}`,
      );
    }
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
