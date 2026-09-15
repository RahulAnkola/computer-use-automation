import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  raiseIntervention,
  listInterventions,
  readIntervention,
  resolveIntervention,
  waitForResolution,
} from "../src/core/escalation.js";

const DIR = path.resolve(process.cwd(), ".escalations");

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe("escalation queue", () => {
  it("raises an intervention with the context a human needs to act on it", async () => {
    const record = await raiseIntervention({
      runId: "run-1",
      capability: "bankops.open_sub_account_large_deposit",
      goal: "Open a large sub-account",
      currentStepId: "step-6",
      currentUrl: "http://localhost:4173/members/10045/open-account",
      reason: "Requires manager approval",
    });
    expect(record.status).toBe("pending");
    expect(record.id).toBeTruthy();

    const reread = await readIntervention(record.id);
    expect(reread).toEqual(record);
  });

  it("lists interventions oldest-first", async () => {
    const first = await raiseIntervention({
      runId: "run-1",
      capability: "cap-a",
      goal: "goal-a",
      currentUrl: "http://localhost:4173/",
      reason: "reason-a",
    });
    const second = await raiseIntervention({
      runId: "run-2",
      capability: "cap-b",
      goal: "goal-b",
      currentUrl: "http://localhost:4173/",
      reason: "reason-b",
    });
    const items = await listInterventions();
    expect(items.map((i) => i.id)).toEqual([first.id, second.id]);
  });

  it("records who resolved an intervention, what they did, and the outcome", async () => {
    const record = await raiseIntervention({
      runId: "run-1",
      capability: "cap-a",
      goal: "goal-a",
      currentUrl: "http://localhost:4173/",
      reason: "reason-a",
    });
    const resolved = await resolveIntervention(record.id, {
      resolvedAt: new Date().toISOString(),
      operator: "test-operator",
      action: "Clicked Approve as Manager",
      outcome: "resumed",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.outcome).toBe("resumed");

    const reread = await readIntervention(record.id);
    expect(reread.status).toBe("resolved");
  });

  it("waitForResolution blocks until resolved, then returns the resolution", async () => {
    const record = await raiseIntervention({
      runId: "run-1",
      capability: "cap-a",
      goal: "goal-a",
      currentUrl: "http://localhost:4173/",
      reason: "reason-a",
    });

    const waiter = waitForResolution(record.id, 5000, 50);
    // Resolve shortly after starting to wait, from a "separate" call --
    // simulating the operator CLI acting from another process.
    setTimeout(() => {
      resolveIntervention(record.id, {
        resolvedAt: new Date().toISOString(),
        operator: "test-operator",
        action: "approved",
        outcome: "resumed",
      });
    }, 100);

    const result = await waiter;
    expect(result.status).toBe("resolved");
  });

  it("waitForResolution times out if nobody resolves it", async () => {
    const record = await raiseIntervention({
      runId: "run-1",
      capability: "cap-a",
      goal: "goal-a",
      currentUrl: "http://localhost:4173/",
      reason: "reason-a",
    });
    await expect(waitForResolution(record.id, 200, 50)).rejects.toThrow(/Timed out/);
  });
});
