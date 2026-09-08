import { z } from "zod";
import type { Task } from "./config";
import { redact } from "./security";
export const ReportSchema = z.object({
  summary: z.string().max(12000),
  findings: z
    .array(
      z.object({
        kind: z.enum(["FACT", "INFERENCE", "RECOMMENDATION"]),
        message: z.string().max(3000),
        file: z.string().optional(),
        severity: z
          .enum(["info", "low", "medium", "high", "critical"])
          .default("info"),
      }),
    )
    .max(100)
    .default([]),
  changes: z
    .array(z.object({ file: z.string(), reason: z.string().max(2000) }))
    .max(100)
    .default([]),
  tests: z
    .array(
      z.object({
        command: z.string(),
        result: z.string(),
        passed: z.boolean().nullable(),
      }),
    )
    .max(30)
    .default([]),
  risks: z.array(z.string().max(2000)).max(30).default([]),
});
export type Report = z.infer<typeof ReportSchema>;
export function contract(task: Task, worktree: string) {
  return redact(
    `ROLE\n${task.role}\nOBJECTIVE\n${task.task}\nREPOSITORY\n${worktree}\nSCOPE\n${task.scope.length ? task.scope.join("\n") : "Relevant source files only"}\nCONSTRAINTS\n${task.constraints.join("\n")}\nEXPECTED OUTPUT\nAfter completing the work, return ONLY one JSON result object, without markdown or a schema. Use this shape with your actual findings: {"summary":"what you did or found","findings":[{"kind":"FACT","message":"evidence","file":"path","severity":"info"}],"changes":[{"file":"path","reason":"why"}],"tests":[{"command":"test command","result":"not run","passed":null}],"risks":[]}. Use empty arrays where appropriate.\nFor changes, give file and reason. For analysis, distinguish FACT, INFERENCE, RECOMMENDATION.\nVERIFICATION\n${task.verification.join("\n")}\nShell is denied. List tests that Codex must run with passed:null and result:"not run; orchestrator verification required".\nPROHIBITED ACTIONS\nNo nested agents, shell, external paths, global configuration, credentials, deployment, publishing, pushes or commits. Do not modify .git, .opencode or opencode configuration. Do not make architectural or integration decisions. The worktree is a snapshot of source including existing user edits.`,
    40000,
  );
}
export function parseReport(text: string): {
  report: Report;
  warnings: string[];
} {
  let raw = text.trim();
  if (
    (raw.startsWith("```json\n") || raw.startsWith("```\n")) &&
    raw.endsWith("```")
  )
    raw = raw.slice(raw.indexOf("\n") + 1, -3).trim();
  try {
    return { report: ReportSchema.parse(JSON.parse(raw)), warnings: [] };
  } catch {
    return {
      report: {
        summary: redact(text, 12000),
        findings: [],
        changes: [],
        tests: [],
        risks: [],
      },
      warnings: [
        "V2 session API has no schema-constrained result field. Worker output failed JSON schema validation; treat summary as unverified prose.",
      ],
    };
  }
}
