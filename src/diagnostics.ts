import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "./config";
import { errorText } from "./security";
export async function recordProviderProbe(
  provider: string,
  model: string,
  success: boolean,
  error?: unknown,
) {
  if (!["opencode", "opencode-go"].includes(provider)) return;
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const tmp = join(paths.state, `probe-${randomUUID()}.tmp`);
  await writeFile(
    tmp,
    JSON.stringify({
      model,
      success,
      checkedAt: new Date().toISOString(),
      error: error ? errorText(error) : undefined,
    }),
    { mode: 0o600 },
  );
  await rename(tmp, join(paths.state, `provider-${provider}.json`));
}
export async function providerProbe(provider: string) {
  try {
    return JSON.parse(
      await readFile(join(paths.state, `provider-${provider}.json`), "utf8"),
    );
  } catch {
    return { success: null, message: "No live probe recorded" };
  }
}
