import { parseArgs } from "./args.js";
import { listInterventions, resolveIntervention } from "../core/escalation.js";
import { attachToSharedSession, hasActiveSession } from "../core/session.js";
import { doClick } from "../core/actions.js";

/**
 * Stand-in for a human operator's console. In production this would be a UI
 * where a real person sees the intervention queue and clicks into a live
 * co-browsing view. Here it is a CLI, run as a *separate process* from the
 * agent/replay run -- which is the point: it attaches to the SAME live
 * browser session over CDP (see core/session.ts) rather than a fresh one,
 * proving control transfer actually happens rather than being described.
 *
 * Usage:
 *   npm run operator -- list
 *   npm run operator -- approve <id> --note "Approved manager override"
 *   npm run operator -- abort <id> --note "Could not resolve safely"
 */
async function main() {
  const [cmd, id] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(2));

  if (cmd === "list") {
    const items = await listInterventions();
    if (items.length === 0) {
      console.log("No interventions on file.");
      return;
    }
    for (const item of items) {
      console.log(
        `[${item.status}] ${item.id}  capability=${item.capability}  step=${item.currentStepId ?? "-"}\n` +
          `    reason: ${item.reason}\n    url: ${item.currentUrl}\n    screenshot: ${item.screenshotPath ?? "-"}`
      );
    }
    return;
  }

  if (cmd === "approve" || cmd === "abort") {
    if (!id) {
      console.error("Usage: operator approve|abort <intervention-id> [--note \"...\"]");
      process.exit(1);
    }
    const note = args.note ?? (cmd === "approve" ? "Operator approved manager override in the live session." : "Operator aborted the run.");

    if (cmd === "approve") {
      if (!(await hasActiveSession())) {
        console.error(
          "No active session found. The discovery/replay run that raised this intervention must still be " +
            "paused and waiting -- start it (or check it hasn't already timed out) before approving."
        );
        process.exit(1);
      }
      // Take control of the live session and perform the actual manual step
      // a human operator would perform: click the manager-only approval
      // control that the agent was blocked (by policy) from clicking itself.
      const { page } = await attachToSharedSession();
      console.log(`Attached to live session at ${page.url()}`);
      await doClick(page, { primary: { strategy: "role", role: "button", name: "Approve as Manager" }, fallbacks: [] });
      console.log("Clicked \"Approve as Manager\" in the live session as the human operator.");
    }

    const resolved = await resolveIntervention(id, {
      resolvedAt: new Date().toISOString(),
      operator: "operator-cli (stand-in for a human operator)",
      action: note,
      outcome: cmd === "approve" ? "resumed" : "aborted",
    });
    console.log(`Intervention ${resolved.id} marked ${resolved.status} (${resolved.resolution?.outcome}).`);
    return;
  }

  console.log("Usage:\n  operator list\n  operator approve <id> [--note \"...\"]\n  operator abort <id> [--note \"...\"]");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
