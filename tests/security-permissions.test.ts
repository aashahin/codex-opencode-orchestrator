import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact, safeRelative, safeParents, repoPath } from "../src/security";
import { repository } from "../src/git";
import {
  policy,
  decision,
  installPolicy,
  restorePolicy,
} from "../src/permissions";
import { TaskSchema } from "../src/config";
import { dispose } from "./helpers";
test("reject traversal, unsafe repository roots, nonrepositories and symlink parents", async () => {
  for (const p of ["../escape", "a/../../x", "/etc/passwd", ".git/config"])
    expect(() => safeRelative(p)).toThrow();
  for (const p of ["/", homedir(), "/tmp", "/tmp/../etc"])
    await expect(repoPath(p)).rejects.toThrow();
  const dir = await mkdtemp("/tmp/oc-path-");
  try {
    await expect(repository(dir)).rejects.toThrow();
    await symlink("/tmp", join(dir, "link"));
    await expect(safeParents(dir, "link/file")).rejects.toThrow();
  } finally {
    await dispose(dir);
  }
});
test("secret redaction and byte bounds", () => {
  const s = redact(
    'api_key="top-secret" Authorization: Bearer abcdef password=secret sk-1234567890abcdefgh',
  );
  expect(s).not.toContain("top-secret");
  expect(s).not.toContain("sk-1234567890abcdefgh");
  expect(s).not.toContain("password=secret");
  expect(redact("x".repeat(2000), 100).length).toBeLessThan(130);
});
test("V2 read policy denies edit, shell, push, nested agents, externals and unknown tools", () => {
  const p = policy("read_only");
  for (const [a, r] of [
    ["edit", "a.txt"],
    ["shell", "git push origin main"],
    ["shell", "cat x > /tmp/y"],
    ["subagent", "build"],
    ["external_directory", "/tmp/*"],
    ["read", "/etc/passwd"],
    ["evil_tool", "*"],
  ])
    expect(decision(p, a!, r!)).toBe("deny");
  expect(decision(p, "read", "src/a.ts")).toBe("allow");
});
test("V2 implementer edits only allowed scope and never configuration or external paths", () => {
  const p = policy("write_isolated", ["src"]);
  expect(decision(p, "edit", "src/a.ts")).toBe("allow");
  for (const r of [
    "test/a.ts",
    "/tmp/x",
    "../x",
    ".git/config",
    ".opencode/opencode.jsonc",
    "src/../../x",
  ])
    expect(decision(p, "edit", r)).toBe("deny");
  expect(decision(p, "subagent", "reviewer")).toBe("deny");
});
test("scoped V2 config preserves original config and contains only V2 policy keys", async () => {
  const dir = await mkdtemp("/tmp/oc-policy-"),
    state = await mkdtemp("/tmp/oc-policy-state-");
  try {
    await mkdir(join(dir, ".opencode"));
    await writeFile(join(dir, ".opencode", "opencode.jsonc"), "original");
    const id = await installPolicy(
      dir,
      state,
      TaskSchema.parse({ repoDir: dir, task: "inspect" }),
      "unique",
    );
    const c = await Bun.file(join(dir, ".opencode/opencode.jsonc")).json();
    expect(c.agents[id].mode).toBe("primary");
    // A finite cap forces tool_choice=none at the last V2 step, rejected by
    // auto-only providers. Timeout/cancellation tests cover the bridge bound.
    expect(c.agents[id].steps).toBeUndefined();
    expect(c.agents[id].permission).toBeUndefined();
    expect(c.agents[id].permissions).toEqual(policy("read_only"));
    await restorePolicy(dir, state);
    expect(await Bun.file(join(dir, ".opencode/opencode.jsonc")).text()).toBe(
      "original",
    );
  } finally {
    await dispose(dir);
    await dispose(state);
  }
});
