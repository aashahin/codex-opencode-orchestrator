import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { OpenCode as LegacyOpenCode } from "@opencode/client-legacy";
import { Service, type Endpoint } from "@opencode/client/service";
import { assertSupportedService } from "./service-version";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenCodeClient } from "@opencode/client";

export type Protocol = "status" | "health";
export interface ServiceHealth { healthy: boolean; version: string; pid: number }
export interface Connection {
  endpoint: Endpoint;
  protocol: Protocol;
  health: ServiceHealth;
}

function localEndpoint(endpoint: Endpoint): Endpoint {
  const url = new URL(endpoint.url);
  if (url.username || url.password || url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("OpenCode service must use a loopback HTTP endpoint without URL credentials");
  return endpoint;
}

function healthBody(value: unknown, protocol: Protocol): ServiceHealth {
  if (typeof value !== "object" || value === null ||
      !("version" in value) || typeof value.version !== "string" ||
      !("pid" in value) || typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0)
    throw Error(`OpenCode ${protocol} endpoint returned an unsupported response shape`);
  if (protocol === "health" && (!("healthy" in value) || typeof value.healthy !== "boolean"))
    throw Error("OpenCode health endpoint omitted its health flag");
  return { healthy: protocol === "status" || ("healthy" in value && value.healthy === true), version: value.version, pid: value.pid };
}

/** Probe read-only capabilities; never infer an API generation from a patch number. */
export async function probeService(endpoint: Endpoint, signal?: AbortSignal): Promise<Connection> {
  localEndpoint(endpoint);
  for (const protocol of ["status", "health"] as const) {
    const response = await fetch(new URL(`/api/${protocol}`, endpoint.url), {
      headers: Service.headers(endpoint),
      signal: signal ?? AbortSignal.timeout(10000),
      redirect: "error",
    });
    // Only an absent route permits probing the older API. Never bypass auth failures.
    if (response.status === 404) { await response.body?.cancel(); continue; }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`OpenCode ${protocol} probe returned HTTP ${response.status}; existing service was not restarted`);
    }
    let body: unknown;
    try { body = await response.json(); }
    catch { throw Error(`OpenCode ${protocol} endpoint did not return JSON`); }
    const health = healthBody(body, protocol);
    assertSupportedService(health);
    return { endpoint, protocol, health };
  }
  throw Error("OpenCode API is incompatible: neither /api/status nor /api/health is available; existing service was not restarted");
}

/** Read the documented XDG registration contract, keeping credentials in memory. */
export async function discoverConnection(options: { url?: string; file?: string } = {}): Promise<Connection | undefined> {
  if (options.url) return probeService({ url: options.url });
  const file = options.file ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "opencode/service.json");
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw Error("Cannot read OpenCode service registration; existing service was not restarted");
  }
  let info: { url: string; pid: number; password?: string };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.url !== "string" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        (value.password !== undefined && typeof value.password !== "string")) throw Error();
    info = value;
  } catch { throw Error("Invalid OpenCode service registration; existing service was not restarted"); }
  const endpoint = localEndpoint({ url: info.url, auth: info.password === undefined ? undefined : { type: "basic", username: "opencode", password: info.password } });
  try { process.kill(info.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw Error("Cannot verify registered OpenCode process; existing service was not restarted");
  }
  const connection = await probeService(endpoint);
  if (connection.health.pid !== info.pid)
    throw Error("OpenCode registration PID does not match the responding service; refusing stale endpoint");
  return connection;
}

export function compatibleClient(connection: Connection) {
  const options = { baseUrl: connection.endpoint.url, headers: Service.headers(connection.endpoint) };
  const client = connection.protocol === "status" ? OpenCode.make(options) : LegacyOpenCode.make(options);
  return {
    protocol: connection.protocol,
    health: { get: async (options?: { signal?: AbortSignal }) => (await probeService(connection.endpoint, options?.signal)).health },
    plugin: {
      awaitActivation: async (input: { location: { directory: string } }, options?: { signal?: AbortSignal; requiredPlugins?: string[] }) => {
        if ("awaitActivation" in client.plugin) await client.plugin.awaitActivation(input, options);
        else {
          // Both location.get and plugin.list can return before activation completes.
          await waitForPlugins(client.plugin, input, options?.requiredPlugins ?? ["opencode.models.dev", "opencode.provider.opencode"], options?.signal);
        }
      },
    },
    agent: { get: client.agent.get },
    model: { list: client.model.list },
    integration: { list: client.integration.list },
    session: {
      create: client.session.create,
      prompt: client.session.prompt,
      get: client.session.get,
      wait: client.session.wait,
      interrupt: client.session.interrupt,
      remove: client.session.remove,
      active: client.session.active,
    },
    message: { list: client.message.list },
    permission: { create: client.permission.create },
  };
}
export type CompatibleClient = ReturnType<typeof compatibleClient>;

export async function waitForPlugins(
  plugins: Pick<OpenCodeClient["plugin"], "list">,
  input: { location: { directory: string } },
  required: string[],
  parent?: AbortSignal,
) {
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(parent ? [parent] : [])]);
  for (;;) {
    signal.throwIfAborted();
    const { data } = await plugins.list(input, { signal });
    const pending = required.filter(id => !data.some(p => p.id === id && p.state.status === "active"));
    for (const id of pending) {
      const failed = data.find(p => p.id === id && p.state.status === "failed");
      if (failed) throw Error(`Required OpenCode plugin ${id} failed to activate`);
    }
    if (!pending.length) return;
    try { await delay(100, undefined, { signal }); }
    catch {
      parent?.throwIfAborted();
      throw Error(`OpenCode plugins did not become ready within 30 seconds: ${pending.join(", ")}`);
    }
  }
}
