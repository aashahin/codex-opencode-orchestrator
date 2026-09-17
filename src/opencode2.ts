import {
  type ModelInfo,
  type SessionMessageAssistant,
} from "@opencode/client";
import { waitForSession } from "./session-wait";
import { requestedModel, verifyModelSelection } from "./reasoning";
import { randomUUID } from "node:crypto";
import { compatibleClient, discoverConnection, type CompatibleClient } from "./service-connection";
import { command } from "./git";
import { ROOT, VERSION, type Task, type Config } from "./config";
import { policy, decision, workerPlugins } from "./permissions";
import { contract } from "./prompts";
import { redact, errorText } from "./security";
import { mappings, type Model } from "./router";
import { recordProviderProbe, providerProbe } from "./diagnostics";
export interface RuntimeResult {
  text: string;
  sessionID: string;
  effectiveModel?: import("@opencode/client").ModelRef;
  tools: Array<{ name: string; status: string }>;
}
export interface Runtime {
  models(signal?: AbortSignal): Promise<Model[]>;
  run(
    task: Task,
    model: Model,
    worktree: string,
    agent: string,
    signal: AbortSignal,
    onSession: (id: string) => Promise<void>,
  ): Promise<RuntimeResult>;
  interrupt(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  health(config: Config): Promise<unknown>;
}
export class OpenCode2 implements Runtime {
  private connecting?: Promise<CompatibleClient>;
  private current?: CompatibleClient;
  private endpointIdentity?: string;
  private async connect(): Promise<CompatibleClient> {
    const options = { url: process.env.OPENCODE_SERVER_URL };
    let connection = await discoverConnection(options);
    if (!connection) {
      await command(
        [Bun.which("opencode") ?? Bun.which("opencode2") ?? "opencode", "service", "start"],
        { max: 4096 },
      );
      connection = await discoverConnection(options);
    }
    if (!connection) throw Error("OpenCode 2 shared service not available");
    const identity = JSON.stringify([connection.endpoint, connection.protocol, connection.health.pid, connection.health.version]);
    const client =
      this.current && this.endpointIdentity === identity
        ? this.current
        : compatibleClient(connection);
    this.endpointIdentity = identity;
    this.current = client;
    return client;
  }
  async client(): Promise<CompatibleClient> {
    if (!this.connecting)
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async models(signal?: AbortSignal) {
    const c = await this.client();
    const options = { signal: signal ?? AbortSignal.timeout(30000) };
    const input = { location: { directory: ROOT } };
    await c.plugin.awaitActivation(input, options);
    const response = await c.model.list(input, options);
    return response.data
      .filter(
        (m) =>
          m.enabled &&
          m.status !== "deprecated" &&
          m.capabilities.tools &&
          ["opencode-go", "opencode"].includes(m.providerID),
      )
      .map(normalizeModel);
  }
  async health(config: Config) {
    try {
      const c = await this.client();
      const health = await c.health.get({ signal: AbortSignal.timeout(10000) });
      const models = await this.models();
      const integrations = (
        await c.integration.list(
          { location: { directory: ROOT } },
          { signal: AbortSignal.timeout(10000) },
        )
      ).data;
      return {
        codex: {
          binary: Bun.which("codex"),
          version: (await command(["codex", "--version"])).toString().trim(),
        },
        opencode2: {
          binary: Bun.which("opencode") ?? Bun.which("opencode2"),
          version: health.version,
          protocol: c.protocol,
          service: "running",
          api: "healthy",
          pid: health.pid,
        },
        openCodeGo: {
          authenticated: integrations.some(
            (i) => i.id === "opencode-go" && i.connections.length > 0,
          ),
          models: models.filter((m) => m.providerID === "opencode-go").length,
          lastLiveProbe: await providerProbe("opencode-go"),
        },
        zen: {
          credentialInEnvironment: Boolean(process.env.OPENCODE_ZEN_API_KEY),
        },
        bridge: { version: VERSION, connected: true },
        routing: mappings(models, config),
      };
    } catch (e) {
      return {
        bridge: { version: VERSION, connected: false },
        error: errorText(e),
      };
    }
  }
  async run(
    task: Task,
    model: Model,
    worktree: string,
    agent: string,
    signal: AbortSignal,
    onSession: (id: string) => Promise<void>,
  ): Promise<RuntimeResult> {
    const c = await this.client();
    const location = { directory: worktree };
    await c.plugin.awaitActivation({ location }, { signal, requiredPlugins: workerPlugins });
    const actual = (await c.agent.get({ agentID: agent, location }, { signal }))
      .data;
    const expected = policy(task.mode, task.scope);
    // Verify effective policy before any prompt or model call, including after upgrades.
    if (
      JSON.stringify(actual.permissions.slice(-expected.length)) !==
        JSON.stringify(expected) ||
      actual.mode !== "primary"
    )
      throw Error("V2 did not install the exact worker policy");
    for (const [action, resource] of [
      ["shell", "git push"],
      ["subagent", "build"],
      ["edit", "/tmp/escape"],
      ["edit", ".git/config"],
      ["external_directory", "/tmp/*"],
    ])
      if (decision(actual.permissions, action!, resource!) !== "deny")
        throw Error("V2 policy failed closed");
    const selectedModel = requestedModel(model, task.reasoningEffort, task.variant);
    const sessionID = "ses_" + randomUUID().replaceAll("-", "");
    await onSession(sessionID);
    const s = await c.session.create(
      {
        id: sessionID,
        title: `Codex ${task.role}`,
        agent,
        model: selectedModel,
        location,
      },
      { signal },
    );
    try {
      verifyModelSelection(selectedModel, s.model);
      await c.session.prompt(
        { sessionID: s.id, text: contract(task, worktree) },
        { signal },
      );
      await waitForSession(c.session, s.id, signal);
      const info = await c.session.get({ sessionID: s.id }, { signal });
      const page = await c.message.list(
        { sessionID: s.id, limit: 200, order: "asc" },
        { signal },
      );
      const messages = page.data.filter(
        (m): m is SessionMessageAssistant => m.type === "assistant",
      );
      if (
        info.outcome !== "succeeded" ||
        !messages.length ||
        messages.some((m) => m.error)
      )
        throw Error(
          `OpenCode 2 session ${info.outcome ?? "incomplete"}: ${redact(messages.find((m) => m.error)?.error?.message ?? "No successful final response", 1000)}`,
        );
      verifyModelSelection(selectedModel, info.model);
      for (const message of messages) verifyModelSelection(selectedModel, message.model);
      const last = messages.at(-1)!;
      const text = last.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (!text.trim()) throw Error("Worker returned no final text");
      await recordProviderProbe(model.providerID, model.key, true);
      return {
        sessionID: s.id,
        effectiveModel: info.model,
        text: redact(text),
        tools: messages.flatMap((m) =>
          m.content
            .filter((p) => p.type === "tool")
            .map((p) => ({ name: p.name, status: p.state.status })),
        ),
      };
    } catch (e) {
      if (!signal.aborted)
        await recordProviderProbe(model.providerID, model.key, false, e);
      await this.interrupt(s.id);
      throw e;
    }
  }
  async interrupt(id: string) {
    const c = await this.client();
    await c.session.interrupt(
      { sessionID: id },
      { signal: AbortSignal.timeout(10000) },
    );
    await c.session.wait(
      { sessionID: id },
      { signal: AbortSignal.timeout(15000) },
    );
  }
  async remove(id: string) {
    const c = await this.client();
    await c.session.remove(
      { sessionID: id },
      { signal: AbortSignal.timeout(10000) },
    );
  }
}
export function normalizeModel(m: ModelInfo): Model {
  return {
    id: m.id,
    providerID: m.providerID,
    modelID: m.modelID,
    key: `${m.providerID}/${m.id}`,
    variants: m.variants.map(v => ({ id: v.id, reasoningEffort: typeof v.settings?.reasoningEffort === "string" ? v.settings.reasoningEffort : undefined })),
    reasoningVariants: m.variants.filter(v => typeof v.settings?.reasoningEffort === "string").map(v => ({id: v.id, effort: v.settings!.reasoningEffort as string})),
    vision: m.capabilities.input.includes("image"),
    cost: Number(m.cost[0]?.input ?? 0) + Number(m.cost[0]?.output ?? 0),
  };
}
