import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArtifact } from "../core/artifact.js";
import { parseArgs } from "./args.js";
import { replayArtifact } from "../replay/executor.js";
import { startServer } from "../mock-app/server.js";

/**
 * Stretch goal: agent-facing capability interface. Lists saved artifacts as
 * a small callable catalog (name, description, typed inputs/outputs) the
 * way an AI agent's tool-use layer would discover them, and can invoke one
 * by name with typed args -- exercising the exact same replay path `npm run
 * replay` uses, just addressed by capability name instead of a file path.
 *
 * Usage:
 *   npm run catalog -- list
 *   npm run catalog -- invoke bankops.open_sub_account --memberId 10023 --accountType Sub-Savings --depositAmount 500
 */
async function loadCatalog() {
  const dir = path.resolve(process.cwd(), "artifacts");
  const files = await readdir(dir).catch(() => [] as string[]);
  const artifacts = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map(async (f) => parseArtifact(JSON.parse(await readFile(path.join(dir, f), "utf8"))))
  );
  return artifacts;
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(2));
  const catalog = await loadCatalog();

  if (cmd === "list" || !cmd) {
    for (const a of catalog) {
      console.log(`\n${a.name} (v${a.version}, ${a.approvalStatus}, risk=${a.riskLevel})`);
      console.log(`  ${a.description}`);
      console.log(`  inputs:  ${a.inputs.map((i) => `${i.name}:${i.type}${i.required ? "" : "?"}`).join(", ")}`);
      console.log(`  outputs: ${a.outputs.map((o) => `${o.name}:${o.type}`).join(", ")}`);
      console.log(`  known outcomes: ${a.knownOutcomes.map((o) => o.code).join(", ") || "(none declared)"}`);
    }
    return;
  }

  if (cmd === "invoke") {
    const artifact = catalog.find((a) => a.name === name);
    if (!artifact) {
      console.error(`Unknown capability "${name}". Run "npm run catalog -- list" to see available capabilities.`);
      process.exit(1);
    }
    const inputs: Record<string, string> = {};
    for (const spec of artifact!.inputs) {
      const v = args[spec.name];
      if (v !== undefined) inputs[spec.name] = v;
    }

    const port = Number(args.port ?? 4173);
    const server = startServer(port);
    await new Promise((resolve) => server.once("listening", resolve));

    const runId = `invoke-${artifact!.name.replace(/\./g, "_")}-${Date.now()}`;
    const evidenceDir = path.resolve(process.cwd(), "evidence", runId);
    try {
      const result = await replayArtifact(artifact!, { runId, inputs, evidenceDir, force: args.force === "true" });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      server.close();
    }
    return;
  }

  console.log('Usage:\n  catalog list\n  catalog invoke <capability-name> --<param> <value> ...');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
