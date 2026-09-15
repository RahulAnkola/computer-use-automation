import { z } from "zod";

// --- Locators -----------------------------------------------------------
//
// `name` / `text` / `label` are *template strings*: plain text, optionally
// containing `{{paramName}}` placeholders that get substituted from the
// capability's typed input parameters at replay time (see templating.ts).
// This is what lets a step recorded against member "10023" replay correctly
// against member "10045" without re-recording.

const RoleLocatorSchema = z.object({
  strategy: z.literal("role"),
  role: z.string(),
  name: z.string(),
  nth: z.number().int().optional(),
});
const LabelLocatorSchema = z.object({
  strategy: z.literal("label"),
  label: z.string(),
  nth: z.number().int().optional(),
});
const TextLocatorSchema = z.object({
  strategy: z.literal("text"),
  text: z.string(),
  exact: z.boolean().optional(),
  nth: z.number().int().optional(),
});
const CssLocatorSchema = z.object({ strategy: z.literal("css"), css: z.string() });
const TestIdLocatorSchema = z.object({ strategy: z.literal("testid"), testid: z.string() });
const CellLocatorSchema = z.object({
  strategy: z.literal("cell"),
  label: z.string(),
  nth: z.number().int().optional(),
});

export const LocatorSchema = z.discriminatedUnion("strategy", [
  RoleLocatorSchema,
  LabelLocatorSchema,
  TextLocatorSchema,
  CssLocatorSchema,
  TestIdLocatorSchema,
  CellLocatorSchema,
]);

export const RobustLocatorSchema = z.object({
  primary: LocatorSchema,
  fallbacks: z.array(LocatorSchema).default([]),
});

// --- Checkpoints ----------------------------------------------------------

export const CheckpointSchema = z.object({
  /** Text that must be visible on the page for this step/run to be considered on-track. */
  textContains: z.string().optional(),
  /** URL substring/regex the page must match. */
  urlContains: z.string().optional(),
  /** A specific locator that must be present. */
  locatorPresent: RobustLocatorSchema.optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

// --- Steps ------------------------------------------------------------------

const RiskLevel = z.enum(["safe", "risky"]);

export const StepSchema = z.object({
  id: z.string(),
  description: z.string(),
  action: z.enum(["navigate", "click", "type", "select", "extract", "assert_text", "wait_for", "escalate"]),
  url: z.string().optional(), // for navigate; template string, e.g. "/members/{{memberId}}"
  locator: RobustLocatorSchema.optional(), // for click/type/select/extract
  value: z.string().optional(), // for type/select/assert_text(text); template string
  extractAs: z.string().optional(), // output key this step's extracted value feeds
  checkpoint: CheckpointSchema.optional(),
  riskLevel: RiskLevel.default("safe"),
});
export type ArtifactStep = z.infer<typeof StepSchema>;

// --- Known / expected non-happy-path outcomes -------------------------------

export const KnownOutcomeSchema = z.object({
  code: z.string(), // e.g. "MEMBER_NOT_FOUND"
  description: z.string(),
  detect: CheckpointSchema, // how replay recognizes this outcome occurred
  resultType: z.enum(["business_outcome", "recoverable", "hard_failure"]),
});
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

// --- Params / outputs (typed contract) --------------------------------------

const JsonPrimitive = z.enum(["string", "number", "boolean"]);
export const ParamSpecSchema = z.object({
  name: z.string(),
  type: JsonPrimitive,
  required: z.boolean().default(true),
  description: z.string().optional(),
  /** e.g. regex for member IDs -- enforced by guardrails before replay starts. */
  pattern: z.string().optional(),
  sensitive: z.boolean().default(false), // never logged/persisted in the clear
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const OutputSpecSchema = z.object({
  name: z.string(),
  type: JsonPrimitive,
  description: z.string().optional(),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// --- Top-level capability artifact -------------------------------------------

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(), // e.g. "bankops.open_sub_account"
  version: z.number().int().default(1),
  description: z.string(),
  goalTemplate: z.string(), // the natural-language goal this was recorded from

  target: z.object({
    baseUrl: z.string(),
    startPath: z.string(), // template string, relative to baseUrl, e.g. "/"
    allowedRoutes: z.array(z.string()), // regex strings, enforced by guardrails at replay time
  }),

  inputs: z.array(ParamSpecSchema),
  outputs: z.array(OutputSpecSchema),

  steps: z.array(StepSchema),
  successCheckpoint: CheckpointSchema,
  knownOutcomes: z.array(KnownOutcomeSchema).default([]),

  riskLevel: RiskLevel.default("safe"),
  approvalStatus: z.enum(["draft", "approved"]).default("draft"),

  provenance: z.object({
    discoveryRunId: z.string(),
    model: z.string(),
    recordedAt: z.string(), // ISO timestamp
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export function parseArtifact(json: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(json);
}
