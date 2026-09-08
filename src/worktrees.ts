import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  readlink,
  symlink,
  copyFile,
  chmod,
  rm,
  realpath,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { git, repository } from "./git";
import { digest, safeRelative, safeParents, contained } from "./security";
import { paths, type Config } from "./config";
export interface Entry {
  hash: string;
  mode: string;
}
export interface Snapshot {
  id: string;
  repo: string;
  common: string;
  head: string;
  worktree: string;
  base: string;
  entries: Record<string, Entry>;
  index: Record<string, string>;
  created: string;
}
export async function scan(
  dir: string,
  config: Config,
  signal?: AbortSignal,
  includeIgnored = false,
): Promise<Record<string, Entry>> {
  const files = (
    await git(dir, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  if (includeIgnored) {
    const ignored = await git(dir, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    files.push(...ignored.toString().split("\0").filter(Boolean));
  }
  const entries: Record<string, Entry> = Object.create(null);
  let bytes = 0;
  let count = 0;
  for (const file of [...new Set(files)].sort()) {
    signal?.throwIfAborted();
    safeRelative(file);
    await safeParents(dir, file);
    const path = join(dir, file);
    let stat;
    try {
      stat = await lstat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    if (stat.isDirectory())
      throw Error(
        "Submodules/nested repositories are not supported in snapshots; use a repository without gitlinks",
      );
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw Error("Special files cannot be snapshotted");
    bytes += stat.size;
    if (bytes > config.maxSnapshotBytes || count++ >= config.maxFiles)
      throw Error("Snapshot size limit exceeded");
    const data = stat.isSymbolicLink()
      ? Buffer.from(await readlink(path))
      : await readFile(path);
    const hash = (
      await git(dir, ["hash-object", "-w", "--stdin", "--no-filters"], data)
    )
      .toString()
      .trim();
    entries[file] = {
      hash,
      mode: stat.isSymbolicLink()
        ? "120000"
        : stat.mode & 0o111
          ? "100755"
          : "100644",
    };
  }
  return entries;
}
export async function indexEntries(dir: string) {
  const out: Record<string, string> = Object.create(null);
  for (const line of (await git(dir, ["ls-files", "--stage", "-z"]))
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const tab = line.indexOf("\t");
    const meta = line.slice(0, tab);
    if (!meta.endsWith(" 0"))
      throw Error("Unmerged index cannot be snapshotted");
    if (meta.startsWith("160000 "))
      throw Error("Git submodules are not supported by this snapshot adapter");
    out[line.slice(tab + 1)] = meta;
  }
  return out;
}
export async function tree(
  dir: string,
  entries: Record<string, Entry>,
  state: string,
) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const index = join(state, `index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ["read-tree", "--empty"], undefined, env);
    const input = Object.entries(entries)
      .map(([p, e]) => `${e.mode} ${e.hash}\t${p}\0`)
      .join("");
    await git(dir, ["update-index", "-z", "--index-info"], input, env);
    return (await git(dir, ["write-tree"], undefined, env)).toString().trim();
  } finally {
    await rm(index, { force: true });
    await rm(index + ".lock", { force: true });
  }
}
export async function snapshot(
  repo: string,
  id: string,
  config: Config,
  state = paths.state,
  cache = paths.cache,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const r = await repository(repo);
  const index = await indexEntries(r.dir);
  signal?.throwIfAborted();
  const entries = await scan(r.dir, config, signal);
  const t = await tree(r.dir, entries, state);
  const base = (
    await git(
      r.dir,
      ["commit-tree", t, "-p", r.head],
      `OpenCode worker source snapshot ${id}\n`,
      {
        GIT_AUTHOR_NAME: "Worker snapshot",
        GIT_AUTHOR_EMAIL: "snapshot@localhost",
        GIT_COMMITTER_NAME: "Worker snapshot",
        GIT_COMMITTER_EMAIL: "snapshot@localhost",
      },
    )
  )
    .toString()
    .trim();
  const worktree = join(cache, "worktrees", digest(r.dir).slice(0, 16), id);
  await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
  await git(r.dir, [
    "worktree",
    "add",
    "--detach",
    "--no-checkout",
    worktree,
    base,
  ]);
  try {
    for (const [file, e] of Object.entries(entries)) {
      signal?.throwIfAborted();
      const target = join(worktree, file);
      await mkdir(dirname(target), { recursive: true });
      const data = await git(r.dir, ["cat-file", "blob", e.hash]);
      if (e.mode === "120000") await symlink(data.toString(), target);
      else {
        await writeFile(target, data);
        await chmod(target, e.mode === "100755" ? 0o755 : 0o644);
      }
    }
    await git(worktree, ["read-tree", base]);
    if (
      JSON.stringify(await scan(r.dir, config, signal)) !==
        JSON.stringify(entries) ||
      JSON.stringify(await indexEntries(r.dir)) !== JSON.stringify(index) ||
      (await repository(r.dir)).head !== r.head
    )
      throw Error("Repository changed during snapshot; retry");
    return {
      id,
      repo: r.dir,
      common: r.common,
      head: r.head,
      worktree,
      base,
      entries,
      index,
      created: new Date().toISOString(),
    };
  } catch (e) {
    await git(r.dir, ["worktree", "remove", "--force", worktree]).catch(
      () => {},
    );
    throw e;
  }
}
export async function cleanup(s: Snapshot, cache = paths.cache) {
  const expected = join(cache, "worktrees", digest(s.repo).slice(0, 16), s.id);
  if (s.worktree !== expected || !contained(cache, s.worktree))
    throw Error("Refusing unmanaged worktree cleanup");
  const r = await repository(s.repo);
  if (r.common !== s.common) throw Error("Repository identity changed");
  try {
    await realpath(s.worktree);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  await git(s.repo, ["worktree", "remove", "--force", s.worktree]);
}
