import { test, expect } from "bun:test";
import { parseReport, contract } from "../src/prompts";
import { TaskSchema } from "../src/config";
test("worker contract is bounded, self contained and keeps authority at Codex", () => {
  const text = contract(
    TaskSchema.parse({
      task: "Inspect module X",
      repoDir: "/tmp/repo",
      verification: ["bun test"],
    }),
    "/tmp/isolated",
  );
  for (const header of [
    "ROLE",
    "OBJECTIVE",
    "REPOSITORY",
    "SCOPE",
    "CONSTRAINTS",
    "EXPECTED OUTPUT",
    "VERIFICATION",
    "PROHIBITED ACTIONS",
  ])
    expect(text).toContain(header);
  expect(text).toContain("Shell is denied");
  expect(text).toContain("FACT, INFERENCE, RECOMMENDATION");
});
test("schema validation separates JSON results from malformed prose and preserves unverified claims", () => {
  const raw = JSON.stringify({
    summary: "done",
    tests: [{ command: "bun test", passed: true, result: "claimed pass" }],
  });
  expect(parseReport(raw).warnings).toEqual([]);
  expect(parseReport("```\n" + raw + "\n```").report.tests[0]?.passed).toBe(
    true,
  );
  expect(parseReport("all tests passed!").warnings.length).toBe(1);
  expect(parseReport('{"summary":12}').warnings.length).toBe(1);
});
