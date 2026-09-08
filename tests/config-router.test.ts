import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { ConfigSchema, loadConfig } from "../src/config";
import { mergeCodex, mergeCodexInstructions, zenWrapper } from "../src/install";
import { mergeGuidance, WORKFLOW_GUIDANCE } from "../src/guidance";
import { choose, type Model } from "../src/router";
import { dispose, config } from "./helpers";
const model = (key: string, vision = false): Model => ({
  key,
  providerID: key.split("/")[0]!,
  id: key.split("/")[1]!,
  modelID: key.split("/")[1]!,
  vision,
  cost: 0.1,
});
test("configuration defaults, overrides, invalid and missing configuration", async () => {
  const dir = await mkdtemp("/tmp/oc-config-");
  try {
    expect((await loadConfig(join(dir, "missing"))).parallelism).toBe(3);
    await writeFile(
      join(dir, "c.json"),
      JSON.stringify({
        parallelism: 2,
        routing: { explorer: ["opencode-go/kimi-k3"] },
      }),
    );
    expect((await loadConfig(join(dir, "c.json"))).routing.explorer).toEqual([
      "opencode-go/kimi-k3",
    ]);
    expect(() => ConfigSchema.parse({ parallelism: 99 })).toThrow();
    expect(() => ConfigSchema.parse({ unknown: true })).toThrow();
    await writeFile(join(dir, "c.json"), "{");
    await expect(loadConfig(join(dir, "c.json"))).rejects.toThrow();
  } finally {
    await dispose(dir);
  }
});
test("installer preserves existing settings/comments and is idempotent with backup", async () => {
  const dir = await mkdtemp("/tmp/oc-installer-");
  try {
    const path = join(dir, "config.toml");
    const source =
      '# user comment\nmodel="existing"\n[mcp_servers.mine]\ncommand="mine"\n[model_providers.mine]\nname="mine"\n[profiles.work]\nmodel="custom"\n';
    await writeFile(path, source);
    const a = await mergeCodex(path, "/bin/bun", "/tool");
    const once = await readFile(path, "utf8");
    expect(a.changed).toBe(true);
    expect(once).toContain("# user comment");
    const parsed = TOML.parse(once);
    for (const key of ["model", "profiles"])
      expect(parsed[key]).toEqual(TOML.parse(source)[key]);
    expect((parsed.mcp_servers as any).mine.command).toBe("mine");
    expect(parsed.model_providers).toEqual(TOML.parse(source).model_providers);
    expect((parsed.model_providers as any).opencode_zen).toBeUndefined();
    expect((await mergeCodex(path, "/bin/bun", "/tool")).changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(once);
    expect(
      (await readdir(dir)).filter((x) => x.includes("before")).length,
    ).toBe(1);
  } finally {
    await dispose(dir);
  }
});
test("optional Zen launcher supplies its provider and forwards arguments without shell expansion", async () => {
  const dir = await mkdtemp("/tmp/oc-launcher-");
  try {
    const fakeCodex = join(dir, "codex ' executable");
    await writeFile(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const launcher = join(dir, "launcher");
    await writeFile(launcher, zenWrapper(fakeCodex, "gpt-6-astra"), { mode: 0o755 });
    const forwarded = 'literal $(false) `false` argument';
    const result = Bun.spawn([launcher, "exec", forwarded], {
      env: { ...process.env, OPENCODE_ZEN_API_KEY: "test-only" },
      stdout: "pipe", stderr: "pipe",
    });
    const args = (await new Response(result.stdout).text()).trimEnd().split("\n");
    expect(await result.exited).toBe(0);
    expect(args[0]).toBe("-c");
    const provider = (TOML.parse(args[1]!).model_providers as any).opencode_zen;
    expect(provider).toEqual({ name: "OpenCode Zen", base_url: "https://opencode.ai/zen/v1", env_key: "OPENCODE_ZEN_API_KEY", wire_api: "responses", requires_openai_auth: false });
    expect(args.slice(2)).toEqual(["-c", 'model_provider="opencode_zen"', "-m", "gpt-6-astra", "exec", forwarded]);
    const missing = Bun.spawn([launcher, "exec", "test"], { env: { ...process.env, OPENCODE_ZEN_API_KEY: "" }, stdout: "pipe", stderr: "pipe" });
    expect(await missing.exited).toBe(78);
  } finally {
    await dispose(dir);
  }
});
test("persistent guidance preserves user instructions and updates only its managed block", async () => {
  const dir = await mkdtemp("/tmp/oc-guidance-");
  try {
    const file = join(dir, "AGENTS.md");
    const existing = "# Personal workflow\n\nKeep the separate Grok workflow.\n";
    await writeFile(file, existing);
    const installed = await mergeCodexInstructions(dir);
    const first = await readFile(file, "utf8");
    expect(first.startsWith(existing)).toBe(true);
    expect(first).toContain(WORKFLOW_GUIDANCE);
    expect(await readFile(installed.backup!, "utf8")).toBe(existing);
    expect((await mergeCodexInstructions(dir)).changed).toBe(false);
    const edited = first.replace(WORKFLOW_GUIDANCE, "Previous bridge guidance") + "\nUser footer.\n";
    await writeFile(file, edited);
    await mergeCodexInstructions(dir);
    const updated = await readFile(file, "utf8");
    expect(updated).toBe(first + "\nUser footer.\n");
    expect(mergeGuidance(updated)).toBe(updated);
  } finally {
    await dispose(dir);
  }
});
test("persistent guidance honors the active global override and rejects malformed markers", async () => {
  const dir = await mkdtemp("/tmp/oc-override-");
  try {
    const base = join(dir, "AGENTS.md"), override = join(dir, "AGENTS.override.md");
    await writeFile(base, "Base instructions\n");
    await writeFile(override, "Active instructions\n");
    expect((await mergeCodexInstructions(dir)).file).toBe(override);
    expect(await readFile(base, "utf8")).toBe("Base instructions\n");
    expect(await readFile(override, "utf8")).toContain(WORKFLOW_GUIDANCE);
    const broken = "Active instructions\n<!-- codex-opencode-orchestrator:begin -->";
    await writeFile(override, broken);
    await expect(mergeCodexInstructions(dir)).rejects.toThrow("Malformed");
    expect(await readFile(override, "utf8")).toBe(broken);
    await writeFile(override, " \n");
    expect((await mergeCodexInstructions(dir)).file).toBe(base);
    expect(await readFile(override, "utf8")).toBe(" \n");
  } finally {
    await dispose(dir);
  }
});
test("router preference, missing preference, explicit model and invalid model", () => {
  const deep = model("opencode-go/deepseek-v4-flash"),
    kimi = model("opencode-go/kimi-k3");
  expect(choose([kimi, deep], "explorer", config).key).toBe(deep.key);
  expect(choose([kimi], "explorer", config).key).toBe(kimi.key);
  expect(choose([kimi, deep], "implementer", config).key).toBe(kimi.key);
  expect(choose([kimi, deep], "explorer", config, kimi.key).key).toBe(kimi.key);
  expect(() => choose([deep], "explorer", config, "bad/model")).toThrow();
  expect(() => choose([], "cheap", config)).toThrow();
  expect(() => choose([deep], "vision", config)).toThrow();
  expect(
    choose([model("opencode-go/vision", true)], "vision", config).vision,
  ).toBe(true);
});
