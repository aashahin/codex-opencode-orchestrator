import { test, expect } from "bun:test";
import {
  mkdtemp,
  writeFile,
  readFile,
  symlink,
  chmod,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { snapshot, cleanup } from "../src/worktrees";
import { git } from "../src/git";
import { State, type WorkerRecord } from "../src/state";
import { collect, workerDiff, applyPatch } from "../src/patches";
import { fixture, dispose, config } from "./helpers";
async function setup() {
  const repo = await fixture(),
    base = await mkdtemp("/tmp/oc-state-");
  const state = new State(join(base, "state"));
  const cache = join(base, "cache");
  return { repo, base, state, cache };
}
async function worker(f: Awaited<ReturnType<typeof setup>>) {
  const id = randomUUID();
  const s = await snapshot(f.repo, id, config, f.state.dir(id), f.cache);
  const r: WorkerRecord = {
    id,
    role: "implementer",
    model: "test/model",
    status: "completed",
    created: s.created,
    updated: s.created,
    snapshot: s,
    changedFiles: [],
  };
  await f.state.save(r);
  return r;
}
test("clean worktree snapshot and cleanup leave branch and index unchanged", async () => {
  const f = await setup();
  try {
    const before = await git(f.repo, ["status", "--porcelain=v1", "-z"]);
    const head = await git(f.repo, ["rev-parse", "HEAD"]);
    const r = await worker(f);
    expect(await readFile(join(r.snapshot!.worktree, "a.txt"), "utf8")).toBe(
      "base\n",
    );
    await writeFile(join(r.snapshot!.worktree, "a.txt"), "worker\n");
    expect(await readFile(join(f.repo, "a.txt"), "utf8")).toBe("base\n");
    expect(await git(f.repo, ["status", "--porcelain=v1", "-z"])).toEqual(
      before,
    );
    expect(await git(f.repo, ["rev-parse", "HEAD"])).toEqual(head);
    await cleanup(r.snapshot!, f.cache);
    expect(await Bun.file(join(r.snapshot!.worktree, ".git")).exists()).toBe(
      false,
    );
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});
test("dirty staged/unstaged/untracked/binary state copied; patch is worker delta only", async () => {
  const f = await setup();
  try {
    await writeFile(join(f.repo, "a.txt"), "staged\n");
    await git(f.repo, ["add", "--", "a.txt"]);
    await writeFile(join(f.repo, "a.txt"), "staged\nunstaged\n");
    const weird = "space\tand\nnewline.txt";
    await writeFile(join(f.repo, weird), "untracked\n");
    await writeFile(join(f.repo, "blob.bin"), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(f.repo, ".gitignore"), "ignored\n");
    await writeFile(join(f.repo, "ignored"), "do not copy");
    const status = await git(f.repo, ["status", "--porcelain=v1", "-z"]);
    const staged = await git(f.repo, ["diff", "--cached", "--binary"]);
    const r = await worker(f),
      s = r.snapshot!;
    expect(await readFile(join(s.worktree, "a.txt"), "utf8")).toBe(
      "staged\nunstaged\n",
    );
    expect(await readFile(join(s.worktree, weird), "utf8")).toBe("untracked\n");
    expect(await Bun.file(join(s.worktree, "ignored")).exists()).toBe(false);
    await writeFile(join(s.worktree, "a.txt"), "staged\nunstaged\nworker\n");
    await writeFile(join(s.worktree, "blob.bin"), Buffer.from([0, 9, 2, 255]));
    const patch = await collect(r, f.state, config);
    expect(patch.toString()).toContain("+worker");
    expect(patch.toString()).not.toContain("+unstaged");
    expect(patch.toString()).toContain("GIT binary patch");
    expect(await git(f.repo, ["status", "--porcelain=v1", "-z"])).toEqual(
      status,
    );
    const d = await workerDiff(f.state, r.id, 0, 48000);
    await applyPatch(f.state, r.id, f.repo, d.reviewToken!);
    expect(await readFile(join(f.repo, "a.txt"), "utf8")).toBe(
      "staged\nunstaged\nworker\n",
    );
    expect(await readFile(join(f.repo, "blob.bin"))).toEqual(
      Buffer.from([0, 9, 2, 255]),
    );
    expect(await git(f.repo, ["diff", "--cached", "--binary"])).toEqual(staged);
    await cleanup(s, f.cache);
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});
test("patch review and repository identity enforced; conflict preserves user edits", async () => {
  const f = await setup();
  try {
    const r = await worker(f);
    await writeFile(join(r.snapshot!.worktree, "a.txt"), "worker\n");
    await collect(r, f.state, config);
    await expect(
      applyPatch(f.state, r.id, f.repo, r.patchHash!),
    ).rejects.toThrow("Inspect");
    const d = await workerDiff(f.state, r.id, 0, 48000);
    await writeFile(join(f.repo, "a.txt"), "user concurrent edit\n");
    await expect(
      applyPatch(f.state, r.id, f.repo, d.reviewToken!),
    ).rejects.toThrow("conflicts");
    expect(await readFile(join(f.repo, "a.txt"), "utf8")).toBe(
      "user concurrent edit\n",
    );
    const other = await fixture();
    try {
      await expect(
        applyPatch(f.state, r.id, other, d.reviewToken!),
      ).rejects.toThrow("identity");
    } finally {
      await dispose(other);
    }
    await cleanup(r.snapshot!, f.cache);
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});
test("independent patches apply sequentially while unrelated later user edits survive", async () => {
  const f = await setup();
  try {
    const a = await worker(f),
      b = await worker(f);
    await writeFile(join(a.snapshot!.worktree, "a.txt"), "worker A\n");
    await writeFile(join(b.snapshot!.worktree, "other.txt"), "worker B\n");
    await writeFile(join(f.repo, "new-user.txt"), "leave intact");
    for (const r of [a, b]) {
      await collect(r, f.state, config);
      const d = await workerDiff(f.state, r.id, 0, 48000);
      await applyPatch(f.state, r.id, f.repo, d.reviewToken!);
      await cleanup(r.snapshot!, f.cache);
    }
    expect(await readFile(join(f.repo, "new-user.txt"), "utf8")).toBe(
      "leave intact",
    );
    expect(await readFile(join(f.repo, "a.txt"), "utf8")).toBe("worker A\n");
    expect(await readFile(join(f.repo, "other.txt"), "utf8")).toBe(
      "worker B\n",
    );
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});
test("symlink escape and index-only conflicts are refused", async () => {
  const f = await setup();
  try {
    const r = await worker(f);
    await writeFile(join(r.snapshot!.worktree, "a.txt"), "worker");
    await collect(r, f.state, config);
    const d = await workerDiff(f.state, r.id, 0, 48000);
    await git(f.repo, ["update-index", "--chmod=+x", "a.txt"]);
    await expect(
      applyPatch(f.state, r.id, f.repo, d.reviewToken!),
    ).rejects.toThrow("conflicts");
    await cleanup(r.snapshot!, f.cache);
    await symlink("/etc", join(f.repo, "external"));
    const r2 = await worker(f);
    expect(
      (await readFile(join(r2.snapshot!.worktree, ".git"), "utf8")).startsWith(
        "gitdir:",
      ),
    ).toBe(true);
    await cleanup(r2.snapshot!, f.cache);
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});
test("new and removed files and executable modes round trip safely", async () => {
  const f = await setup();
  try {
    const r = await worker(f);
    await rm(join(r.snapshot!.worktree, "a.txt"));
    await writeFile(
      join(r.snapshot!.worktree, "-new script.sh"),
      "echo safe\n",
    );
    await chmod(join(r.snapshot!.worktree, "-new script.sh"), 0o755);
    await collect(r, f.state, config);
    const d = await workerDiff(f.state, r.id, 0, 48000);
    await applyPatch(f.state, r.id, f.repo, d.reviewToken!);
    expect(await Bun.file(join(f.repo, "a.txt")).exists()).toBe(false);
    expect(await readFile(join(f.repo, "-new script.sh"), "utf8")).toBe(
      "echo safe\n",
    );
    await cleanup(r.snapshot!, f.cache);
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});

test("worker-created ignored files are collected instead of silently lost on cleanup", async () => {
  const f = await setup();
  try {
    await writeFile(join(f.repo, ".gitignore"), "ignored.txt\n");
    const r = await worker(f);
    await writeFile(
      join(r.snapshot!.worktree, "ignored.txt"),
      "worker-created content\n",
    );
    await collect(r, f.state, config);
    expect(r.changedFiles).toContain("ignored.txt");
    const d = await workerDiff(f.state, r.id, 0, 48000);
    expect(d.patch).toContain("+worker-created content");
    await writeFile(join(f.repo, "ignored.txt"), "existing user data\n");
    await expect(
      applyPatch(f.state, r.id, f.repo, d.reviewToken!),
    ).rejects.toThrow("conflicts");
    expect(await readFile(join(f.repo, "ignored.txt"), "utf8")).toBe(
      "existing user data\n",
    );
    await cleanup(r.snapshot!, f.cache);
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});

test("recollection removes an obsolete patch after worker edits are reverted", async () => {
  const f = await setup();
  try {
    const r = await worker(f);
    await writeFile(join(r.snapshot!.worktree, "a.txt"), "worker\n");
    await collect(r, f.state, config);
    expect(r.patchHash).toBeDefined();
    await writeFile(join(r.snapshot!.worktree, "a.txt"), "base\n");
    await collect(r, f.state, config);
    expect(r.patchHash).toBeUndefined();
    expect((await workerDiff(f.state, r.id, 0, 48000)).patchAvailable).toBe(
      false,
    );
    await cleanup(r.snapshot!, f.cache);
  } finally {
    await dispose(f.repo);
    await dispose(f.base);
  }
});
