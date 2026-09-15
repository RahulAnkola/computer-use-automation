import type { Page } from "playwright";
import { resolveLocator } from "./actions.js";
import type { Checkpoint } from "./artifact.js";
import type { RobustLocator } from "./types.js";
import { renderRobustLocator, renderTemplate } from "./templating.js";

/**
 * Evaluate whether a checkpoint condition currently holds on the page.
 * `textContains`/`urlContains` are template strings just like locator
 * fields (e.g. `"/members/{{memberId}}"`) -- pass `params` to substitute
 * them before comparing. Checkpoints with no placeholders (like a known
 * interstitial's `detect`) can omit `params` entirely; rendering a
 * plain string with no `{{}}` is a no-op.
 */
export async function checkpointHolds(
  page: Page,
  checkpoint: Checkpoint | undefined,
  params: Record<string, string> = {}
): Promise<boolean> {
  if (!checkpoint) return true;
  if (checkpoint.urlContains && !page.url().includes(renderTemplate(checkpoint.urlContains, params))) return false;
  if (checkpoint.textContains) {
    const found = await page
      .getByText(renderTemplate(checkpoint.textContains, params), { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (!found) return false;
  }
  if (checkpoint.locatorPresent) {
    try {
      const rendered = renderRobustLocator(checkpoint.locatorPresent, params);
      await resolveLocator(page, rendered as RobustLocator, 1500);
    } catch {
      return false;
    }
  }
  return true;
}
