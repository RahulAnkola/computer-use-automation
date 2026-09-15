import { describe, it, expect } from "vitest";
import {
  defaultPolicy,
  assertDomainAllowed,
  assertRouteAllowed,
  assertActionTypeAllowed,
  isRiskyControl,
  redactText,
  redactValue,
  PolicyViolationError,
} from "../src/core/guardrails.js";

describe("guardrails: allowlist enforcement", () => {
  it("allows a configured domain and route", () => {
    expect(() => assertDomainAllowed(defaultPolicy, "http://localhost:4173/members/10023")).not.toThrow();
    expect(() => assertRouteAllowed(defaultPolicy, "http://localhost:4173/members/10023")).not.toThrow();
  });

  it("blocks a domain outside the allowlist", () => {
    expect(() => assertDomainAllowed(defaultPolicy, "https://evil.example.com/")).toThrow(PolicyViolationError);
  });

  it("blocks a route outside the allowlist even on an allowed domain", () => {
    expect(() => assertRouteAllowed(defaultPolicy, "http://localhost:4173/admin/danger")).toThrow(PolicyViolationError);
  });

  it("blocks an action type outside the allowlist", () => {
    const restricted = { ...defaultPolicy, allowedActionTypes: ["navigate" as const] };
    expect(() => assertActionTypeAllowed(restricted, "click")).toThrow(PolicyViolationError);
  });
});

describe("guardrails: risky control classification", () => {
  it("flags manager/approval-style controls as risky", () => {
    expect(isRiskyControl(defaultPolicy, "Approve as Manager")).toBe(true);
    expect(isRiskyControl(defaultPolicy, "Delete Account")).toBe(true);
  });

  it("does not flag ordinary controls as risky", () => {
    expect(isRiskyControl(defaultPolicy, "Continue")).toBe(false);
    expect(isRiskyControl(defaultPolicy, "Search")).toBe(false);
  });
});

describe("guardrails: redaction", () => {
  it("redacts SSN-shaped strings", () => {
    expect(redactText("SSN on file: 123-45-6789")).toBe("SSN on file: [REDACTED-SSN]");
  });

  it("redacts long token-shaped strings", () => {
    const out = redactText("token=abcdefghijklmnopqrstuvwxyzABCDEF12345");
    expect(out).toContain("[REDACTED-TOKEN]");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("masks values whose key looks sensitive, regardless of shape", () => {
    const out = redactValue({ password: "hunter2", memberId: "10023" }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.memberId).toBe("10023");
  });

  it("redacts nested structures", () => {
    const out = redactValue({ user: { apiKey: "sk-abcdef", name: "Jane" } }) as any;
    expect(out.user.apiKey).toBe("[REDACTED]");
    expect(out.user.name).toBe("Jane");
  });
});
