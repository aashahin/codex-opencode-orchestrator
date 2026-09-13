import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskSchema, paths, type Config, type Task } from "./config";
import { safeRelative, errorText, redact } from "./security";
import { snapshot, cleanup } from "./worktrees";
import { installPolicy, restorePolicy } from "./permissions";
import { State, type WorkerRecord } from "./state";
import { collect, workerDiff, applyPatch } from "./patches";
import { Semaphore, parallel } from "./parallel";
import { choose, mappings } from "./router";
import { requestedModel } from "./reasoning";
import { parseReport } from "./prompts";
import { OpenCode2, type Runtime } from "./opencode2";
import { RECOVERY_GUIDANCE } from "./guidance";
export class Bridge {
  readonly state: State;
  readonly gate: Semaphore;
  private active = new Map<string, AbortController>();
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private shutdown = new AbortController();
  constructor(
    readonly config: Config,
    readonly runtime: Runtime = new OpenCode2(),
    state = paths.state,
    readonly cache = paths.cache,
  ) {
    this.state = new State(state);
    this.gate = new Semaphore(config.parallelism);
  }
  health() {
    return this.runtime.health(this.config);
  }
  async models() {
    const models = await this.runtime.models();
    return {
      models: models.map((m) => ({
        ...m,
        roles: m.vision
          ? [
              "explorer",
              "implementer",
              "reviewer",
              "hard_reasoning",
              "vision",
              "cheap",
            ]
          : ["explorer", "implementer", "reviewer", "hard_reasoning", "cheap"],
      })),
      routing: mappings(models, this.config),
    };
  }
  delegate(input: unknown, signal?: AbortSignal) {
    if (this.closing) throw Error("Bridge is shutting down");
    const combined = AbortSignal.any([
      this.shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    const p = this.gate.run(
      () => this.execute(TaskSchema.parse(input), combined),
      combined,
    );
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }
  private async execute(task: Task, parent?: AbortSignal) {
    task.scope.forEach(safeRelative);
    if (
      ["explorer", "reviewer"].includes(task.role) &&
      task.mode !== "read_only"
    )
      throw Error("Explorers and reviewers must be read-only");
    const id = randomUUID();
    const controller = new AbortController();
    this.active.set(id, controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        (task.timeoutSeconds ?? this.config.timeoutSeconds) * 1000,
      ),
      ...(parent ? [parent] : []),
    ]);
    const r: WorkerRecord = {
      id,
      role: task.role,
      model: task.model ?? "",
      requestedVariant: task.variant,
      requestedReasoningEffort: task.reasoningEffort,
      status: "running",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      changedFiles: [],
    };
    await this.state.save(r);
    let response;
    const warnings: string[] = [];
    try {
      signal.throwIfAborted();
      const models = await this.runtime.models(signal);
      const model = choose(models, task.role, this.config, task.model);
      r.model = model.key;
      r.selectedModel = requestedModel(model, task.reasoningEffort, task.variant);
      r.snapshot = await snapshot(
        task.repoDir,
        id,
        this.config,
        this.state.dir(id),
        this.cache,
        signal,
      );
      await this.state.save(r);
      signal.throwIfAborted();
      const agent = await installPolicy(
        r.snapshot.worktree,
        this.state.dir(id),
        task,
        id,
      );
      response = await this.runtime.run(
        task,
        model,
        r.snapshot.worktree,
        agent,
        signal,
        async (session) => {
          r.sessionID = session;
          await this.state.save(r);
        },
      );
      r.status = "completed";
      r.effectiveModel = response.effectiveModel;
    } catch (e) {
      r.status = signal.aborted
        ? signal.reason?.name === "TimeoutError"
          ? "timed_out"
          : "cancelled"
        : "failed";
      warnings.push(errorText(e));
      if (r.sessionID) {
        try {
          await this.runtime.interrupt(r.sessionID);
        } catch {
          r.status = "quarantined";
          warnings.push(
            "Session stop could not be confirmed. Worktree retained; discard will retry interruption before collection.",
          );
        }
      }
    }
    try {
      if (r.snapshot && r.status !== "quarantined") {
        await restorePolicy(r.snapshot.worktree, this.state.dir(id));
        await collect(r, this.state, this.config);
        if (task.mode === "read_only" && r.changedFiles.length) {
          r.status = "failed";
          warnings.push(
            "Read-only worker changed files; reject this result and inspect the preserved patch.",
          );
        }
      }
    } catch (e) {
      r.status = "quarantined";
      warnings.push(errorText(e));
    }
    const { report, warnings: parseWarnings } = parseReport(
      response?.text ?? "",
    );
    if (response) warnings.push(...parseWarnings);
    const result = {
      id,
      status: r.status,
      model: r.model,
      role: r.role,
      requestedReasoningEffort: task.reasoningEffort,
      requestedVariant: task.variant,
      selectedModel: r.selectedModel,
      effectiveModel: response?.effectiveModel,
      summary: report.summary,
      findings: report.findings,
      changes: report.changes,
      changedFiles: r.changedFiles,
      verification: task.verification.map((command) => ({
        command,
        status: "not_run",
        source: "bridge",
        reason:
          "Authoritative verification belongs to Codex; worker shell is denied",
      })),
      workerTestClaims: report.tests.map((t) => ({
        ...t,
        independentlyVerified: false,
      })),
      patchAvailable: Boolean(r.patchHash),
      patchId: r.patchHash ? id : undefined,
      warnings: [...warnings, ...report.risks],
      recovery: r.status === "completed" ? undefined : RECOVERY_GUIDANCE,
      sessionID: r.sessionID,
      worktree: r.snapshot?.worktree,
      tools: response?.tools ?? [],
    };
    r.result = {
      summary: redact(result.summary, 12000),
      status: result.status,
      warnings: result.warnings,
    };
    r.warning = warnings.join("; ");
    await this.state.save(r);
    this.active.delete(id);
    return result;
  }
  async delegateParallel(
    tasks: unknown[],
    concurrency = this.config.parallelism,
    signal?: AbortSignal,
  ) {
    if (tasks.length < 1 || tasks.length > 16)
      throw Error("Supply 1–16 independent tasks");
    const start = Date.now();
    const results = await parallel(
      tasks,
      Math.min(concurrency, this.config.parallelism),
      (t) => this.delegate(t, signal),
      signal,
    );
    return {
      elapsedMs: Date.now() - start,
      concurrency: Math.min(concurrency, this.config.parallelism),
      results: results.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { status: "failed", error: errorText(r.reason) },
      ),
    };
  }
  diff(id: string, offset = 0, limit = 20000) {
    return workerDiff(
      this.state,
      id,
      offset,
      Math.min(limit, this.config.maxOutputBytes),
    );
  }
  apply(id: string, repoDir: string, token: string) {
    return applyPatch(this.state, id, repoDir, token);
  }
  async discard(id: string, discardPatch = false) {
    this.active.get(id)?.abort(Error("Cancelled by orchestrator"));
    if (this.active.has(id))
      throw Error(
        "Worker cancellation requested; wait for its result, then discard",
      );
    return this.state.lock("worker-" + id, async () => {
      const r = await this.state.get(id);
      if (r.status === "discarded") return { id, status: "discarded" };
      if (r.sessionID) await this.runtime.interrupt(r.sessionID);
      if (r.snapshot) {
        await restorePolicy(r.snapshot.worktree, this.state.dir(id));
        if (r.status !== "applied") await collect(r, this.state, this.config);
      }
      if (r.patchHash && r.status !== "applied" && !discardPatch) {
        r.status = "failed";
        await this.state.save(r);
        return {
          id,
          status: "preserved",
          patchAvailable: true,
          message:
            "Worker changes collected. Inspect the patch or explicitly set discardPatch:true.",
        };
      }
      if (r.sessionID) await this.runtime.remove(r.sessionID);
      if (r.snapshot) await cleanup(r.snapshot, this.cache);
      await rm(join(this.state.dir(id), "worker.patch"), { force: true });
      r.status = "discarded";
      r.patchHash = undefined;
      r.snapshot = undefined;
      r.result = undefined;
      await this.state.save(r);
      return { id, status: "discarded" };
    });
  }
  async cancel(id: string) {
    const controller = this.active.get(id);
    if (controller) {
      controller.abort(Error("Cancelled by orchestrator"));
      return { id, status: "cancellation_requested" };
    }
    const r = await this.state.get(id);
    if (r.sessionID) await this.runtime.interrupt(r.sessionID);
    return {
      id,
      status: "interrupted",
      message: "Use oc_discard_worker to collect and clean up resources.",
    };
  }
  async close() {
    this.closing = true;
    this.shutdown.abort(Error("MCP connection closed"));
    for (const c of this.active.values())
      c.abort(Error("MCP connection closed"));
    await Promise.allSettled([...this.pending]);
  }
}
