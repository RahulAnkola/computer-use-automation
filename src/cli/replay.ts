import "dotenv/config";
import { parseArgs } from "./args.js";
import { startServer } from "../mock-app/server.js";
import { replayArtifact } from "../replay/executor.js";
import { parseArtifact } from "../core/artifact.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact ?? "artifacts/bankops.open_sub_account.json";
  const port = Number(args.port ?? 4173);
  const startServerFlag = args["no-start-server"] !== "true";

  const raw = JSON.parse(await readFile(path.resolve(process.cwd(), artifactPath), "utf8"));
  const artifact = parseArtifact(raw);

  const inputs: Record<string, string> = {};
  if (args.member) inputs.memberId = args.member;
  if (args["account-type"]) inputs.accountType = args["account-type"];
  if (args.amount) inputs.depositAmount = args.amount;

  let server: import("node:http").Server | undefined;
  if (startServerFlag) {
    server = startServer(port);
    await new Promise((resolve) => server!.once("listening", resolve));
    console.log(`Mock BankOps Console listening on http://localhost:${port}`);
  }

  const runId = `replay-${artifact.name.replace(/\./g, "_")}-${Date.now()}`;
  const evidenceDir = path.resolve(process.cwd(), "evidence", runId);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "inputs.json"), JSON.stringify(inputs, null, 2), "utf8");

  console.log(`\n=== Replay run: ${artifact.name} v${artifact.version} ===`);
  console.log(`Inputs: ${JSON.stringify(inputs)}`);
  console.log(`Evidence: ${evidenceDir}\n`);

  try {
    const result = await replayArtifact(artifact, {
      runId,
      inputs,
      evidenceDir,
      force: args.force === "true",
    });
    await writeFile(path.join(evidenceDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
    console.log(`\nResult: ${JSON.stringify(result, null, 2)}`);
    if (result.status === "error") process.exitCode = 2;
  } finally {
    if (server) server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
