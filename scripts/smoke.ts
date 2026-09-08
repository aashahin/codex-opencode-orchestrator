import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenCode2 } from "../src/opencode2";
import { ROOT, paths, loadConfig, TaskSchema } from "../src/config";
import { git } from "../src/git";
import { snapshot, cleanup } from "../src/worktrees";
import { installPolicy, restorePolicy } from "../src/permissions";
import { errorText } from "../src/security";
import assert from "node:assert/strict";
const report: { [key: string]: unknown } = {
  date: new Date().toISOString(),
  runtime: "OpenCode2",
  model: "opencode/mimo-v2.5-free",
};
const repo = await mkdtemp("/tmp/oc2-smoke-");
await git(repo, ["init", "-q"]);
await writeFile(join(repo, "greeting.txt"), "hello\n");
await git(repo, ["add", "--", "greeting.txt"]);
await git(repo, [
  "-c",
  "user.name=Smoke",
  "-c",
  "user.email=smoke@localhost",
  "commit",
  "-qm",
  "fixture",
]);
const rt = new OpenCode2();
const c = await rt.client();
const healthBefore = await c.health.get();
const config = await loadConfig();
const client = new Client({ name: "orchestrator-live-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: Bun.which("bun")!,
  args: ["run", join(ROOT, "src/index.ts")],
  stderr: "pipe",
});
const ids: string[] = [];
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 240000,
  });
  assert(!response.isError, JSON.stringify(response.content));
  return response.structuredContent as any;
};
try {
  await client.connect(transport);
  report.mcpTools = (await client.listTools()).tools.map((t) => t.name);
  report.health = await call("oc_health");
  // Resolve actual V2 permissions without paying for a model turn.
  const permissionResults = [];
  for (const mode of ["read_only", "write_isolated"] as const) {
    const id = randomUUID(),
      state = join(paths.state, "smoke", id);
    const s = await snapshot(repo, id, config, state);
    const task = TaskSchema.parse({
      repoDir: repo,
      task: "permission checks",
      role: mode === "read_only" ? "explorer" : "implementer",
      mode,
    });
    let sessionID: string | undefined;
    try {
      const agent = await installPolicy(s.worktree, state, task, id);
      const location = { directory: s.worktree };
      await c.plugin.awaitActivation({ location });
      const session = await c.session.create({
        agent,
        location,
        model: { id: "mimo-v2.5-free", providerID: "opencode" },
      });
      sessionID = session.id;
      for (const [action, resource, effect] of [
        ["read", "greeting.txt", "allow"],
        ["edit", "greeting.txt", mode === "read_only" ? "deny" : "allow"],
        ["shell", "git push origin main", "deny"],
        ["shell", "touch /tmp/escape", "deny"],
        ["subagent", "build", "deny"],
        ["external_directory", "/tmp/*", "deny"],
        ["edit", "/tmp/escape", "deny"],
        ["edit", ".git/config", "deny"],
      ]) {
        const check = await c.permission.create(
          { sessionID: session.id, action: action!, resources: [resource!] },
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(check.effect, effect);
        permissionResults.push({
          mode,
          action,
          resource,
          effect: check.effect,
        });
      }
    } finally {
      if (sessionID) await c.session.remove({ sessionID });
      await restorePolicy(s.worktree, state);
      await cleanup(s);
      await rm(state, { recursive: true, force: true });
    }
  }
  report.v2Permissions = permissionResults;
  console.log("V2 native permission checks passed");
  const basic = { repoDir: repo, model: report.model, timeoutSeconds: 120 };
  const readonly = await call("oc_delegate", {
    ...basic,
    role: "explorer",
    task: "Read greeting.txt. Report the word it contains as a FACT. Do not modify any file.",
  });
  ids.push(readonly.id);
  report.readOnly = {
    status: readonly.status,
    tools: readonly.tools,
    warnings: readonly.warnings,
  };
  assert.equal(readonly.status, "completed");
  assert(
    readonly.tools.some(
      (t: any) => t.name === "read" && t.status === "completed",
    ),
  );
  assert.equal(await readFile(join(repo, "greeting.txt"), "utf8"), "hello\n");
  console.log("Read-only V2 worker passed");
  const impl = await call("oc_delegate", {
    ...basic,
    role: "implementer",
    mode: "write_isolated",
    scope: ["greeting.txt"],
    task: "Read greeting.txt, then change its contents from hello to exactly hello from worker followed by a newline. Use the write or edit tool. This is the entire implementation task.",
  });
  ids.push(impl.id);
  report.implementation = {
    status: impl.status,
    changedFiles: impl.changedFiles,
    tools: impl.tools,
    warnings: impl.warnings,
  };
  assert.equal(impl.status, "completed");
  assert.equal(impl.patchAvailable, true);
  assert.deepEqual(impl.changedFiles, ["greeting.txt"]);
  assert.equal(await readFile(join(repo, "greeting.txt"), "utf8"), "hello\n");
  const diff = await call("oc_worker_diff", { id: impl.id });
  assert(diff.patch.includes("+hello from worker"));
  const applied = await call("oc_apply_worker_patch", {
    id: impl.id,
    repoDir: repo,
    reviewToken: diff.reviewToken,
  });
  assert.equal(applied.status, "applied");
  assert.equal(
    await readFile(join(repo, "greeting.txt"), "utf8"),
    "hello from worker\n",
  );
  report.patchIntegration = "passed";
  console.log("Isolated edit, patch inspection and application passed");
  const tasks = ["A", "B"].map((label) => ({
    ...basic,
    role: "explorer",
    task: `Read greeting.txt and report its first word. Your independent task label is ${label}.`,
  }));
  const sequentialStart = Date.now();
  for (const task of tasks) {
    const r = await call("oc_delegate", task);
    ids.push(r.id);
    assert.equal(r.status, "completed");
  }
  const sequentialMs = Date.now() - sequentialStart;
  const concurrent = await call("oc_delegate_parallel", {
    tasks,
    concurrency: 2,
  });
  for (const r of concurrent.results) {
    ids.push(r.id);
    assert.equal(r.status, "completed");
  }
  const sessions = await Promise.all(
    concurrent.results.map((r: any) =>
      c.session.get({ sessionID: r.sessionID }),
    ),
  );
  const ranges = await Promise.all(
    concurrent.results.map(async (r: any) => {
      const page = await c.message.list({
        sessionID: r.sessionID,
        limit: 200,
        order: "asc",
      });
      const assistant = page.data.filter((m) => m.type === "assistant");
      return {
        sessionID: r.sessionID,
        start: Math.min(...assistant.map((m) => m.time.created)),
        end: Math.max(
          ...assistant.map((m) => m.time.completed ?? m.time.created),
        ),
      };
    }),
  );
  assert.equal(new Set(sessions.map((s) => s.id)).size, 2);
  assert.equal(new Set(sessions.map((s) => s.location.directory)).size, 2);
  const overlapMs =
    Math.min(...ranges.map((r) => r.end)) -
    Math.max(...ranges.map((r) => r.start));
  const sessionOverlapMs =
    Math.min(...sessions.map((s) => s.time.idle ?? s.time.updated)) -
    Math.max(...sessions.map((s) => s.time.created));
  assert(sessionOverlapMs > 0, "V2 session execution lifetimes must overlap");
  report.benchmark = {
    sequentialMs,
    parallelMs: concurrent.elapsedMs,
    modelResponseOverlapMs: overlapMs,
    sessionOverlapMs,
    ranges,
    note: "Diagnostic timings; speed ratio is not a test assertion",
  };
  const after = await c.health.get();
  assert.equal(after.pid, healthBefore.pid);
  report.sharedService = { pid: after.pid, reused: true };
  report.status = "passed";
  console.log("Parallel sessions and shared service reuse passed");
} catch (e) {
  report.status = "failed";
  report.error = errorText(e);
  process.exitCode = 1;
  console.error(errorText(e));
} finally {
  for (const id of ids)
    await call("oc_discard_worker", { id, discardPatch: true }).catch(() => {});
  await client.close();
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  await writeFile(
    join(paths.state, "live-smoke.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    join(ROOT, "LIVE-TESTS.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  if (report.status === "passed")
    await rm(repo, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
