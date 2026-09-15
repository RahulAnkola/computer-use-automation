import type { ActionType } from "./types.js";

/**
 * Explicit, configurable policy the agent (discovery) and the replay engine
 * both consult before acting. This is intentionally a plain data structure
 * (not code) so it can be reviewed and edited without touching the engine,
 * and so the same policy object can be swapped per-tenant later.
 */
export interface GuardrailPolicy {
  allowedDomains: string[]; // hostnames the agent/replay may ever navigate to
  allowedRoutePatterns: RegExp[]; // paths within an allowed domain the agent may act on
  allowedActionTypes: ActionType[];
  /** Accessible-name patterns that mark a control as risky/irreversible regardless of action type. */
  riskyControlPatterns: RegExp[];
  maxSteps: number;
  maxRuntimeMs: number;
}

export const defaultPolicy: GuardrailPolicy = {
  allowedDomains: ["localhost", "127.0.0.1"],
  allowedRoutePatterns: [/^\/$/, /^\/search/, /^\/members(\/.*)?$/, /^\/interstitial\/ack$/],
  allowedActionTypes: ["navigate", "click", "type", "select", "extract", "assert_text", "wait_for", "escalate"],
  riskyControlPatterns: [/approve as manager/i, /delete/i, /close account/i, /manager/i],
  maxSteps: 40,
  maxRuntimeMs: 5 * 60 * 1000,
};

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export function assertDomainAllowed(policy: GuardrailPolicy, url: string): void {
  const host = new URL(url).hostname;
  if (!policy.allowedDomains.includes(host)) {
    throw new PolicyViolationError(`Domain not in allowlist: ${host}`);
  }
}

export function assertRouteAllowed(policy: GuardrailPolicy, url: string): void {
  const path = new URL(url).pathname;
  const ok = policy.allowedRoutePatterns.some((re) => re.test(path));
  if (!ok) {
    throw new PolicyViolationError(`Route not in allowlist: ${path}`);
  }
}

export function assertActionTypeAllowed(policy: GuardrailPolicy, action: ActionType): void {
  if (!policy.allowedActionTypes.includes(action)) {
    throw new PolicyViolationError(`Action type not allowed: ${action}`);
  }
}

/** Is this specific control (by accessible name) one the agent must never click autonomously? */
export function isRiskyControl(policy: GuardrailPolicy, accessibleName: string): boolean {
  return policy.riskyControlPatterns.some((re) => re.test(accessibleName));
}

// --- Redaction -----------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /pass(word)?|token|secret|api[-_]?key|ssn|social.?security|credit.?card|cvv/i;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
// Real secrets (API keys, JWTs, session ids) are long, contain digits, and
// are not underscore_separated_words -- that shape is what distinguishes
// them from ordinary identifiers like a capability name
// ("open_sub_account_large_deposit"), which must NOT be redacted or the
// logs stop being useful for debugging.
const LONG_TOKEN_PATTERN = /\b(?=[A-Za-z0-9.-]{24,}\b)(?=[A-Za-z0-9.-]*[0-9])[A-Za-z0-9.-]{24,}\b/g;

/** Redact obvious secrets/PII shapes from a free-text string before it is logged or persisted. */
export function redactText(input: string): string {
  return input
    .replace(SSN_PATTERN, "[REDACTED-SSN]")
    .replace(CARD_PATTERN, (m) => (m.replace(/\D/g, "").length >= 13 ? "[REDACTED-CARD]" : m))
    .replace(LONG_TOKEN_PATTERN, "[REDACTED-TOKEN]");
}

/** Deep-redact an object: values under sensitive-looking keys are masked outright,
 *  every remaining string value is passed through redactText. */
export function redactValue(value: unknown, keyHint = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}
