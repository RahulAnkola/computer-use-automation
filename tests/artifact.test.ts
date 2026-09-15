import { describe, it, expect } from "vitest";
import { parseArtifact } from "../src/core/artifact.js";

const minimalValid = {
  schemaVersion: 1,
  id: "test.cap",
  name: "test.cap",
  version: 1,
  description: "A capability.",
  goalTemplate: "Do the thing for {{memberId}}.",
  target: { baseUrl: "http://localhost:4173", startPath: "/", allowedRoutes: ["^/$"] },
  inputs: [{ name: "memberId", type: "string", required: true, sensitive: false }],
  outputs: [{ name: "result", type: "string" }],
  steps: [{ id: "s0", description: "Navigate", action: "navigate", url: "/", riskLevel: "safe" }],
  successCheckpoint: { textContains: "done" },
  knownOutcomes: [],
  riskLevel: "safe",
  approvalStatus: "draft",
  provenance: { discoveryRunId: "run1", model: "gemini-2.5-flash", recordedAt: new Date().toISOString() },
};

describe("CapabilityArtifact schema", () => {
  it("accepts a well-formed artifact", () => {
    expect(() => parseArtifact(minimalValid)).not.toThrow();
  });

  it("rejects an artifact missing required fields", () => {
    const { target, ...rest } = minimalValid;
    expect(() => parseArtifact(rest)).toThrow();
  });

  it("rejects an unknown locator strategy (typo-proofing the schema)", () => {
    const bad = {
      ...minimalValid,
      steps: [
        {
          id: "s0",
          description: "Click",
          action: "click",
          locator: { primary: { strategy: "xpath", css: "//div" }, fallbacks: [] },
          riskLevel: "safe",
        },
      ],
    };
    expect(() => parseArtifact(bad)).toThrow();
  });

  it("rejects an unknown action type", () => {
    const bad = { ...minimalValid, steps: [{ id: "s0", description: "?", action: "hover", riskLevel: "safe" }] };
    expect(() => parseArtifact(bad)).toThrow();
  });

  it("defaults version, riskLevel, and approvalStatus when omitted", () => {
    const { version, riskLevel, approvalStatus, ...rest } = minimalValid;
    const parsed = parseArtifact(rest);
    expect(parsed.version).toBe(1);
    expect(parsed.riskLevel).toBe("safe");
    expect(parsed.approvalStatus).toBe("draft");
  });

  it("accepts a fully-specified known outcome and escalate step", () => {
    const withEscalation = {
      ...minimalValid,
      steps: [
        ...minimalValid.steps,
        { id: "s1", description: "Escalate to manager", action: "escalate", riskLevel: "risky" },
      ],
      knownOutcomes: [
        {
          code: "MEMBER_NOT_FOUND",
          description: "No such member.",
          detect: { textContains: "No members found" },
          resultType: "business_outcome",
        },
      ],
    };
    const parsed = parseArtifact(withEscalation);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.knownOutcomes[0]?.resultType).toBe("business_outcome");
  });
});
