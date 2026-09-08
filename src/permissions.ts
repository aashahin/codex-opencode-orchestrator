import type { PermissionRule } from "@opencode-ai/client";
import { mkdir, rename, rm, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "./config";
import { safeRelative } from "./security";
export function policy(
  mode: Task["mode"],
  scope: string[] = [],
): PermissionRule[] {
  const rules: PermissionRule[] = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "execute"].map((action) => ({
      action,
      resource: "*",
      effect: "allow" as const,
    })),
  ];
  if (mode === "write_isolated")
    for (const resource of scope.length ? scope : ["*"]) {
      safeRelative(resource);
      rules.push({ action: "edit", resource, effect: "allow" });
      if (!/[?*]/.test(resource))
        rules.push({
          action: "edit",
          resource: resource + "/*",
          effect: "allow",
        });
    }
  for (const action of ["read", "edit"])
    for (const resource of [
      "/*",
      "../*",
      "*../*",
      ".git",
      ".git/*",
      "*/.git/*",
      ".opencode",
      ".opencode/*",
      "*/.opencode/*",
      "opencode.json",
      "opencode.jsonc",
      "*/opencode.json",
      "*/opencode.jsonc",
      "*.env",
      "*.env.*",
      "*credentials*",
      "*auth.json",
      "*.pem",
      "*.key",
    ])
      rules.push({ action, resource, effect: "deny" });
  for (const action of [
    "external_directory",
    "shell",
    "subagent",
    "skill",
    "webfetch",
    "websearch",
  ])
    rules.push({ action, resource: "*", effect: "deny" });
  return rules;
}
export function matches(pattern: string, value: string) {
  const regex =
    "^" +
    pattern
      .split("")
      .map((c) =>
        c === "*"
          ? ".*"
          : c === "?"
            ? "."
            : c.replace(/[\\^$+.[\]{}()|]/g, "\\$&"),
      )
      .join("") +
    "$";
  return new RegExp(regex, "s").test(value);
}
export function decision(
  rules: PermissionRule[],
  action: string,
  resource: string,
) {
  return (
    rules
      .filter((r) => matches(r.action, action) && matches(r.resource, resource))
      .at(-1)?.effect ?? "ask"
  );
}
export const workerSystem =
  "You perform a bounded task for a Codex principal orchestrator. Architecture, integration, and final acceptance belong to Codex. Use only the available read/glob/grep/edit/write/patch tools. Shell, external access and subagents are denied. Do not try alternate routes around permissions. Report facts, inferences and recommendations separately. Never claim a test ran without evidence. Return one JSON object as specified in the task contract.";
const overlayPaths = [".opencode", "opencode.json", "opencode.jsonc"];
export async function installPolicy(
  worktree: string,
  state: string,
  task: Task,
  id: string,
) {
  const backup = join(state, "overlay");
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const saved: string[] = [];
  for (const file of overlayPaths) {
    try {
      await lstat(join(worktree, file));
      await rename(join(worktree, file), join(backup, file));
      saved.push(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await writeFile(join(state, "overlay.json"), JSON.stringify(saved), {
    mode: 0o600,
  });
  const agent = `codex-${task.role}-${id}`;
  const config = {
    share: "disabled",
    snapshots: false,
    warming: false,
    plugins: [
      "-*",
      "opencode.agent",
      "opencode.config.agent",
      "opencode.models.dev",
      "opencode.provider.opencode",
      "opencode.vcs.git",
      "opencode.tools",
      "opencode.tool.read",
      "opencode.tool.glob",
      "opencode.tool.grep",
      "opencode.tool.edit",
      "opencode.tool.write",
      "opencode.tool.patch",
      "opencode.config.tool-output",
      "opencode.config.policy",
    ],
    tool_output: { max_bytes: 24000, max_lines: 400 },
    agents: {
      [agent]: {
        mode: "primary",
        // V2 forces a tool-free final request at a steps cap. Some providers
        // accept only tool_choice=auto; the bridge timeout bounds work instead.
        system: workerSystem,
        permissions: policy(task.mode, task.scope),
      },
    },
  };
  await mkdir(join(worktree, ".opencode"), { recursive: true });
  await writeFile(
    join(worktree, ".opencode", "opencode.jsonc"),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  );
  return agent;
}
export async function restorePolicy(worktree: string, state: string) {
  const marker = Bun.file(join(state, "overlay.json"));
  if (!(await marker.exists())) return;
  const saved = (await marker.json()) as string[];
  for (const file of overlayPaths)
    await rm(join(worktree, file), { recursive: true, force: true });
  for (const file of saved) {
    if (!overlayPaths.includes(file)) throw Error("Invalid overlay");
    await rename(join(state, "overlay", file), join(worktree, file));
  }
  await rm(join(state, "overlay.json"));
  await rm(join(state, "overlay"), { recursive: true, force: true });
}
