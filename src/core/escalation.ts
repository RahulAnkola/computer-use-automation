import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * File-backed intervention queue. This is the seam between the automated
 * run and a human operator: the automation process keeps the live
 * Playwright session open (browser stays running, page stays where it was)
 * and blocks on `waitForResolution`; a *separate* process (the operator CLI,
 * `npm run operator`) reads/writes the same files to see pending requests
 * and record what the human did.
 *
 * Why files instead of an in-process queue: the whole point of escalation is
 * that a *different* actor (a person, in a different terminal / at the
 * keyboard) needs to see and resolve the request. A durable, inspectable
 * queue on disk is the simplest thing that makes that real rather than
 * simulated in-memory.
 */

export type InterventionStatus = "pending" | "resolved";

export interface InterventionRequest {
  id: string;
  status: InterventionStatus;
  runId: string;
  capability: string;
  goal: string;
  currentStepId?: string;
  currentUrl: string;
  reason: string;
  screenshotPath?: string;
  createdAt: string;
  /** Monotonic per-process counter, used to order interventions raised
   *  within the same millisecond -- ISO timestamp string comparison alone
   *  isn't a reliable sort key at that resolution. */
  seq: number;
  resolution?: {
    resolvedAt: string;
    operator: string;
    action: string; // free-text: what the human did in the live session
    outcome: "resumed" | "aborted";
  };
}

const DIR = path.resolve(process.cwd(), ".escalations");

async function ensureDir(): Promise<void> {
  await mkdir(DIR, { recursive: true });
}

function filePath(id: string): string {
  return path.join(DIR, `${id}.json`);
}

let seqCounter = 0;

export async function raiseIntervention(
  input: Omit<InterventionRequest, "id" | "status" | "createdAt" | "seq">
): Promise<InterventionRequest> {
  await ensureDir();
  const record: InterventionRequest = {
    ...input,
    id: randomUUID().slice(0, 8),
    status: "pending",
    createdAt: new Date().toISOString(),
    seq: seqCounter++,
  };
  await writeFile(filePath(record.id), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function readIntervention(id: string): Promise<InterventionRequest> {
  const raw = await readFile(filePath(id), "utf8");
  return JSON.parse(raw);
}

export async function listInterventions(): Promise<InterventionRequest[]> {
  await ensureDir();
  const files = await readdir(DIR);
  const records = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map((f) => readFile(path.join(DIR, f), "utf8").then((r) => JSON.parse(r)))
  );
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
}

export async function resolveIntervention(
  id: string,
  resolution: InterventionRequest["resolution"]
): Promise<InterventionRequest> {
  const record = await readIntervention(id);
  record.status = "resolved";
  record.resolution = resolution;
  await writeFile(filePath(id), JSON.stringify(record, null, 2), "utf8");
  return record;
}

/** Block (polling) until the given intervention is resolved by an operator, or timeout. */
export async function waitForResolution(id: string, timeoutMs = 15 * 60 * 1000, pollMs = 1000): Promise<InterventionRequest> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = await readIntervention(id);
    if (record.status === "resolved") return record;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for human resolution of intervention ${id}`);
}
