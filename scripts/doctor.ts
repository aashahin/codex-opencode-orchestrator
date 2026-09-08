import { Bridge } from "../src/delegate";
import { loadConfig, paths } from "../src/config";
import { errorText } from "../src/security";
import TOML from "@iarna/toml";
import { join } from "node:path";
import { homedir } from "node:os";
const b = new Bridge(await loadConfig());
try {
  const h = await b.health();
  const config = TOML.parse(
    await Bun.file(
      join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
    ).text(),
  );
  console.log(
    JSON.stringify(
      {
        health: h,
        config: {
          globalZenProvider: Boolean(
            (config.model_providers as Record<string, unknown>)?.opencode_zen,
          ),
          zenProviderRequiredForWorkers: false,
          mcpRegistered: Boolean(
            (config.mcp_servers as Record<string, unknown>)?.opencode_workers,
          ),
          path: paths.config,
        },
        workers: await b.state.list(),
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(errorText(e));
  process.exitCode = 1;
} finally {
  await b.close();
}
