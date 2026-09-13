import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Bridge } from "./delegate";
import { VERSION, TaskSchema } from "./config";
import { errorText, redact } from "./security";
import { WORKFLOW_GUIDANCE, RECOVERY_GUIDANCE } from "./guidance";
const Id = z.string().uuid();
export function createMcp(bridge: Bridge) {
  const server = new McpServer(
    { name: "opencode2-worker-bridge", version: VERSION },
    { instructions: WORKFLOW_GUIDANCE },
  );
  const respond = async (fn: () => Promise<unknown>) => {
    try {
      const value = await fn();
      const serialized = redact(JSON.stringify(value), 512000);
      let output;
      try {
        output = JSON.parse(serialized);
      } catch {
        output = {
          error:
            "Result exceeded output bound; use worker diff pagination or a narrower task.",
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `${errorText(e)}\n${RECOVERY_GUIDANCE}` }],
      };
    }
  };
  server.registerTool(
    "oc_health",
    {
      description:
        "Check OpenCode 2 shared service, V2 Go authentication, current routing and bridge health.",
      inputSchema: {},
    },
    () => respond(() => bridge.health()),
  );
  server.registerTool(
    "oc_models",
    {
      description:
        "Discover enabled worker models, their exact variants and advertised reasoning efforts, and role routing. Inspect variants before requesting xhigh, max, or another variant; availability is model-specific.",
      inputSchema: {},
    },
    () => respond(() => bridge.models()),
  );
  server.registerTool(
    "oc_delegate",
    {
      description:
        "Required path for OpenCode work, including follow-up fixes after compaction or errors. Never substitute opencode run, opencode2 run/--standalone or direct API scripts. Creates one isolated V2 session from a source snapshot; writes require write_isolated; no automatic integration. Select variant from oc_models (for example xhigh); reasoningEffort is also supported. Recover existing work with oc_list_workers first.",
      inputSchema: TaskSchema,
    },
    (args, extra) => respond(() => bridge.delegate(args, extra.signal)),
  );
  server.registerTool(
    "oc_delegate_parallel",
    {
      description:
        "Run independent workers through the MCP bridge in concurrent isolated V2 sessions, with individual failures and timeouts. Use this instead of parallel CLI processes; after compaction recover existing work with oc_list_workers first.",
      inputSchema: {
        tasks: z.array(TaskSchema).min(1).max(16),
        concurrency: z.number().int().min(1).max(8).optional(),
      },
    },
    (args, extra) =>
      respond(() =>
        bridge.delegateParallel(args.tasks, args.concurrency, extra.signal),
      ),
  );
  server.registerTool(
    "oc_worker_diff",
    {
      description:
        "Inspect a paginated worker patch. Read all bytes to receive reviewToken required for explicit application.",
      inputSchema: {
        id: Id,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(256).max(48000).default(20000),
      },
    },
    (a) => respond(() => bridge.diff(a.id, a.offset, a.limit)),
  );
  server.registerTool(
    "oc_apply_worker_patch",
    {
      description:
        "Explicitly apply a fully inspected patch. Reject changed HEAD, repository mismatch and conflicts; preserve user index; never commit or push.",
      inputSchema: {
        id: Id,
        repoDir: z.string(),
        reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
      },
    },
    (a) => respond(() => bridge.apply(a.id, a.repoDir, a.reviewToken)),
  );
  server.registerTool(
    "oc_discard_worker",
    {
      description:
        "Stop and remove worker resources. Unapplied patches are preserved unless discardPatch:true explicitly discards them.",
      inputSchema: { id: Id, discardPatch: z.boolean().default(false) },
    },
    (a) => respond(() => bridge.discard(a.id, a.discardPatch)),
  );
  server.registerTool(
    "oc_cancel_worker",
    {
      description:
        "Interrupt a worker session without destroying uncollected changes.",
      inputSchema: { id: Id },
    },
    (a) => respond(() => bridge.cancel(a.id)),
  );
  server.registerTool(
    "oc_list_workers",
    {
      description:
        "Call after compaction, resume, or worker errors to recover durable worker state. Match bridge UUID and repository; raw ses_ IDs are not CLI resume handles. Preserve patches, inspect with oc_worker_diff, and use oc_delegate for remaining work. Never fall back to standalone CLI execution.",
      inputSchema: {},
    },
    () => respond(async () => ({ workers: await bridge.state.list() })),
  );
  return server;
}
