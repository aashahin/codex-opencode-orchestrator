import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../src/git";
import { ConfigSchema } from "../src/config";
export const config = ConfigSchema.parse({});
export async function fixture() {
  const dir = await mkdtemp("/tmp/oc-bridge-test-");
  await git(dir, ["init", "-q"]);
  await writeFile(join(dir, "a.txt"), "base\n");
  await writeFile(join(dir, "other.txt"), "other\n");
  await git(dir, ["add", "--", "a.txt", "other.txt"]);
  await git(dir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-qm",
    "initial",
  ]);
  return dir;
}
export const dispose = (dir: string) =>
  rm(dir, { recursive: true, force: true });
