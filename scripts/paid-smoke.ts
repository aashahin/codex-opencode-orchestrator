import { Bridge } from "../src/delegate";
import { loadConfig, ROOT } from "../src/config";
import { fixture, dispose } from "../tests/helpers";
import { command } from "../src/git";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorText } from "../src/security";
const repo = await fixture();
const b = new Bridge(await loadConfig());
const result: Record<string, unknown> = { date: new Date().toISOString() };
try {
  const worker = await b.delegate({
    repoDir: repo,
    role: "explorer",
    task: "Read a.txt and report its first word.",
    timeoutSeconds: 60,
  });
  result.go = {
    status: worker.status,
    model: worker.model,
    warnings: worker.warnings,
  };
  await b.discard(worker.id, true);
  for (const model of ["astra", "sol"]) {
    if (!process.env.OPENCODE_ZEN_API_KEY) {
      result[model] = {
        status: "skipped",
        reason: "OPENCODE_ZEN_API_KEY is absent",
      };
      continue;
    }
    try {
      const response = await command(
        [
          join(process.env.HOME!, ".local/bin", `codex-${model}`),
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "-s",
          "read-only",
          "-C",
          repo,
          "Reply with exactly READY. Do not use tools.",
        ],
        { max: 10000 },
      );
      result[model] = {
        status: "completed",
        responseReceived: response.toString().includes("READY"),
      };
    } catch (e) {
      result[model] = { status: "failed", error: errorText(e) };
    }
  }
} finally {
  await b.close();
  await dispose(repo);
  await writeFile(
    join(ROOT, "PAID-TESTS.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result, null, 2));
}
