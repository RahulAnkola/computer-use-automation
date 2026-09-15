import type { FunctionDeclaration } from "@google/genai";
import type { Page } from "playwright";
import { LlmClient } from "./llmClient.js";
import { observe } from "../core/perception.js";
import { doClick, doType, doSelect, doNavigate, doExtract } from "../core/actions.js";
import {
  defaultPolicy,
  assertDomainAllowed,
  assertRouteAllowed,
  isRiskyControl,
  type GuardrailPolicy,
  PolicyViolationError,
} from "../core/guardrails.js";
import { raiseIntervention, waitForResolution } from "../core/escalation.js";
import { dismissKnownInterstitials } from "../core/interstitials.js";
import { RunLogger } from "../core/logger.js";
import { createSharedSession } from "../core/session.js";
import { templatizeRobustLocator, templatizeString } from "../core/templating.js";
import type { CapabilityArtifact, ArtifactStep, ParamSpec, OutputSpec } from "../core/artifact.js";
import type { PageObservation } from "../core/types.js";
import path from "node:path";

export interface DiscoveryConfig {
  runId: string;
  capabilityName: string;
  description: string;
  goal: string; // concrete natural-language goal, e.g. mentions "member 10023"
  targetBaseUrl: string;
  startPath: string;
  paramValues: Record<string, string>; // concrete values used this run, keyed by param name
  paramSpecs: ParamSpec[];
  outputSpecs: OutputSpec[];
  headless: boolean;
  evidenceDir: string;
  policy?: GuardrailPolicy;
  model: string;
  apiKey: string;
}

export interface DiscoveryResult {
  status: "success" | "failed";
  artifact?: CapabilityArtifact;
  summary: string;
}

type TraceStep = ArtifactStep;

const TOOLS: FunctionDeclaration[] = [
  {
    name: "click",
    description: "Click an interactive element on the current page, identified by its ref from the latest observation.",
    parametersJsonSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "type",
    description: "Type text into a textbox element, identified by its ref from the latest observation. Replaces any existing value.",
    parametersJsonSchema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
    },
  },
  {
    name: "select",
    description: "Choose an option (by value) in a dropdown/combobox element, identified by its ref.",
    parametersJsonSchema: {
      type: "object",
      properties: { ref: { type: "string" }, value: { type: "string" } },
      required: ["ref", "value"],
    },
  },
  {
    name: "navigate",
    description: "Navigate the browser to a URL (absolute, or relative to the current page's origin).",
    parametersJsonSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "extract",
    description:
      "Read the text content of an element (identified by ref) and record it under outputName. Use this for any data point the goal asks you to report (e.g. a balance).",
    parametersJsonSchema: {
      type: "object",
      properties: { ref: { type: "string" }, outputName: { type: "string" } },
      required: ["ref", "outputName"],
    },
  },
  {
    name: "request_human",
    description:
      "Stop and hand control to a human operator because the goal cannot be safely completed autonomously (e.g. it requires a manager-only approval, an out-of-policy action, or you are stuck / the page state is unexpected). Explain why.",
    parametersJsonSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
  {
    name: "finish",
    description: "Declare the goal complete (or definitively not achievable) and stop the run.",
    parametersJsonSchema: {
      type: "object",
      properties: { success: { type: "boolean" }, summary: { type: "string" } },
      required: ["success", "summary"],
    },
  },
];

function systemPrompt(goal: string, policy: GuardrailPolicy, outputSpecs: OutputSpec[]): string {
  const outputList = outputSpecs.length
    ? outputSpecs.map((o) => `"${o.name}"${o.description ? ` (${o.description})` : ""}`).join(", ")
    : "(none declared)";
  return `You are an automation agent operating "BankOps Console", a legacy internal back-office web
application for a credit union, on behalf of a human operator. You interact with the page only
through the provided tools: click, type, select, navigate, extract, request_human, finish.

Your goal for this run:
"${goal}"

This capability must report these exact outputs when you extract data: ${outputList}.
When you call "extract", use one of those exact names as outputName -- do not invent your own
names, and do not extract the same value more than once.

Rules:
- Only act within this domain: ${policy.allowedDomains.join(", ")}. Never navigate elsewhere.
- Reference elements ONLY by the "ref" values given in the most recent observation. Refs are
  reassigned on every observation, so always use the latest list, never one from earlier in the
  conversation.
- Use "extract" to record any data point the goal asks you to read or report (e.g. a balance, an
  account id). Do not just describe it in prose -- extract it, then reference it in your final summary.
- If a control's label suggests it is a manager-only override, an approval, or otherwise outside
  normal self-service action (e.g. "Approve as Manager"), do NOT click it yourself. Call
  request_human with a clear reason instead. A human operator will act on the same live session
  and you will be resumed afterward.
- If you are stuck (the page is not what you expect, an error you don't understand appears, or
  you've tried the same thing twice with no progress), call request_human rather than guessing.
- Call "finish" with success=true only once you can see, on the current page, that the goal's
  end state has actually been reached (e.g. a confirmation message/id is visible). If the goal is
  truly not achievable (e.g. a definitive "not found" result), call finish with success=false and
  explain why in summary -- that is a legitimate outcome, not a failure of judgement.
- Call exactly one tool per turn.`;
}

function renderObservation(obs: PageObservation, progress: string[]): string {
  const elementLines = obs.elements
    .slice(0, 60)
    .map((e) => {
      const bits = [`ref=${e.ref}`, `role=${e.role}`, `name="${e.name}"`];
      if (e.value) bits.push(`value="${e.value}"`);
      if (e.options?.length) bits.push(`options=[${e.options.join(", ")}]`);
      return `- ${bits.join(" ")}`;
    })
    .join("\n");

  return `Progress so far:\n${progress.length ? progress.map((p, i) => `${i + 1}. ${p}`).join("\n") : "(nothing yet)"}

Current page:
URL: ${obs.url}
Title: ${obs.title}
Content summary: ${obs.summary}

Interactive elements:
${elementLines || "(none found)"}

Decide the single next tool call to make progress toward the goal.`;
}

export async function runDiscovery(cfg: DiscoveryConfig): Promise<DiscoveryResult> {
  const policy = cfg.policy ?? defaultPolicy;
  const logger = await RunLogger.create(cfg.evidenceDir, cfg.runId);
  const llm = new LlmClient(cfg.apiKey, cfg.model);

  await logger.log("start", { goal: cfg.goal, capability: cfg.capabilityName, headless: cfg.headless });

  const session = await createSharedSession({ headless: cfg.headless });
  const { page } = session;

  try {
    return await runLoop();
  } catch (err: any) {
    await logger.log("error", { message: `Discovery crashed: ${String(err?.message ?? err)}` });
    return { status: "failed", summary: `Discovery crashed: ${String(err?.message ?? err)}` };
  } finally {
    await session.close();
  }

  async function runLoop(): Promise<DiscoveryResult> {
  const startUrl = new URL(cfg.startPath, cfg.targetBaseUrl).toString();
  assertDomainAllowed(policy, startUrl);
  assertRouteAllowed(policy, startUrl);
  await doNavigate(page, startUrl);
  await logger.log("act", { action: "navigate", url: startUrl, description: "Open start page" });

  const trace: TraceStep[] = [];
  const progress: string[] = [];
  const extracted: Record<string, string> = {};
  let stepCounter = 0;
  let consecutiveInvalid = 0;

  const sys = systemPrompt(cfg.goal, policy, cfg.outputSpecs);

  for (let i = 0; i < policy.maxSteps; i++) {
    const dismissed = await dismissKnownInterstitials(page);
    if (dismissed) await logger.log("recovered", { message: "Dismissed a known interstitial before observing" });

    const screenshotPath = path.join(cfg.evidenceDir, `step-${String(i).padStart(2, "0")}.png`);
    const obs = await observe(page, screenshotPath);
    await logger.log("observe", { url: obs.url, summary: obs.summary.slice(0, 300), elementCount: obs.elements.length });

    const prompt = renderObservation(obs, progress);
    const turn = await llm.step(sys, [{ role: "user", parts: [{ text: prompt }] }], TOOLS);
    const call = turn.toolCalls[0];

    if (!call) {
      consecutiveInvalid++;
      await logger.log("error", { message: "Model returned no tool call", text: turn.text?.slice(0, 300) });
      if (consecutiveInvalid >= 3) break;
      continue;
    }
    await logger.log("decide", { tool: call.name, args: call.args });

    if (call.name === "finish") {
      const success = Boolean(call.args.success);
      const summary = String(call.args.summary ?? "");
      await logger.log("outcome", { status: success ? "success" : "failed", summary });
      if (!success) {
        return { status: "failed", summary };
      }
      // Capture a checkpoint from the final page state before tearing down.
      const finalObs = await observe(page);
      const artifact = buildArtifact(cfg, trace, finalObs);
      return { status: "success", artifact, summary };
    }

    if (call.name === "request_human") {
      const reason = String(call.args.reason ?? "unspecified");
      await handleEscalation({ cfg, logger, page, reason, stepId: `step-${stepCounter}`, trace });
      progress.push(`Escalated to a human operator: ${reason}. Resumed after resolution.`);
      continue;
    }

    const ref = String((call.args as any).ref ?? "");
    const element = obs.elements.find((e) => e.ref === ref);

    try {
      if (call.name === "navigate") {
        const url = new URL(String(call.args.url), obs.url).toString();
        assertDomainAllowed(policy, url);
        assertRouteAllowed(policy, url);
        await doNavigate(page, url);
        trace.push({
          id: `step-${stepCounter++}`,
          description: `Navigate to ${url}`,
          action: "navigate",
          url: templatizeString(new URL(url).pathname + new URL(url).search, cfg.paramValues),
          riskLevel: "safe",
        });
        progress.push(`Navigated to ${url}`);
      } else if (!element) {
        consecutiveInvalid++;
        await logger.log("error", { message: `Unknown ref "${ref}" for tool ${call.name}` });
        if (consecutiveInvalid >= 3) break;
        continue;
      } else if (call.name === "click") {
        if (isRiskyControl(policy, element.name)) {
          await logger.log("policy_block", { control: element.name, message: "Risky control blocked by guardrail; escalating instead" });
          await handleEscalation({
            cfg,
            logger,
            page,
            reason: `Guardrail blocked autonomous click on risky control "${element.name}"`,
            stepId: `step-${stepCounter}`,
            trace,
          });
          progress.push(`Blocked from clicking "${element.name}" by policy; escalated and resumed.`);
          continue;
        }
        await doClick(page, element.locator);
        trace.push({
          id: `step-${stepCounter++}`,
          description: `Click "${element.name}" (${element.role})`,
          action: "click",
          locator: templatizeRobustLocator(element.locator, cfg.paramValues),
          checkpoint: { urlContains: templatizeString(new URL(page.url()).pathname, cfg.paramValues) },
          riskLevel: "safe",
        });
        progress.push(`Clicked "${element.name}"`);
      } else if (call.name === "type") {
        const text = String(call.args.text ?? "");
        await doType(page, element.locator, text);
        trace.push({
          id: `step-${stepCounter++}`,
          description: `Type into "${element.name}"`,
          action: "type",
          locator: templatizeRobustLocator(element.locator, cfg.paramValues),
          value: templatizeString(text, cfg.paramValues),
          riskLevel: "safe",
        });
        progress.push(`Typed "${text}" into "${element.name}"`);
      } else if (call.name === "select") {
        const value = String(call.args.value ?? "");
        await doSelect(page, element.locator, value);
        trace.push({
          id: `step-${stepCounter++}`,
          description: `Select "${value}" in "${element.name}"`,
          action: "select",
          locator: templatizeRobustLocator(element.locator, cfg.paramValues),
          value: templatizeString(value, cfg.paramValues),
          riskLevel: "safe",
        });
        progress.push(`Selected "${value}" in "${element.name}"`);
      } else if (call.name === "extract") {
        const outputName = String(call.args.outputName ?? "value");
        const result = await doExtract(page, element.locator);
        extracted[outputName] = result.observed ?? "";
        trace.push({
          id: `step-${stepCounter++}`,
          description: `Extract "${element.name}" as ${outputName}`,
          action: "extract",
          locator: templatizeRobustLocator(element.locator, cfg.paramValues),
          extractAs: outputName,
          riskLevel: "safe",
        });
        progress.push(`Extracted ${outputName} = "${result.observed}"`);
      }
      consecutiveInvalid = 0;
    } catch (err: any) {
      if (err instanceof PolicyViolationError) {
        await logger.log("policy_block", { message: err.message });
        progress.push(`Blocked by policy: ${err.message}`);
        continue;
      }
      await logger.log("error", { message: String(err?.message ?? err) });
      progress.push(`Action failed: ${String(err?.message ?? err)}`);
    }
  }

  await logger.log("outcome", { status: "failed", summary: "Max steps reached without finishing" });
  return { status: "failed", summary: "Max steps reached without finishing" };
  }
}

async function handleEscalation(args: {
  cfg: DiscoveryConfig;
  logger: RunLogger;
  page: Page;
  reason: string;
  stepId: string;
  trace: TraceStep[];
}): Promise<void> {
  const { cfg, logger, page, reason, stepId, trace } = args;
  const screenshotPath = path.join(cfg.evidenceDir, `escalation-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

  const intervention = await raiseIntervention({
    runId: cfg.runId,
    capability: cfg.capabilityName,
    goal: cfg.goal,
    currentStepId: stepId,
    currentUrl: page.url(),
    reason,
    screenshotPath,
  });
  await logger.log("escalation_raised", { interventionId: intervention.id, reason, url: page.url() });

  trace.push({
    id: stepId,
    description: `Escalate to human operator: ${reason}`,
    action: "escalate",
    riskLevel: "risky",
  });

  const resolved = await waitForResolution(intervention.id);
  await logger.log("escalation_resolved", { interventionId: intervention.id, resolution: resolved.resolution });
}

/** Drop redundant re-extractions of the same output (the model occasionally
 *  extracts a value more than once when it's unsure a prior call landed) --
 *  keep only the last one, then renumber step ids to stay contiguous. */
function dedupeTrace(trace: TraceStep[]): TraceStep[] {
  const lastIndexForExtract = new Map<string, number>();
  trace.forEach((step, i) => {
    if (step.action === "extract" && step.extractAs) lastIndexForExtract.set(step.extractAs, i);
  });
  const kept = trace.filter(
    (step, i) => step.action !== "extract" || !step.extractAs || lastIndexForExtract.get(step.extractAs) === i
  );
  return kept.map((step, i) => ({ ...step, id: `step-${i}` }));
}

function buildArtifact(cfg: DiscoveryConfig, rawTrace: TraceStep[], finalObs: PageObservation): CapabilityArtifact {
  const trace = dedupeTrace(rawTrace);
  const heading = finalObs.summary.split(" -- ")[0]?.trim() || finalObs.title;
  return {
    schemaVersion: 1,
    id: cfg.capabilityName,
    name: cfg.capabilityName,
    version: 1,
    description: cfg.description,
    goalTemplate: templatizeString(cfg.goal, cfg.paramValues),
    target: {
      baseUrl: cfg.targetBaseUrl,
      startPath: templatizeString(cfg.startPath, cfg.paramValues),
      allowedRoutes: (cfg.policy ?? defaultPolicy).allowedRoutePatterns.map((r) => r.source),
    },
    inputs: cfg.paramSpecs,
    outputs: cfg.outputSpecs,
    steps: trace,
    successCheckpoint: { textContains: heading },
    knownOutcomes: [],
    riskLevel: trace.some((s) => s.riskLevel === "risky") ? "risky" : "safe",
    approvalStatus: "draft",
    provenance: {
      discoveryRunId: cfg.runId,
      model: cfg.model,
      recordedAt: new Date().toISOString(),
    },
  };
}
