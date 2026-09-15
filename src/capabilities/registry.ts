import type { ParamSpec, OutputSpec, KnownOutcome, CapabilityArtifact } from "../core/artifact.js";

/**
 * Hand-authored contract + failure-taxonomy metadata for each capability.
 *
 * Design note: the *happy-path steps* come from a real LLM discovery run
 * (src/agent/discover.ts) -- that part is genuinely learned, not hand-coded.
 * The *known-outcome taxonomy* here (what "member not found" looks like,
 * what a validation error looks like) is deliberately hand-authored: in a
 * real deployment this is exactly the kind of domain knowledge a human
 * reviewer adds on top of a discovered flow before approving it for
 * unattended replay. See REPORT.md ("Determinism & error handling").
 */
export interface CapabilityDef {
  name: string;
  description: string;
  startPath: string;
  paramSpecs: ParamSpec[];
  outputSpecs: OutputSpec[];
  knownOutcomes: KnownOutcome[];
}

const memberIdParam: ParamSpec = {
  name: "memberId",
  type: "string",
  required: true,
  description: "5-digit member/account id to look up.",
  pattern: "^[0-9]{5}$",
  sensitive: false,
};

const accountTypeParam: ParamSpec = {
  name: "accountType",
  type: "string",
  required: true,
  description: "Sub-account type to open.",
  pattern: "^(Sub-Savings|Sub-Checking)$",
  sensitive: false,
};

const depositAmountParam: ParamSpec = {
  name: "depositAmount",
  type: "number",
  required: true,
  description: "Initial deposit amount in USD for the new sub-account.",
  sensitive: false,
};

const memberNotFound: KnownOutcome = {
  code: "MEMBER_NOT_FOUND",
  description: "No member record matches the given member ID.",
  detect: { textContains: "No members found matching" },
  resultType: "business_outcome",
};

const permissionDenied: KnownOutcome = {
  code: "PERMISSION_DENIED",
  description: "The member's account is restricted; self-service actions are not permitted.",
  // Two different pages can show this, depending on where the flow stops:
  // the member record page never even renders the action's link/button for
  // a restricted account ("Account actions restricted..."), and a direct
  // hit on the guarded route renders a dedicated 403 page ("not permitted
  // for restricted accounts"). A capability step that clicks the link can
  // only ever observe the former; detect both so the outcome is caught
  // regardless of which step in the flow first notices the restriction.
  detect: { textContains: "restricted" }, // matches both "Account actions restricted..." and "...not permitted for restricted accounts"
  resultType: "business_outcome",
};

const validationErrorAmount: KnownOutcome = {
  code: "VALIDATION_ERROR",
  description: "The deposit amount failed a business validation rule (non-positive or non-numeric).",
  detect: { textContains: "Deposit must be a positive number" },
  resultType: "business_outcome",
};

const validationErrorMax: KnownOutcome = {
  code: "DEPOSIT_LIMIT_EXCEEDED",
  description: "The deposit amount exceeds the hard maximum allowed by the application.",
  detect: { textContains: "exceeds the maximum allowed" },
  resultType: "business_outcome",
};

export const capabilityDefs: Record<string, CapabilityDef> = {
  "bankops.open_sub_account": {
    name: "bankops.open_sub_account",
    description:
      "Look up a credit-union member and open a new self-service sub-account (deposit <= $10,000), reaching the confirmation screen.",
    startPath: "/",
    paramSpecs: [memberIdParam, accountTypeParam, depositAmountParam],
    outputSpecs: [
      { name: "subAccountId", type: "string", description: "The newly created sub-account's id." },
      { name: "confirmedBalance", type: "string", description: "Balance shown on the confirmation screen." },
    ],
    knownOutcomes: [memberNotFound, permissionDenied, validationErrorAmount, validationErrorMax],
  },
  "bankops.open_sub_account_large_deposit": {
    name: "bankops.open_sub_account_large_deposit",
    description:
      "Look up a credit-union member and open a new sub-account with a deposit over the $10,000 self-service limit. " +
      "Requires manager approval -- the agent must escalate to a human operator rather than approving it itself.",
    startPath: "/",
    paramSpecs: [memberIdParam, accountTypeParam, depositAmountParam],
    outputSpecs: [
      { name: "subAccountId", type: "string", description: "The newly created sub-account's id." },
      { name: "confirmedBalance", type: "string", description: "Balance shown on the confirmation screen." },
    ],
    knownOutcomes: [memberNotFound, permissionDenied],
  },
};

export function attachKnownOutcomes(artifact: CapabilityArtifact): CapabilityArtifact {
  const def = capabilityDefs[artifact.name];
  if (!def) return artifact;
  return { ...artifact, knownOutcomes: def.knownOutcomes };
}
