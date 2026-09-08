import { realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
export function digest(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}
export function safeRelative(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((x) => x === ".." || x === ".git")
  )
    throw Error("Unsafe relative path");
  return path;
}
export function contained(root: string, path: string) {
  const r = relative(root, resolve(path));
  return r === "" || (!r.startsWith("../") && !isAbsolute(r));
}
export async function safeParents(root: string, path: string) {
  safeRelative(path);
  const parts = path.split("/");
  parts.pop();
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    try {
      if ((await lstat(dir)).isSymbolicLink())
        throw Error("Symlink parent refused");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
export async function repoPath(input: string) {
  if (
    !isAbsolute(input) ||
    input.split("/").includes("..") ||
    input.includes("\0")
  )
    throw Error("Repository must be an absolute canonical root");
  const p = await realpath(input);
  if (
    ["/", homedir(), "/tmp", "/etc", "/usr", "/var", "/home", "/root"].includes(
      p,
    )
  )
    throw Error("Unsafe repository root");
  return p;
}
const values = Object.entries(process.env)
  .filter(
    ([k, v]) =>
      /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION/i.test(k) && v && v.length >= 8,
  )
  .map(([, v]) => v!);
export function redact(text: string, max = 48000) {
  for (const s of values) text = text.split(s).join("[REDACTED]");
  text = text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /(\b(?:api[_-]?key|authorization|password|access[_-]?token|secret)\b["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  const bytes = Buffer.from(text);
  return bytes.length > max
    ? bytes.subarray(0, max).toString("utf8") + "\n[truncated]"
    : text;
}
export function errorText(e: unknown) {
  return redact(
    e instanceof Error
      ? e.message
      : typeof e === "object" && e !== null && "message" in e
        ? String(e.message)
        : "Operation failed",
    2000,
  );
}
export function validId(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid worker ID");
  return id;
}
