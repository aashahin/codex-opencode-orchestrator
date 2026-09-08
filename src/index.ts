import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config";
import { Bridge } from "./delegate";
import { createMcp } from "./mcp";
import { errorText } from "./security";
process.umask(0o077);
const bridge = new Bridge(await loadConfig());
const server = createMcp(bridge);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await bridge.close();
  await server.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
process.stdin.on("end", () => void close());
process.on("uncaughtException", (e) => {
  console.error(errorText(e));
  void close();
});
await server.connect(new StdioServerTransport());
