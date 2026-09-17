import { test, expect } from "bun:test";
import { OpenCode2 } from "../src/opencode2";
import { discoverConnection, probeService, waitForPlugins } from "../src/service-connection";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { policy, workerPlugins } from "../src/permissions";
import { Bridge } from "../src/delegate";
import { ConfigSchema } from "../src/config";
import { fixture, dispose } from "./helpers";

test("connects to the status API after the health endpoint was removed", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/api/status"
        ? Response.json({ version: "2.0.5", pid: process.pid, urls: [] })
        : Response.json("Not Found", { status: 404 });
    },
  });
  const previous = process.env.OPENCODE_SERVER_URL;
  process.env.OPENCODE_SERVER_URL = server.url.toString();
  try {
    const client = await new OpenCode2().client();
    expect((await client.health.get()).version).toBe("2.0.5");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_URL;
    else process.env.OPENCODE_SERVER_URL = previous;
    server.stop(true);
  }
});

for (const protocol of ["health", "status"] as const) {
  test(`${protocol} API runs isolated variants, waits, reviews patches, and cleans up`, async () => {
    const repo = await fixture();
    const base = await mkdtemp("/tmp/oc-protocol-test-");
    const requests: string[] = [];
    let ready = false;
    let activationCalls = 0;
    let session: { id: string; model: object; location: { directory: string } };
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (path === `/api/${protocol}`) return Response.json({ version: protocol === "status" ? "2.0.5" : "2.0.3", healthy: true, pid: process.pid });
        if (path === (protocol === "health" ? "/api/plugin/await-activation" : "/api/plugin")) {
          ready = protocol === "health" || ++activationCalls > 1;
          return protocol === "health" ? new Response(null, { status: 204 }) : Response.json({ data: ready ? workerPlugins.map(id => ({ id, state: { status: "active" } })) : [] });
        }
        if (path === "/api/model") {
          expect(ready).toBe(true);
          return Response.json({ data: [{ id: "fixture", modelID: "fixture", providerID: "opencode", enabled: true,
            capabilities: { tools: true, input: ["text"] }, cost: [], variants: [{ id: "xhigh", settings: { reasoningEffort: "xhigh" } }] }] });
        }
        if (path.startsWith("/api/agent/")) {
          expect(ready).toBe(true);
          return Response.json({ data: { mode: "primary", permissions: policy("write_isolated", ["a.txt"]) } });
        }
        if (path === "/api/session" && request.method === "POST") {
          session = await request.json() as typeof session;
          expect(session.model).toMatchObject({ variant: "xhigh" });
          return Response.json({ data: session });
        }
        if (path.endsWith("/prompt")) {
          await writeFile(join(session.location.directory, "a.txt"), "protocol-tested\n");
          return Response.json({ data: {} });
        }
        const sessionPath = `/api/session/${session?.id}`;
        if (path === (protocol === "status" ? `/api/experimental/session/${session?.id}/wait` : `${sessionPath}/wait`)) return new Response(null, { status: 204 });
        if (path === sessionPath && request.method === "GET") return Response.json({ data: { ...session, outcome: "succeeded" } });
        if (path === sessionPath && request.method === "DELETE") return new Response(null, { status: 204 });
        if (path === `${sessionPath}/interrupt`) return Response.json({});
        if (path === `${sessionPath}/message`) return Response.json({ data: [{ type: "assistant", model: session.model,
          content: [{ type: "text", text: JSON.stringify({ summary: "done", findings: [], changes: [], tests: [], risks: [] }) }] }] });
        return Response.json("Not Found", { status: 404 });
      },
    });
    const previous = process.env.OPENCODE_SERVER_URL;
    process.env.OPENCODE_SERVER_URL = server.url.toString();
    const bridge = new Bridge(ConfigSchema.parse({}), new OpenCode2(), join(base, "state"), join(base, "cache"));
    try {
      const result = await bridge.delegate({ repoDir: repo, role: "implementer", mode: "write_isolated", scope: ["a.txt"], task: "write", variant: "xhigh" });
      expect(result.status).toBe("completed");
      expect(result.effectiveModel?.variant).toBe("xhigh");
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("base\n");
      const diff = await bridge.diff(result.id, 0, 48000);
      await bridge.apply(result.id, repo, diff.reviewToken!);
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("protocol-tested\n");
      await bridge.discard(result.id, false);
      expect(await bridge.state.list()).toEqual([]);
      expect(requests.some(r => r.includes(protocol === "status" ? "/api/experimental/session/" : "/wait"))).toBe(true);
      if (protocol === "status") expect(requests).not.toContain("POST /api/plugin/await-activation");
    } finally {
      await bridge.close();
      if (previous === undefined) delete process.env.OPENCODE_SERVER_URL; else process.env.OPENCODE_SERVER_URL = previous;
      server.stop(true); await dispose(repo); await dispose(base);
    }
  });
}

test("discovery validates auth and PID, and tolerates outdated registration version metadata", async () => {
  const base = await mkdtemp("/tmp/oc-registration-");
  const file = join(base, "service.json");
  let returnedPID = process.pid;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.headers.get("authorization")).toBe("Basic " + Buffer.from("opencode:fixture").toString("base64"));
    return Response.json({ version: "2.0.5", pid: returnedPID });
  } });
  try {
    expect(await discoverConnection({ file })).toBeUndefined();
    await writeFile(file, JSON.stringify({ url: server.url.toString(), pid: process.pid, version: "2.0.3", password: "fixture" }));
    expect((await discoverConnection({ file }))?.protocol).toBe("status");
    returnedPID++;
    await expect(discoverConnection({ file })).rejects.toThrow("PID does not match");
    await writeFile(file, "null");
    await expect(discoverConnection({ file })).rejects.toThrow("Invalid OpenCode service registration");
  } finally { server.stop(true); await rm(base, { recursive: true, force: true }); }
});

test("malformed responses, auth failures and unknown APIs fail clearly without unsafe fallback", async () => {
  let status = 200;
  let body: unknown = null;
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return Response.json(body, { status });
  } });
  const endpoint = { url: server.url.toString() };
  try {
    for (body of [null, "Not Found", true, [], { version: "2.0.5", pid: "123" }])
      await expect(probeService(endpoint)).rejects.toThrow("response shape");
    status = 401; paths.length = 0;
    await expect(probeService(endpoint)).rejects.toThrow("HTTP 401");
    expect(paths).toEqual(["/api/status"]);
    status = 404;
    await expect(probeService(endpoint)).rejects.toThrow("neither /api/status nor /api/health");
    await expect(probeService({ url: "https://example.com" })).rejects.toThrow("loopback");
  } finally { server.stop(true); }
});

test("a running bridge renegotiates protocol after a service upgrade without restarting it", async () => {
  let modern = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== (modern ? "/api/status" : "/api/health")) return Response.json("Not Found", { status: 404 });
    return Response.json({ version: modern ? "2.0.5" : "2.0.3", healthy: true, pid: process.pid });
  } });
  const previous = process.env.OPENCODE_SERVER_URL;
  process.env.OPENCODE_SERVER_URL = server.url.toString();
  try {
    const runtime = new OpenCode2();
    const old = await runtime.client();
    expect(old.protocol).toBe("health");
    expect(await runtime.client()).toBe(old);
    modern = true;
    const current = await runtime.client();
    expect(current.protocol).toBe("status");
    expect(current).not.toBe(old);
    expect((await current.health.get()).version).toBe("2.0.5");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_URL; else process.env.OPENCODE_SERVER_URL = previous;
    server.stop(true);
  }
});

test("readiness fails on required plugin errors and respects cancellation", async () => {
  const input = { location: { directory: "/tmp/fixture" } };
  await expect(waitForPlugins({ list: async () => ({ location: input.location, data: [
    { id: "required", source: { type: "builtin" }, features: {}, state: { status: "failed", error: "fixture" } },
  ] }) }, input, ["required"])).rejects.toThrow("Required OpenCode plugin required failed");
  const controller = new AbortController();
  let calls = 0;
  const waiting = waitForPlugins({ list: async () => { calls++; return { location: input.location, data: [] }; } }, input, ["required"], controller.signal);
  const reason = new Error("cancel readiness");
  controller.abort(reason);
  await expect(waiting).rejects.toBe(reason);
  expect(calls).toBe(1);
});
