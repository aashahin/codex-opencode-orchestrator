import { OpenCode2 } from "../src/opencode2";
import { Bridge } from "../src/delegate";
import { loadConfig, ROOT } from "../src/config";
import { command } from "../src/git";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
const rt = new OpenCode2();
const b = new Bridge(await loadConfig(), rt);
const c = await rt.client();
assert.equal(c, await rt.client(), "reuse client for same service");
const active = await c.session.active();
assert.equal(
  Object.keys(active).length,
  0,
  "Do not restart a service with active sessions",
);
const before = await c.health.get();
const executable = Bun.which("opencode2");
assert(executable, "opencode2 must be on PATH");
await command([executable, "service", "restart"]);
const after = await (await rt.client()).health.get();
assert(after.healthy);
assert.notEqual(before.pid, after.pid);
assert((await rt.models()).length > 0);
const report = {
  serviceRestartRecovery: "passed",
  oldPid: before.pid,
  newPid: after.pid,
  remainingWorkers: await b.state.list(),
};
console.log(JSON.stringify(report, null, 2));
await writeFile(
  join(ROOT, "RECOVERY-TESTS.json"),
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
await b.close();
