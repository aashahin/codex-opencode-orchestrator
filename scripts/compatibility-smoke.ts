// No model prompts or provider credits: exercise the installed runtime's real API.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { OpenCode2 } from "../src/opencode2";
import { TaskSchema } from "../src/config";
import { installPolicy, restorePolicy, policy, workerPlugins } from "../src/permissions";
import { fixture, dispose } from "../tests/helpers";
import { requestedModel, verifyModelSelection } from "../src/reasoning";
import { errorText } from "../src/security";

const repo = await fixture();
const state = await mkdtemp("/tmp/oc-compatibility-");
const runtime = new OpenCode2();
let sessionID: string | undefined;
let cleaned = false;
try {
  const client = await runtime.client();
  const health = await client.health.get();
  const models = await runtime.models();
  assert(models.length, "Provider catalog did not become ready");
  const model = models.find(m => m.variants?.some(v => v.id === "xhigh")) ?? models[0]!;
  const variant = model.variants?.find(v => v.id === "xhigh")?.id;
  const task = TaskSchema.parse({ task: "protocol check without a model prompt", repoDir: repo });
  const agent = await installPolicy(repo, state, task, crypto.randomUUID());
  const location = { directory: repo };
  const signal = AbortSignal.timeout(30000);
  await client.plugin.awaitActivation({ location }, { signal, requiredPlugins: workerPlugins });
  const effectiveAgent = (await client.agent.get({ agentID: agent, location }, { signal })).data;
  const expected = policy(task.mode, task.scope);
  assert.deepEqual(effectiveAgent.permissions.slice(-expected.length), expected);
  const selected = requestedModel(model, undefined, variant);
  const session = await client.session.create({ agent, location, model: selected }, { signal });
  sessionID = session.id;
  verifyModelSelection(selected, session.model);
  await client.session.wait({ sessionID }, { signal });
  assert.equal((await client.session.get({ sessionID }, { signal })).id, sessionID);
  await client.message.list({ sessionID, limit: 10 }, { signal });
  for (const action of ["shell", "subagent", "edit"]) {
    const permission: { effect: string } = await client.permission.create({ sessionID, action, resources: ["a.txt"] }, { signal });
    assert.equal(permission.effect, "deny");
  }
  await runtime.interrupt(sessionID);
  await runtime.remove(sessionID);
  sessionID = undefined;
  cleaned = true;
  console.log(JSON.stringify({ status: "passed", version: health.version, protocol: client.protocol, modelPrompts: 0,
    checks: ["discovery", "catalog-readiness", "worker-agent-readiness", "effective-policy", "model-variant", "session-wait", "message-list", "permission-denials", "interrupt", "remove"] }));
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
} finally {
  if (sessionID) {
    try { await runtime.interrupt(sessionID); await runtime.remove(sessionID); cleaned = true; }
    catch { console.error("Compatibility fixture retained because session cleanup could not be confirmed"); }
  } else cleaned = true;
  if (cleaned) { await restorePolicy(repo, state); await dispose(repo); await rm(state, { recursive: true, force: true }); }
}
