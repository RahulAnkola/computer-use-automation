import type { Page, Locator as PwLocator } from "playwright";
import type { Locator, RobustLocator, ActionResult } from "./types.js";

/** Turn one of our portable Locator descriptors into a live Playwright locator. */
function toPwLocator(page: Page, loc: Locator): PwLocator {
  switch (loc.strategy) {
    case "role":
      return page.getByRole(loc.role as any, { name: loc.name }).nth(loc.nth ?? 0);
    case "label":
      // Legacy table-layout forms rarely have real <label for> associations
      // -- the "label" is just text in a sibling cell. Target the nearest
      // containing table row that has that text, then the control inside it,
      // rather than Playwright's getByLabel (which only understands real
      // <label> elements and would find nothing here).
      return page
        .locator("tr")
        .filter({ hasText: loc.label })
        .last()
        .locator("input, select, textarea")
        .nth(loc.nth ?? 0);
    case "text":
      return page.getByText(loc.text, { exact: loc.exact ?? false }).nth(loc.nth ?? 0);
    case "css":
      return page.locator(loc.css);
    case "testid":
      return page.getByTestId(loc.testid);
    case "cell":
      // Read-only "value" cell in a labeled table row: <tr><td>Label</td><td>Value</td></tr>.
      // No form control to target -- the value cell itself is the thing to read.
      return page.locator("tr").filter({ hasText: loc.label }).last().locator("td").last();
  }
}

export interface ResolvedLocator {
  locator: PwLocator;
  strategyUsed: Locator;
  attempts: { strategy: string; ok: boolean; error?: string }[];
}

/**
 * Resolve a RobustLocator against the live page, trying the primary strategy
 * then each fallback in order. This is the heart of "stable element/control
 * targeting": we don't assume the first strategy always works, we record
 * which one did, which both makes replay resilient to small DOM changes and
 * gives us a confidence signal (a step that only resolves via its last
 * fallback is a candidate for re-recording).
 */
export async function resolveLocator(page: Page, robust: RobustLocator, timeoutMs = 3000): Promise<ResolvedLocator> {
  const candidates = [robust.primary, ...robust.fallbacks];
  const attempts: ResolvedLocator["attempts"] = [];
  for (const candidate of candidates) {
    try {
      const pw = toPwLocator(page, candidate);
      await pw.first().waitFor({ state: "attached", timeout: timeoutMs });
      const count = await pw.count();
      if (count === 0) throw new Error("no matching elements");
      attempts.push({ strategy: candidate.strategy, ok: true });
      return { locator: pw, strategyUsed: candidate, attempts };
    } catch (err: any) {
      attempts.push({ strategy: candidate.strategy, ok: false, error: String(err?.message ?? err) });
    }
  }
  throw new LocatorResolutionError("Could not resolve locator via any strategy", attempts);
}

export class LocatorResolutionError extends Error {
  attempts: ResolvedLocator["attempts"];
  constructor(message: string, attempts: ResolvedLocator["attempts"]) {
    super(message);
    this.name = "LocatorResolutionError";
    this.attempts = attempts;
  }
}

export type ActionExecResult = ActionResult & { attempts?: ResolvedLocator["attempts"] };

export async function doClick(page: Page, robust: RobustLocator): Promise<ActionExecResult> {
  const resolved = await resolveLocator(page, robust);
  await resolved.locator.first().click();
  return { ok: true, attempts: resolved.attempts };
}

export async function doType(page: Page, robust: RobustLocator, text: string): Promise<ActionExecResult> {
  const resolved = await resolveLocator(page, robust);
  await resolved.locator.first().fill(text);
  return { ok: true, attempts: resolved.attempts };
}

export async function doSelect(page: Page, robust: RobustLocator, value: string): Promise<ActionExecResult> {
  const resolved = await resolveLocator(page, robust);
  await resolved.locator.first().selectOption(value);
  return { ok: true, attempts: resolved.attempts };
}

export async function doExtract(page: Page, robust: RobustLocator): Promise<ActionExecResult> {
  const resolved = await resolveLocator(page, robust);
  const text = (await resolved.locator.first().textContent()) ?? "";
  return { ok: true, observed: text.trim(), attempts: resolved.attempts };
}

export async function doNavigate(page: Page, url: string): Promise<ActionResult> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { ok: true, observed: page.url() };
}

