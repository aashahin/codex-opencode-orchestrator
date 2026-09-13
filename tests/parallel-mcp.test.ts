import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Bridge } from "../src/delegate";
import { createMcp } from "../src/mcp";
import { ConfigSchema, type Task } from "../src/config";
import { parallel, Semaphore } from "../src/parallel";
import type { Model } from "../src/router";
import type { Runtime } from "../src/opencode2";
import { requestedModel } from "../src/reasoning";
import { fixture, dispose } from "./helpers";
import { RECOVERY_GUIDANCE, WORKFLOW_GUIDANCE } from "../src/guidance";
const m: Model = {
  id: "fixture",
  providerID: "opencode-go",
  modelID: "fixture",
  key: "opencode-go/fixture",
  vision: false,
  cost: 0,
  variants: [{ id: "xhigh", reasoningEffort: "xhigh" }],
};
class ControlledRuntime implements Runtime {
  active = 0;
  peak = 0;
  contexts: string[] = [];
  interruptions: string[] = [];
  async models() {
    return [m];
  }
  async health() {
    return { connected: true };
  }
  async remove() {}
  async interrupt(id: string) {
    this.interruptions.push(id);
  }
  async run(
    task: Task,
    model: Model,
    worktree: string,
    agent: string,
    signal: AbortSignal,
    onSession: (id: string) => Promise<void>,
  ) {
    await onSession(agent);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    this.contexts.push(worktree);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, task.task === "timeout" ? 3000 : 100);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      if (task.task === "fail") throw Error("Deliberate worker failure");
      if (task.mode === "write_isolated")
        await writeFile(join(worktree, "a.txt"), "isolated change\n");
      return {
        sessionID: agent,
        effectiveModel: requestedModel(model, task.reasoningEffort, task.variant),
        text: JSON.stringify({
          summary: "done",
          findings: [],
          changes: [],
          tests: [],
          risks: [],
        }),
        tools: [],
      };
    } finally {
      this.active--;
    }
  }
}
test("parallel execution actually overlaps, respects capacity, isolates failure and cancellation", async () => {
  let active = 0,
    peak = 0;
  const results = await parallel([1, 2, 3, 4], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(25);
    active--;
    if (n === 2) throw Error("bad");
    return n;
  });
  expect(peak).toBe(2);
  expect(results.filter((x) => x.status === "fulfilled").length).toBe(3);
  const gate = new Semaphore(1);
  const c = new AbortController();
  const one = gate.run(() => Bun.sleep(30));
  const queued = gate.run(async () => 42, c.signal);
  c.abort();
  await expect(queued).rejects.toThrow();
  await one;
  expect(await gate.run(async () => 7)).toBe(7);
});
test("delegation preserves isolated successful work through parallel failure and timeout", async () => {
  const repo = await fixture(),
    base = await mkdtemp("/tmp/oc-concurrency-");
  const rt = new ControlledRuntime();
  const b = new Bridge(
    ConfigSchema.parse({ parallelism: 2 }),
    rt,
    join(base, "state"),
    join(base, "cache"),
  );
  try {
    const result = await b.delegateParallel(
      [
        {
          repoDir: repo,
          task: "write",
          role: "implementer",
          mode: "write_isolated",
          variant: "xhigh",
        },
        { repoDir: repo, task: "fail" },
        { repoDir: repo, task: "timeout", timeoutSeconds: 1 },
      ],
      2,
    );
    expect(rt.peak).toBe(2);
    expect(new Set(rt.contexts).size).toBe(3);
    expect(result.results.map((r) => r.status)).toEqual([
      "completed",
      "failed",
      "timed_out",
    ]);
    expect((result.results[1] as any).recovery).toBe(RECOVERY_GUIDANCE);
    expect((result.results[2] as any).recovery).toBe(RECOVERY_GUIDANCE);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("base\n");
    const records = await b.state.list();
    for (const r of records) await b.discard(r.id, true);
    expect(rt.interruptions.length).toBeGreaterThan(0);
  } finally {
    await b.close();
    await dispose(repo);
    await dispose(base);
  }
}, 15000);
test("MCP schemas, structured responses and error validation through real MCP transport", async () => {
  const base = await mkdtemp("/tmp/oc-mcp-");
  const b = new Bridge(
    ConfigSchema.parse({}),
    new ControlledRuntime(),
    join(base, "state"),
    join(base, "cache"),
  );
  const server = createMcp(b);
  const client = new Client({ name: "test", version: "1" });
  const [a, c] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(c);
    expect(client.getInstructions()).toBe(WORKFLOW_GUIDANCE);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "oc_health",
        "oc_models",
        "oc_delegate",
        "oc_delegate_parallel",
        "oc_worker_diff",
        "oc_apply_worker_patch",
        "oc_discard_worker",
      ]),
    );
    const result = await client.callTool({ name: "oc_health", arguments: {} });
    expect(result.structuredContent).toEqual({ connected: true });
    const listed = await client.callTool({
      name: "oc_list_workers",
      arguments: {},
    });
    expect(listed.structuredContent).toEqual({ workers: [] });
    const missing = await client.callTool({
      name: "oc_worker_diff",
      arguments: { id: "00000000-0000-4000-8000-000000000000" },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("Never resume a raw ses_");
    const invalid = await client.callTool({
      name: "oc_delegate",
      arguments: { task: "x", repoDir: "/tmp", mode: "wrong" },
    });
    expect(invalid.isError).toBe(true);
    const repo = await fixture();
    try {
      const delegated = await client.callTool({
        name: "oc_delegate",
        arguments: {
          task: "write",
          repoDir: repo,
          role: "implementer",
          mode: "write_isolated",
          variant: "xhigh",
        },
      });
      const id = (delegated.structuredContent as any).id;
      expect((delegated.structuredContent as any).effectiveModel.variant).toBe("xhigh");
      const recovered = new Bridge(ConfigSchema.parse({}), new ControlledRuntime(), join(base, "state"), join(base, "cache"));
      try {
        const record = (await recovered.state.list()).find(r => r.id === id)!;
        expect(record.requestedVariant).toBe("xhigh");
        expect(record.selectedModel?.variant).toBe("xhigh");
        expect(record.effectiveModel?.variant).toBe("xhigh");
      } finally { await recovered.close(); }
      expect((delegated.structuredContent as any).patchAvailable).toBe(true);
      const diff = await client.callTool({
        name: "oc_worker_diff",
        arguments: { id },
      });
      const applied = await client.callTool({
        name: "oc_apply_worker_patch",
        arguments: {
          id,
          repoDir: repo,
          reviewToken: (diff.structuredContent as any).reviewToken,
        },
      });
      expect((applied.structuredContent as any).status).toBe("applied");
      await client.callTool({ name: "oc_discard_worker", arguments: { id } });
    } finally {
      await dispose(repo);
    }
  } finally {
    await client.close();
    await server.close();
    await b.close();
    await dispose(base);
  }
}, 15000);
test("runtime source has V2 network client and never starts a CLI per worker", async () => {
  const s = await Bun.file(
    new URL("../src/opencode2.ts", import.meta.url),
  ).text();
  expect(s).toContain('from "@opencode/client"');
  expect(s).not.toContain("@opencode-ai/sdk");
  expect(s).not.toMatch(/command\(\['opencode'/);
  expect(s).not.toContain("Service.ensure(");
  expect(s).toContain('"service", "start"');
  expect(s.slice(s.indexOf("async run("))).not.toContain("command(");
});

test("shutdown cancels queued workers before they create sessions", async () => {
  const repo = await fixture(),
    base = await mkdtemp("/tmp/oc-shutdown-");
  const rt = new ControlledRuntime();
  const b = new Bridge(
    ConfigSchema.parse({ parallelism: 1 }),
    rt,
    join(base, "state"),
    join(base, "cache"),
  );
  try {
    const one = b.delegate({ repoDir: repo, task: "timeout" });
    const two = b.delegate({
      repoDir: repo,
      task: "write",
      role: "implementer",
      mode: "write_isolated",
    });
    const settled = Promise.allSettled([one, two]);
    for (let i = 0; i < 200 && rt.contexts.length === 0; i++)
      await Bun.sleep(5);
    expect(rt.contexts.length).toBe(1);
    await b.close();
    await settled;
    expect(rt.contexts.length).toBe(1);
    for (const r of await b.state.list()) await b.discard(r.id);
  } finally {
    await b.close();
    await dispose(repo);
    await dispose(base);
  }
}, 10000);

test("default discard preserves unaccepted patches and their worktrees", async () => {
  const repo = await fixture(),
    base = await mkdtemp("/tmp/oc-preserve-");
  const b = new Bridge(
    ConfigSchema.parse({}),
    new ControlledRuntime(),
    join(base, "state"),
    join(base, "cache"),
  );
  try {
    const r = await b.delegate({
      repoDir: repo,
      task: "write",
      role: "implementer",
      mode: "write_isolated",
    });
    expect((await b.discard(r.id)).status).toBe("preserved");
    expect(await Bun.file(join(r.worktree!, "a.txt")).text()).toBe(
      "isolated change\n",
    );
    expect((await b.diff(r.id)).patchAvailable).toBe(true);
    await b.discard(r.id, true);
    expect(await Bun.file(join(r.worktree!, "a.txt")).exists()).toBe(false);
  } finally {
    await b.close();
    await dispose(repo);
    await dispose(base);
  }
});
