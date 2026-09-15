import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { redactValue } from "./guardrails.js";

export interface LogEvent {
  ts: string;
  runId: string;
  kind: string; // "observe" | "decide" | "act" | "checkpoint" | "outcome" | "escalation" | "error" | ...
  [key: string]: unknown;
}

/** Append-only, redacted, structured JSONL logger for one run (discovery or replay). */
export class RunLogger {
  private filePath: string;
  private runId: string;

  private constructor(filePath: string, runId: string) {
    this.filePath = filePath;
    this.runId = runId;
  }

  static async create(dir: string, runId: string): Promise<RunLogger> {
    await mkdir(dir, { recursive: true });
    return new RunLogger(path.join(dir, "log.jsonl"), runId);
  }

  async log(kind: string, data: Record<string, unknown> = {}): Promise<void> {
    const event: LogEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      kind,
      ...(redactValue(data) as Record<string, unknown>),
    };
    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
    // Also echo a terse line to stdout so a human watching the run sees progress.
    const gist = data.description ?? data.message ?? data.reason ?? data.url ?? "";
    console.log(`[${kind}] ${gist}`);
  }
}
