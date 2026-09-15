import type { Page } from "playwright";
import { resolveLocator } from "./actions.js";
import type { Checkpoint } from "./artifact.js";
import type { RobustLocator } from "./types.js";

/** Evaluate whether a checkpoint condition currently holds on the page. */
export async function checkpointHolds(page: Page, checkpoint: Checkpoint | undefined): Promise<boolean> {
  if (!checkpoint) return true;
  if (checkpoint.urlContains && !page.url().includes(checkpoint.urlContains)) return false;
  if (checkpoint.textContains) {
    const found = await page
      .getByText(checkpoint.textContains, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (!found) return false;
  }
  if (checkpoint.locatorPresent) {
    try {
      await resolveLocator(page, checkpoint.locatorPresent as unknown as RobustLocator, 1500);
    } catch {
      return false;
    }
  }
  return true;
}
