// Opt-in live test. All model work and patch integration go through MCP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../src/config";
import { errorText } from "../src/security";
import { fixture, dispose } from "../tests/helpers";

const model = process.env.OC_SMOKE_MODEL || "opencode/muse-spark-1.3-contributor-free";
const variant = process.env.OC_SMOKE_VARIANT || "xhigh";
const effort = process.env.OC_SMOKE_EFFORT || "high";
const repo = await fixture();
const marker = `stable-${randomUUID()}`;
await writeFile(join(repo, "a.txt"), `${marker}\n`);
const client = new Client({ name: "stable-variant-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: Bun.which("bun")!,
  args: ["run", join(ROOT, "src/index.ts")],
  stderr: "pipe",
});
const report: Record<string, unknown> = { date: new Date().toISOString(), model, variant, effort };
const ids: string[] = [];
let connected = false;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 210000 });
  assert(!response.isError, JSON.stringify(response.content));
  assert(response.structuredContent, "Missing MCP structured response");
  return response.structuredContent as Record<string, any>;
};
try {
  await client.connect(transport);
  connected = true;
  const health = await call("oc_health");
  assert.equal(health.bridge.connected, true);
  report.runtime = health.opencode2.version;
  const before = await call("oc_list_workers");
  report.existingWorkers = before.workers.length;
  const catalog = await call("oc_models");
  const selected = catalog.models.find((m: any) => m.key === model);
  assert(selected?.variants.some((v: any) => v.id === variant), "Requested variant unavailable");
  assert(selected.variants.some((v: any) => v.reasoningEffort === effort), "Requested effort unavailable");
  const common = { repoDir: repo, model, timeoutSeconds: 180 };
  const parallel = await call("oc_delegate_parallel", {
    concurrency: 2,
    tasks: [
      { ...common, role: "explorer", variant, task: "Read a.txt and include its exact contents in the final JSON summary. Do not edit any files." },
      { ...common, role: "implementer", mode: "write_isolated", scope: ["a.txt"], reasoningEffort: effort,
        task: "Read a.txt. Change its contents to exactly stable worker passed followed by a newline. Use the edit or write tool. Do not modify other files." },
    ],
  });
  for (const result of parallel.results) if (result.id) ids.push(result.id);
  const [reader, writer] = parallel.results;
  assert.equal(reader.status, "completed", reader.warnings?.join("; "));
  assert.equal(writer.status, "completed", writer.warnings?.join("; "));
  assert.equal(reader.effectiveModel.variant, variant);
  assert.equal(reader.selectedModel.variant, variant);
  assert.equal(reader.requestedVariant, variant);
  assert.equal(writer.requestedReasoningEffort, effort);
  assert.equal(writer.effectiveModel.variant, writer.selectedModel.variant);
  assert(reader.summary.includes(marker), "Reader did not report the fixture marker");
  assert(reader.tools.some((t: any) => t.name === "read" && t.status === "completed"));
  assert.deepEqual(reader.changedFiles, []);
  assert.deepEqual(writer.changedFiles, ["a.txt"]);
  assert.equal(await readFile(join(repo, "a.txt"), "utf8"), `${marker}\n`);
  const recovered = await call("oc_list_workers");
  assert.equal(recovered.workers.find((w: any) => w.id === reader.id).effectiveModel.variant, variant);
  const diff = await call("oc_worker_diff", { id: writer.id });
  assert(diff.patch.includes("+stable worker passed"));
  assert(diff.reviewToken, "Small patch should be fully reviewed in one page");
  const applied = await call("oc_apply_worker_patch", { id: writer.id, repoDir: repo, reviewToken: diff.reviewToken });
  assert.equal(applied.status, "applied");
  assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "stable worker passed\n");
  assert.equal((await call("oc_health")).opencode2.pid, health.opencode2.pid);
  report.status = "passed";
  report.selections = [reader, writer].map(r => ({ requestedVariant: r.requestedVariant, requestedReasoningEffort: r.requestedReasoningEffort, effectiveModel: r.effectiveModel }));
  report.patchIntegration = "passed";
  report.sharedServiceReused = true;
} catch (error) {
  report.status = "failed";
  report.error = errorText(error);
  process.exitCode = 1;
} finally {
  let cleaned = connected;
  if (connected) {
    // Recover IDs even if a transport failure hid the delegation result.
    try {
      const retained = await call("oc_list_workers");
      for (const w of retained.workers) if (w.repo === repo && !ids.includes(w.id)) ids.push(w.id);
    } catch { cleaned = false; }
    for (const id of ids) {
      try {
        const result = await call("oc_discard_worker", { id });
        if (result.status !== "discarded") cleaned = false;
      } catch { cleaned = false; }
    }
  }
  await client.close();
  if (cleaned) await dispose(repo);
  report.cleanup = cleaned ? "discarded" : "preserved";
  if (!cleaned) { report.retainedRepository = repo; process.exitCode = 1; }
  await writeFile(join(ROOT, "STABLE-TESTS.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
