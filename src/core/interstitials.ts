import type { Page } from "playwright";
import type { Checkpoint } from "./artifact.js";
import type { RobustLocator } from "./types.js";
import { checkpointHolds } from "./checkpoint.js";
import { doClick } from "./actions.js";

/**
 * Interstitials that can appear at unpredictable points and aren't part of
 * any specific capability's business flow (a session-liveness check, a
 * "you're about to leave" dialog, an MOTD). Unlike a capability's own
 * `knownOutcomes`, these are dismissed automatically -- by the replay
 * engine *and* the discovery agent -- rather than becoming a recorded step
 * or costing the LLM a decision. This is the "recoverable condition"
 * category from the error taxonomy: transient, expected, safe to handle
 * without asking anyone.
 */
export interface KnownInterstitial {
  code: string;
  detect: Checkpoint;
  dismiss: RobustLocator;
}

export const defaultInterstitials: KnownInterstitial[] = [
  {
    code: "SESSION_CHECK",
    detect: { textContains: "please confirm this session is still active" },
    dismiss: { primary: { strategy: "role", role: "button", name: "Continue" }, fallbacks: [] },
  },
];

/** Dismiss any currently-showing known interstitial(s), bounded to avoid looping forever. */
export async function dismissKnownInterstitials(
  page: Page,
  interstitials: KnownInterstitial[] = defaultInterstitials,
  onDismiss?: (code: string) => void,
  maxRounds = 3
): Promise<boolean> {
  let dismissedAny = false;
  for (let round = 0; round < maxRounds; round++) {
    let dismissedThisRound = false;
    for (const it of interstitials) {
      if (await checkpointHolds(page, it.detect)) {
        await doClick(page, it.dismiss).catch(() => undefined);
        onDismiss?.(it.code);
        dismissedAny = true;
        dismissedThisRound = true;
      }
    }
    if (!dismissedThisRound) break;
  }
  return dismissedAny;
}
