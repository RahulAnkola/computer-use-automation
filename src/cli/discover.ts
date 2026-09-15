import "dotenv/config";
import { parseArgs } from "./args.js";
import { startServer } from "../mock-app/server.js";
import { runDiscovery } from "../agent/discover.js";
import { capabilityDefs, attachKnownOutcomes } from "../capabilities/registry.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function goalFor(capability: string, memberId: string, accountType: string, depositAmount: string): string {
  if (capability === "bankops.open_sub_account_large_deposit") {
    return `Look up member ${memberId} in BankOps Console and open a new ${accountType} sub-account with an initial deposit of $${depositAmount}. This exceeds the self-service limit and will require manager approval -- you must not approve it yourself. Reach the confirmation screen and report the new sub-account id and confirmed balance.`;
  }
  return `Look up member ${memberId} in BankOps Console and open a new ${accountType} sub-account with an initial deposit of $${depositAmount}. Reach the confirmation screen and report the new sub-account id and confirmed balance.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capability = args.capability ?? "bankops.open_sub_account";
  const def = capabilityDefs[capability];
  if (!def) {
    console.error(`Unknown capability "${capability}". Known: ${Object.keys(capabilityDefs).join(", ")}`);
    process.exit(1);
  }

  const memberId = args.member ?? "10023";
  const accountType = args["account-type"] ?? "Sub-Savings";
  const depositAmount = args.amount ?? "500";
  const port = Number(args.port ?? 4173);
  const startServerFlag = args["no-start-server"] !== "true";
  const headless = args.headful !== "true";

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set. Put it in .env (see .env.example) or export it in your shell.");
    process.exit(1);
  }
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  let server: import("node:http").Server | undefined;
  if (startServerFlag) {
    server = startServer(port);
    await new Promise((resolve) => server!.once("listening", resolve));
    console.log(`Mock BankOps Console listening on http://localhost:${port}`);
  }

  const runId = `discover-${capability.replace(/\./g, "_")}-${Date.now()}`;
  const evidenceDir = path.resolve(process.cwd(), "evidence", runId);
  await mkdir(evidenceDir, { recursive: true });

  const goal = goalFor(capability, memberId, accountType, depositAmount);

  console.log(`\n=== Discovery run: ${capability} ===`);
  console.log(`Goal: ${goal}`);
  console.log(`Evidence: ${evidenceDir}\n`);

  try {
    const result = await runDiscovery({
      runId,
      capabilityName: capability,
      description: def.description,
      goal,
      targetBaseUrl: `http://localhost:${port}`,
      startPath: def.startPath,
      paramValues: { memberId, accountType, depositAmount },
      paramSpecs: def.paramSpecs,
      outputSpecs: def.outputSpecs,
      headless,
      evidenceDir,
      model,
      apiKey,
    });

    if (result.status === "success" && result.artifact) {
      const artifact = attachKnownOutcomes(result.artifact);
      const artifactsDir = path.resolve(process.cwd(), "artifacts");
      await mkdir(artifactsDir, { recursive: true });
      const artifactPath = path.join(artifactsDir, `${capability}.json`);
      await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
      await writeFile(path.join(evidenceDir, "artifact.json"), JSON.stringify(artifact, null, 2), "utf8");
      console.log(`\nDiscovery succeeded: ${result.summary}`);
      console.log(`Saved capability artifact -> ${artifactPath}`);
      console.log(`Evidence (log + screenshots) -> ${evidenceDir}`);
      console.log(
        `\nReplay it with:\n  npm run replay -- --artifact artifacts/${capability}.json --member ${memberId} --account-type ${accountType} --amount ${depositAmount} --force\n`
      );
    } else {
      console.log(`\nDiscovery did not produce a capability: ${result.summary}`);
      process.exitCode = 1;
    }
  } finally {
    if (server) server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
