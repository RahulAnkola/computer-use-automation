import type { CapabilityArtifact, ArtifactStep, KnownOutcome } from "../core/artifact.js";
import { createSharedSession } from "../core/session.js";
import { doClick, doType, doSelect, doNavigate, doExtract } from "../core/actions.js";
import { renderRobustLocator, renderUrlTemplate, renderTemplate } from "../core/templating.js";
import { checkpointHolds } from "../core/checkpoint.js";
import { dismissKnownInterstitials } from "../core/interstitials.js";
import { defaultPolicy, assertDomainAllowed, assertRouteAllowed, assertActionTypeAllowed, type GuardrailPolicy, PolicyViolationError } from "../core/guardrails.js";
import { raiseIntervention, waitForResolution } from "../core/escalation.js";
import { RunLogger } from "../core/logger.js";
import { observe } from "../core/perception.js";
import path from "node:path";

export type ReplayResult =
  | { status: "success"; outputs: Record<string, unknown> }
  | { status: "business_outcome"; code: string; message: string; outputs?: Record<string, unknown> }
  | { status: "escalated"; interventionId: string; reason: string }
  | { status: "error"; step: string; expected: string; observed: string; message: string };

export interface ReplayOptions {
  runId: string;
  inputs: Record<string, string | number | boolean>;
  evidenceDir: string;
  policy?: GuardrailPolicy;
  /** Bypass the draft/approved gate. Off by default -- unattended replay of an
   *  unreviewed capability is exactly the kind of thing guardrails exist to stop. */
  force?: boolean;
}

function toParamStrings(inputs: Record<string, string | number | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) out[k] = String(v);
  return out;
}

function validateInputs(artifact: CapabilityArtifact, inputs: Record<string, string | number | boolean>): string | null {
  for (const spec of artifact.inputs) {
    const value = inputs[spec.name];
    if (value === undefined || value === null || value === "") {
      if (spec.required) return `Missing required input "${spec.name}"`;
      continue;
    }
    if (spec.type === "number" && Number.isNaN(Number(value))) return `Input "${spec.name}" must be a number`;
    if (spec.pattern && !new RegExp(spec.pattern).test(String(value))) {
      return `Input "${spec.name}" does not match required pattern ${spec.pattern}`;
    }
  }
  return null;
}

function coerceOutputs(artifact: CapabilityArtifact, raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of artifact.outputs) {
    const value = raw[spec.name];
    if (value === undefined) continue;
    if (spec.type === "number") out[spec.name] = Number(value.replace(/[^0-9.-]/g, ""));
    else if (spec.type === "boolean") out[spec.name] = /^(true|yes)$/i.test(value);
    else out[spec.name] = value;
  }
  return out;
}

async function findMatchingOutcome(
  page: any,
  outcomes: KnownOutcome[],
  params: Record<string, string>
): Promise<KnownOutcome | undefined> {
  for (const outcome of outcomes) {
    if (await checkpointHolds(page, outcome.detect, params)) return outcome;
  }
  return undefined;
}

export async function replayArtifact(artifact: CapabilityArtifact, opts: ReplayOptions): Promise<ReplayResult> {
  const policy = opts.policy ?? defaultPolicy;
  const logger = await RunLogger.create(opts.evidenceDir, opts.runId);

  if (artifact.approvalStatus === "draft" && !opts.force) {
    await logger.log("error", { message: "Artifact is in draft status; refusing unattended replay without --force" });
    return {
      status: "error",
      step: "preflight",
      expected: "approvalStatus=approved (or --force)",
      observed: artifact.approvalStatus,
      message: "Artifact has not been approved for unattended replay.",
    };
  }

  const inputError = validateInputs(artifact, opts.inputs);
  if (inputError) {
    await logger.log("error", { message: inputError });
    return { status: "error", step: "preflight", expected: "valid inputs per schema", observed: JSON.stringify(opts.inputs), message: inputError };
  }
  const params = toParamStrings(opts.inputs);

  // Risky capabilities run headful: a human must be *able* to see and take
  // over the live session the moment an escalate step or hard failure hits.
  const headless = artifact.riskLevel !== "risky";
  const session = await createSharedSession({ headless });
  const { page } = session;

  await logger.log("start", { capability: artifact.name, version: artifact.version, inputs: params, headless });

  try {
    const startUrl = new URL(renderUrlTemplate(artifact.target.startPath, params), artifact.target.baseUrl).toString();
    assertDomainAllowed(policy, startUrl);
    assertRouteAllowed(policy, startUrl);
    await doNavigate(page, startUrl);
    await logger.log("act", { action: "navigate", url: startUrl });

    const extracted: Record<string, string> = {};

    for (const step of artifact.steps) {
      const result = await runStep(page, step, params, policy, logger, opts, extracted, artifact.knownOutcomes);
      if (result) return result; // early terminal outcome (business outcome / error / escalated-and-aborted)
    }

    const finalOk = await checkpointHolds(page, artifact.successCheckpoint, params);
    if (!finalOk) {
      const observed = await observe(page).catch(() => undefined);
      await logger.log("error", { message: "Success checkpoint not met at end of run", observed: observed?.summary });
      return {
        status: "error",
        step: "success_checkpoint",
        expected: JSON.stringify(artifact.successCheckpoint),
        observed: observed?.summary ?? page.url(),
        message: "All steps executed but the declared success checkpoint was not met.",
      };
    }

    const outputs = coerceOutputs(artifact, extracted);
    await logger.log("outcome", { status: "success", outputs });
    return { status: "success", outputs };
  } finally {
    const shotPath = path.join(opts.evidenceDir, "final.png");
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
    await session.close();
  }
}

async function runStep(
  page: import("playwright").Page,
  step: ArtifactStep,
  params: Record<string, string>,
  policy: GuardrailPolicy,
  logger: RunLogger,
  opts: ReplayOptions,
  extracted: Record<string, string>,
  knownOutcomes: KnownOutcome[]
): Promise<ReplayResult | undefined> {
  if (step.action === "escalate") {
    const screenshotPath = path.join(opts.evidenceDir, `escalation-${step.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    const intervention = await raiseIntervention({
      runId: opts.runId,
      capability: "replay",
      goal: step.description,
      currentStepId: step.id,
      currentUrl: page.url(),
      reason: step.description,
      screenshotPath,
    });
    await logger.log("escalation_raised", { interventionId: intervention.id, step: step.id });
    try {
      const resolved = await waitForResolution(intervention.id);
      await logger.log("escalation_resolved", { interventionId: intervention.id, resolution: resolved.resolution });
      if (resolved.resolution?.outcome === "aborted") {
        return { status: "escalated", interventionId: intervention.id, reason: "Operator aborted the run" };
      }
      return undefined; // resumed; continue to next step
    } catch (err: any) {
      return { status: "escalated", interventionId: intervention.id, reason: `Timed out waiting for operator: ${err.message}` };
    }
  }

  const attempts = 2; // 1 initial + 1 retry, absorbs transient/recoverable conditions
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const dismissed = await dismissKnownInterstitials(page);
      if (dismissed) await logger.log("recovered", { step: step.id, message: "Dismissed a known interstitial before proceeding" });
      assertActionTypeAllowed(policy, step.action);
      await performAction(page, step, params, extracted, policy);
      const ok = await checkpointHolds(page, step.checkpoint, params);
      if (!ok) throw new Error(`Checkpoint not met after step: ${JSON.stringify(step.checkpoint)}`);
      await logger.log("act", { step: step.id, action: step.action, description: step.description, attempt: attempt + 1 });
      return undefined; // step succeeded, move on
    } catch (err: any) {
      lastErr = err;
      if (err instanceof PolicyViolationError) {
        await logger.log("policy_block", { step: step.id, message: err.message });
        return { status: "error", step: step.id, expected: step.description, observed: "blocked by policy", message: err.message };
      }
      await logger.log("retry", { step: step.id, attempt: attempt + 1, message: String(err?.message ?? err) });
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Exhausted retries: classify against the artifact's known-outcome taxonomy
  // before giving up. This is the "business outcome vs failure" seam.
  const match = await findMatchingOutcome(page, knownOutcomes, params);
  if (match) {
    await logger.log("outcome", { status: match.resultType, code: match.code, step: step.id });
    if (match.resultType === "business_outcome" || match.resultType === "recoverable") {
      return { status: "business_outcome", code: match.code, message: match.description, outputs: extracted };
    }
  }

  const observed = await observe(page).catch(() => undefined);
  await logger.log("error", { step: step.id, message: String((lastErr as any)?.message ?? lastErr), observed: observed?.summary });
  return {
    status: "error",
    step: step.id,
    expected: step.description,
    observed: observed?.summary ?? page.url(),
    message: String((lastErr as any)?.message ?? lastErr),
  };
}

async function performAction(
  page: import("playwright").Page,
  step: ArtifactStep,
  params: Record<string, string>,
  extracted: Record<string, string>,
  policy: GuardrailPolicy
): Promise<void> {
  switch (step.action) {
    case "navigate": {
      const url = new URL(renderUrlTemplate(step.url!, params), page.url()).toString();
      assertDomainAllowed(policy, url);
      assertRouteAllowed(policy, url);
      await doNavigate(page, url);
      return;
    }
    case "click": {
      const locator = renderRobustLocator(step.locator!, params);
      await doClick(page, locator);
      return;
    }
    case "type": {
      const locator = renderRobustLocator(step.locator!, params);
      await doType(page, locator, renderTemplate(step.value ?? "", params));
      return;
    }
    case "select": {
      const locator = renderRobustLocator(step.locator!, params);
      await doSelect(page, locator, renderTemplate(step.value ?? "", params));
      return;
    }
    case "extract": {
      const locator = renderRobustLocator(step.locator!, params);
      const result = await doExtract(page, locator);
      extracted[step.extractAs ?? "value"] = result.observed ?? "";
      return;
    }
    case "assert_text": {
      // handled via checkpoint on the step itself
      return;
    }
    case "wait_for": {
      await page.waitForTimeout(500);
      return;
    }
  }
}
