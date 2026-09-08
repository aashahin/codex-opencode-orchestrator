// Opt-in live regression: uses provider credits, never runs in automated CI.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { ROOT } from "../src/config";
import { OpenCode2 } from "../src/opencode2";
import { git } from "../src/git";
import { errorText } from "../src/security";
import { fixture, dispose } from "../tests/helpers";

const repo = await fixture();
const model = process.env.OC_SMOKE_MODEL || "opencode-go/muse-spark-1.3-contributor";
const files = Array.from({ length: 26 }, () => `${randomUUID()}.txt`);
const marker = `FINISH-${randomUUID()}`;
const client = new Client({ name: "tool-choice-regression", version: "1" });
const transport = new StdioClientTransport({
  command: Bun.which("bun")!,
  args: ["run", join(ROOT, "src/index.ts")],
  stderr: "pipe",
});
let workerID: string | undefined;
let cleaned = false;
const report: Record<string, unknown> = { date: new Date().toISOString(), model };
const WorkerOutcome = z.object({
  id: z.string(),
  status: z.string(),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  sessionID: z.string().optional(),
  warnings: z.array(z.string()),
});
try {
  for (let i = 0; i < files.length; i++)
    await writeFile(
      join(repo, files[i]!),
      i + 1 < files.length ? `Read next: ${files[i + 1]}\n` : `${marker}\n`,
    );
  await git(repo, ["add", "--", ...files]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "Read chain fixture"]);
  await client.connect(transport);
  const response = await client.callTool({
    name: "oc_delegate",
    arguments: {
      repoDir: repo,
      role: "explorer",
      mode: "read_only",
      model,
      timeoutSeconds: 300,
      task: `Follow the file chain starting with ${files[0]}. Read exactly one file per model step using only the read tool, then follow its Read next filename. Do not glob, grep, batch reads, edit files, or stop early. The final file contains a FINISH marker. Include that exact marker in your final JSON summary. This deliberately exercises more than 24 model steps.`,
    },
  }, undefined, { timeout: 330000 });
  assert(!response.isError, "MCP delegation failed");
  const result = WorkerOutcome.parse(response.structuredContent);
  workerID = result.id;
  assert.equal(result.status, "completed", errorText(new Error(result.warnings.join("; "))));
  assert(typeof result.summary === "string" && result.summary.includes(marker));
  assert.deepEqual(result.changedFiles, []);
  assert(typeof result.sessionID === "string");
  // Read-only diagnostics: all model execution above goes through oc_delegate.
  const c = await new OpenCode2().client();
  const messages = await c.message.list({ sessionID: result.sessionID, limit: 200, order: "asc" });
  const steps = messages.data.filter((m) => m.type === "assistant");
  const reads = steps.flatMap((m) => m.content).filter((p) => p.type === "tool" && p.name === "read");
  assert(steps.length > 24, "Regression must exceed the old step cap");
  assert(reads.length >= files.length, "Worker must read the complete chain");
  report.status = "passed";
  report.assistantSteps = steps.length;
  report.readCalls = reads.length;
  report.usedMcpDelegation = true;
} catch (e) {
  report.status = "failed";
  report.error = errorText(e);
  process.exitCode = 1;
} finally {
  if (workerID) {
    try {
      const r = await client.callTool({ name: "oc_discard_worker", arguments: { id: workerID } });
      const status = z.object({ status: z.string() }).safeParse(r.structuredContent);
      cleaned = !r.isError && status.success && status.data.status === "discarded";
    } catch { /* Preserve the source repository if cleanup cannot be confirmed. */ }
  }
  await client.close();
  if (cleaned) await dispose(repo);
  report.cleanup = cleaned ? "discarded" : "preserved";
  await writeFile(join(ROOT, "TOOL-CHOICE-TESTS.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
