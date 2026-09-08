import { readFile, writeFile, lstat, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { git, repository } from "./git";
import { scan, tree, indexEntries, type Entry } from "./worktrees";
import { digest, redact, safeParents, safeRelative } from "./security";
import type { Config } from "./config";
import { State, type WorkerRecord } from "./state";
export async function collect(
  record: WorkerRecord,
  state: State,
  config: Config,
) {
  const s = record.snapshot!;
  const entries = await scan(s.worktree, config, undefined, true);
  const t = await tree(s.worktree, entries, state.dir(s.id));
  const patch = await git(s.worktree, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    s.base,
    t,
    "--",
  ]);
  if (patch.length > config.maxPatchBytes)
    throw Error(
      "Worker patch exceeds limit; preserved worktree requires inspection",
    );
  record.changedFiles = (
    await git(s.worktree, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      s.base,
      t,
      "--",
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  if (patch.length) {
    await writeFile(join(state.dir(s.id), "worker.patch"), patch, {
      mode: 0o600,
    });
    record.patchHash = digest(patch);
    record.reviewedBytes = 0;
  } else {
    record.patchHash = undefined;
    record.reviewedBytes = 0;
    await rm(join(state.dir(s.id), "worker.patch"), { force: true });
  }
  await state.save(record);
  return patch;
}
export async function workerDiff(
  state: State,
  id: string,
  offset: number,
  limit: number,
) {
  return state.lock("worker-" + id, async () => {
    const r = await state.get(id);
    if (!r.patchHash)
      return { id, patchAvailable: false, changedFiles: r.changedFiles };
    const bytes = await readFile(join(state.dir(id), "worker.patch"));
    if (digest(bytes) !== r.patchHash)
      throw Error("Patch integrity check failed");
    if (offset > bytes.length) throw Error("Offset beyond patch");
    const end = Math.min(offset + limit, bytes.length);
    if (offset <= (r.reviewedBytes ?? 0)) {
      r.reviewedBytes = Math.max(r.reviewedBytes ?? 0, end);
      await state.save(r);
    }
    return {
      id,
      patchAvailable: true,
      changedFiles: r.changedFiles,
      patch: redact(bytes.subarray(offset, end).toString(), limit + 4096),
      offset,
      nextOffset: end,
      totalBytes: bytes.length,
      truncated: end < bytes.length,
      reviewToken: r.reviewedBytes === bytes.length ? r.patchHash : undefined,
    };
  });
}
async function currentEntry(
  repo: string,
  path: string,
): Promise<Entry | undefined> {
  safeRelative(path);
  await safeParents(repo, path);
  let s;
  try {
    s = await lstat(join(repo, path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!s.isFile() && !s.isSymbolicLink())
    throw Error("Patch target is not a regular file or symlink");
  const data = s.isSymbolicLink()
    ? Buffer.from(await readlink(join(repo, path)))
    : await readFile(join(repo, path));
  return {
    hash: (await git(repo, ["hash-object", "--stdin", "--no-filters"], data))
      .toString()
      .trim(),
    mode: s.isSymbolicLink() ? "120000" : s.mode & 0o111 ? "100755" : "100644",
  };
}
export async function applyPatch(
  state: State,
  id: string,
  repoDir: string,
  reviewToken: string,
) {
  return state.lock("worker-" + id, async () => {
    const r = await state.get(id);
    const s = r.snapshot;
    if (!s || !r.patchHash) throw Error("No worker patch");
    if (
      r.status === "applied" ||
      r.status === "discarded" ||
      r.status === "running" ||
      r.status === "quarantined"
    )
      throw Error("Worker state cannot be applied");
    const repo = await repository(repoDir);
    if (repo.dir !== s.repo || repo.common !== s.common)
      throw Error("Repository identity mismatch");
    return state.lock("repo-" + digest(repo.dir), async () => {
      if (repo.head !== s.head)
        throw Error(
          "Repository HEAD changed; delegate again from current source",
        );
      const patch = await readFile(join(state.dir(id), "worker.patch"));
      if (
        digest(patch) !== r.patchHash ||
        reviewToken !== r.patchHash ||
        r.reviewedBytes !== patch.length
      )
        throw Error(
          "Inspect the complete patch with oc_worker_diff before applying",
        );
      const currentIndex = await indexEntries(repo.dir);
      const conflicts = [];
      for (const file of r.changedFiles) {
        const entry = await currentEntry(repo.dir, file);
        if (
          JSON.stringify(entry) !== JSON.stringify(s.entries[file]) ||
          currentIndex[file] !== s.index[file]
        )
          conflicts.push(file);
      }
      if (conflicts.length)
        throw Error(
          "Patch conflicts with changed user files: " + conflicts.join(", "),
        );
      await git(
        repo.dir,
        ["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
        patch,
      );
      await git(
        repo.dir,
        ["apply", "--binary", "--whitespace=nowarn", "-"],
        patch,
      );
      r.status = "applied";
      await state.save(r);
      return {
        id,
        status: "applied",
        changedFiles: r.changedFiles,
        indexPreserved: true,
        warning: "Run authoritative integration tests. No commit was created.",
      };
    });
  });
}
