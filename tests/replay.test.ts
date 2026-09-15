import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/mock-app/server.js";
import { replayArtifact } from "../src/replay/executor.js";
import { parseArtifact, type CapabilityArtifact } from "../src/core/artifact.js";
import { rm } from "node:fs/promises";
import path from "node:path";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(path.resolve(process.cwd(), ".escalations"), { recursive: true, force: true });
});

/** A hand-authored artifact (independent of any LLM discovery run) that
 *  looks up a member and reads their savings balance. Exercises the same
 *  locator/checkpoint/known-outcome machinery real capabilities use. */
function makeArtifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return parseArtifact({
    schemaVersion: 1,
    id: "test.read_savings_balance",
    name: "test.read_savings_balance",
    version: 1,
    description: "Look up a member and read their savings balance.",
    goalTemplate: "Look up member {{memberId}} and read their savings balance.",
    target: { baseUrl, startPath: "/", allowedRoutes: ["^/$", "^/search", "^/members(/.*)?$", "^/interstitial/ack$"] },
    inputs: [{ name: "memberId", type: "string", required: true, pattern: "^[0-9]{5}$", sensitive: false }],
    outputs: [{ name: "savingsBalance", type: "string" }],
    steps: [
      { id: "s0", description: "Search for the member", action: "navigate", url: "/search?q={{memberId}}", riskLevel: "safe" },
      {
        id: "s1",
        description: "Open the member's record",
        action: "click",
        locator: { primary: { strategy: "role", role: "link", name: "Open Record" }, fallbacks: [] },
        checkpoint: { urlContains: "/members/" },
        riskLevel: "safe",
      },
      {
        id: "s2",
        description: "Read the savings balance",
        action: "extract",
        locator: { primary: { strategy: "cell", label: "Savings Balance" }, fallbacks: [] },
        extractAs: "savingsBalance",
        riskLevel: "safe",
      },
    ],
    successCheckpoint: { textContains: "Savings Balance" },
    knownOutcomes: [
      {
        code: "MEMBER_NOT_FOUND",
        description: "No member matches the given id.",
        detect: { textContains: "No members found matching" },
        resultType: "business_outcome",
      },
    ],
    riskLevel: "safe",
    approvalStatus: "approved",
    provenance: { discoveryRunId: "test", model: "test", recordedAt: new Date().toISOString() },
    ...overrides,
  });
}

describe("replay executor: success path", () => {
  it("looks up an existing member and extracts their savings balance", async () => {
    const artifact = makeArtifact();
    const result = await replayArtifact(artifact, {
      runId: `test-success-${Date.now()}`,
      inputs: { memberId: "10023" },
      evidenceDir: path.resolve(process.cwd(), "evidence", "test-tmp-success"),
    });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.savingsBalance).toBe("$12500.00");
    }
  });
});

describe("replay executor: business outcomes vs hard failures", () => {
  it("reports MEMBER_NOT_FOUND as a business outcome, not a crash", async () => {
    const artifact = makeArtifact();
    const result = await replayArtifact(artifact, {
      runId: `test-notfound-${Date.now()}`,
      inputs: { memberId: "99999" },
      evidenceDir: path.resolve(process.cwd(), "evidence", "test-tmp-notfound"),
    });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.code).toBe("MEMBER_NOT_FOUND");
    }
  });

  it("reports an undeclared dead-end as a hard failure with debuggable detail", async () => {
    // Restricted member: no "Open Sub-Account" link exists, but this artifact's
    // known-outcome taxonomy doesn't cover restricted accounts, so failing to
    // find the link must surface as a hard failure, not silently succeed.
    const artifact = makeArtifact({ knownOutcomes: [] });
    const result = await replayArtifact(artifact, {
      runId: `test-harderr-${Date.now()}`,
      inputs: { memberId: "99999" },
      evidenceDir: path.resolve(process.cwd(), "evidence", "test-tmp-harderr"),
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.step).toBe("s1");
      expect(result.message).toBeTruthy();
    }
  });
});

describe("replay executor: input & approval gates", () => {
  it("refuses to run with a missing required input", async () => {
    const artifact = makeArtifact();
    const result = await replayArtifact(artifact, {
      runId: `test-badinput-${Date.now()}`,
      inputs: {},
      evidenceDir: path.resolve(process.cwd(), "evidence", "test-tmp-badinput"),
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.step).toBe("preflight");
  });

  it("refuses to run with an input that fails its declared pattern", async () => {
    const artifact = makeArtifact();
    const result = await replayArtifact(artifact, {
      runId: `test-badpattern-${Date.now()}`,
      inputs: { memberId: "not-a-valid-id" },
      evidenceDir: path.resolve(process.cwd(), "evidence", "test-tmp-badpattern"),
    });
    expect(result.status).toBe("error");
  });

  it("refuses unattended replay of a draft artifact without --force", async () => {
    const artifact = makeArtifact({ approvalStatus: "draft" });
    const result = await replayArtifact(artifact, {
      runId: `test-draft-${Date.now()}`,
      inputs: { memberId: "10023" },
      evidenceDir: path.resolve(process.cwd(), "evidence", "test-tmp-draft"),
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.observed).toBe("draft");
  });

  it("allows a draft artifact to run when force is set", async () => {
    const artifact = makeArtifact({ approvalStatus: "draft" });
    const result = await replayArtifact(artifact, {
      runId: `test-draft-force-${Date.now()}`,
      inputs: { memberId: "10023" },
      evidenceDir: path.resolve(process.cwd(), "evidence", "test-tmp-draft-force"),
      force: true,
    });
    expect(result.status).toBe("success");
  });
});
