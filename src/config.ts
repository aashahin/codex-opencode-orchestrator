import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
export const VERSION = "1.1.0";
export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const roles = [
  "explorer",
  "implementer",
  "reviewer",
  "hard_reasoning",
  "vision",
  "cheap",
] as const;
export type Role = (typeof roles)[number];
export const preferences: Record<Role, string[]> = {
  explorer: ["opencode-go/deepseek-v4-flash"],
  implementer: ["opencode-go/kimi-k2.7-code", "opencode-go/kimi-k3"],
  reviewer: [
    "opencode-go/qwen3.8-max",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/grok-4.6",
  ],
  hard_reasoning: [
    "opencode-go/grok-4.6",
    "opencode-go/kimi-k3",
    "opencode-go/qwen3.8-max",
  ],
  vision: ["opencode-go/deepseek-v4-flash-vision-exp"],
  cheap: ["opencode-go/deepseek-v4-flash"],
};
export const ConfigSchema = z
  .object({
    routing: z
      .object(
        Object.fromEntries(
          roles.map((r) => [
            r,
            z
              .array(z.string().regex(/^[\w.-]+\/[\w.:-]+$/))
              .max(20)
              .optional(),
          ]),
        ) as Record<Role, z.ZodOptional<z.ZodArray<z.ZodString>>>,
      )
      .strict()
      .default({}),
    parallelism: z.number().int().min(1).max(8).default(3),
    timeoutSeconds: z.number().int().min(1).max(1800).default(300),
    maxFiles: z.number().int().min(1).max(100000).default(30000),
    maxSnapshotBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 ** 3)
      .default(256 * 1024 ** 2),
    maxPatchBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 ** 2)
      .default(16 * 1024 ** 2),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(256 * 1024)
      .default(48000),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export const paths = {
  config: join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "codex-opencode-orchestrator",
    "config.json",
  ),
  state: join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
    "codex-opencode-orchestrator",
  ),
  cache: join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "codex-opencode-orchestrator",
  ),
};
export async function loadConfig(
  file = process.env.OC_BRIDGE_CONFIG || paths.config,
): Promise<Config> {
  const f = Bun.file(file);
  return ConfigSchema.parse((await f.exists()) ? await f.json() : {});
}
export const TaskSchema = z
  .object({
    task: z.string().min(1).max(24000),
    role: z.enum(roles).default("explorer"),
    model: z.string().max(200).optional(),
    variant: z.string().min(1).max(200).optional().describe("Exact variant ID from oc_models, for example xhigh, max, or deep. Never inferred or downgraded."),
    reasoningEffort: z.string().min(1).max(200).optional().describe("Select an advertised reasoning effort. Prefer variant for an exact catalog selection; if both are supplied they must agree."),
    repoDir: z.string().min(2).max(4096),
    mode: z.enum(["read_only", "write_isolated"]).default("read_only"),
    scope: z.array(z.string().min(1).max(1024)).max(100).default([]),
    constraints: z.array(z.string().max(2000)).max(30).default([]),
    verification: z.array(z.string().max(1000)).max(20).default([]),
    timeoutSeconds: z.number().int().min(1).max(1800).optional(),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;
