import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "./config";
import { validId, errorText } from "./security";
import type { Snapshot } from "./worktrees";
export interface WorkerRecord {
  id: string;
  role: string;
  model: string;
  status:
    | "running"
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "applied"
    | "discarded"
    | "quarantined";
  created: string;
  updated: string;
  sessionID?: string;
  snapshot?: Snapshot;
  patchHash?: string;
  changedFiles: string[];
  reviewedBytes?: number;
  result?: unknown;
  warning?: string;
}
export class State {
  constructor(readonly root = paths.state) {}
  dir(id: string) {
    return join(this.root, "workers", validId(id));
  }
  async save(record: WorkerRecord) {
    const dir = this.dir(record.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `record-${randomUUID()}.tmp`);
    record.updated = new Date().toISOString();
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, join(dir, "record.json"));
  }
  async get(id: string): Promise<WorkerRecord> {
    try {
      return JSON.parse(
        await readFile(join(this.dir(id), "record.json"), "utf8"),
      );
    } catch {
      throw Error("Worker not found or invalid state");
    }
  }
  async list(includeDiscarded = false) {
    await mkdir(join(this.root, "workers"), { recursive: true, mode: 0o700 });
    const result = [];
    for (const id of await readdir(join(this.root, "workers"))) {
      try {
        const r = await this.get(id);
        if (!includeDiscarded && r.status === "discarded") continue;
        result.push({
          id: r.id,
          role: r.role,
          model: r.model,
          status: r.status,
          repo: r.snapshot?.repo,
          worktree: r.snapshot?.worktree,
          created: r.created,
          updated: r.updated,
          patchAvailable: Boolean(r.patchHash),
          warning: r.warning,
        });
      } catch (e) {
        result.push({ id, error: errorText(e) });
      }
    }
    return result;
  }
  async lock<T>(key: string, fn: () => Promise<T>) {
    if (!/^[\w-]+$/.test(key)) throw Error("Invalid lock");
    const dir = join(this.root, "locks", key);
    await mkdir(join(this.root, "locks"), { recursive: true, mode: 0o700 });
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch {
      throw Error(
        "Operation locked by another bridge process. Retry after it finishes; inspect stale locks with doctor.",
      );
    }
    try {
      await writeFile(
        join(dir, "owner.json"),
        JSON.stringify({ pid: process.pid, created: new Date().toISOString() }),
        { mode: 0o600 },
      );
      return await fn();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
