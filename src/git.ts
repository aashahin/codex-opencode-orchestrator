import { realpath } from "node:fs/promises";
import { repoPath } from "./security";
export async function command(
  argv: string[],
  options: {
    cwd?: string;
    input?: Uint8Array | string;
    env?: Record<string, string>;
    max?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: { ...env, ...options.env },
    stdin:
      options.input === undefined
        ? "ignore"
        : new Blob([
            typeof options.input === "string"
              ? options.input
              : Buffer.from(options.input),
          ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let failure: Error | undefined;
  const kill = () => {
    failure = Error("Command cancelled");
    child.kill(9);
  };
  options.signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(() => {
    failure = Error("Command timeout");
    child.kill(9);
  }, 60000);
  const read = async (
    stream: ReadableStream<Uint8Array>,
    max: number,
    fail: boolean,
  ) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > max) {
        if (fail) {
          failure = Error("Command output limit exceeded");
          child.kill(9);
        }
      } else chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  try {
    const [out, err, code] = await Promise.all([
      read(child.stdout, options.max ?? 32 * 1024 ** 2, true),
      read(child.stderr, 4096, false),
      child.exited,
    ]);
    if (failure) throw failure;
    if (code !== 0)
      throw Error(
        `${argv[0]} failed (${code}): ${err.toString().slice(0, 2000)}`,
      );
    return out;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
}

export function git(
  dir: string,
  args: string[],
  input?: Uint8Array | string,
  env?: Record<string, string>,
) {
  return command(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      dir,
      ...args,
    ],
    { input, env },
  );
}
export async function repository(input: string) {
  const dir = await repoPath(input);
  const root = (await git(dir, ["rev-parse", "--show-toplevel"]))
    .toString()
    .trim();
  if ((await realpath(root)) !== dir)
    throw Error("Supply the Git repository root");
  const common = await realpath(
    (
      await git(dir, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    )
      .toString()
      .trim(),
  );
  const head = (await git(dir, ["rev-parse", "--verify", "HEAD"]))
    .toString()
    .trim();
  return { dir, common, head };
}
