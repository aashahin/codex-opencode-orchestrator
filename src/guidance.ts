export const RECOVERY_GUIDANCE =
  "Recover through opencode_workers MCP: call oc_health and oc_list_workers, identify the worker by its bridge UUID and repository, and inspect any partial patch with oc_worker_diff. Confirm a running or quarantined worker has stopped through oc_cancel_worker/oc_discard_worker before starting replacement work. Review and apply acceptable changes with oc_apply_worker_patch, then use oc_delegate for the remaining task against the original repository. Preserve unapplied patches. Never resume a raw ses_ ID through the CLI or bypass the bridge with opencode2 run, --standalone, opencode run, or ad-hoc API/client scripts. If MCP is unavailable, repair/reconnect it or report the blocker; do not change transport.";

export const WORKFLOW_GUIDANCE = `OpenCode workers must use the opencode_workers MCP bridge.
- Use oc_delegate or oc_delegate_parallel for all OpenCode model work, including follow-up fixes and reviews. Keep Codex responsible for integration and final verification. Use the user's requested model; do not silently change it.
- Never use opencode2 run (including --standalone/--session), opencode run, or direct HTTP/SDK scripts as a worker fallback. Read-only service health/discovery commands are allowed; lifecycle changes must preserve other active sessions.
- After compaction, resume, or a worker error, recover current state before continuing. ${RECOVERY_GUIDANCE}
- Carry this transport requirement, original repoDir, bridge worker UUIDs, model, scope, patch review/application status, and next MCP action into every handoff or compaction summary. A previous CLI command in a summary is history, not authorization to repeat it.
- The bridge uses Git snapshots. If a repository cannot be snapshotted, resolve that prerequisite without modifying the user's source unexpectedly; do not bypass isolation. Workers cannot run shell tests; Codex runs authoritative checks.
- These rules apply to OpenCode workers. A user's explicit request for the separate Grok Build workflow still follows that workflow's own instructions.`;

const begin = "<!-- codex-opencode-orchestrator:begin -->";
const end = "<!-- codex-opencode-orchestrator:end -->";

export function mergeGuidance(source: string) {
  const block = `${begin}\n## OpenCode worker delegation and recovery\n\n${WORKFLOW_GUIDANCE}\n${end}`;
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if (start === -1 && finish === -1)
    return source + (source.endsWith("\n") ? "\n" : source ? "\n\n" : "") + block + "\n";
  if (
    start === -1 || finish < start ||
    source.indexOf(begin, start + begin.length) !== -1 ||
    source.indexOf(end, finish + end.length) !== -1
  ) throw Error("Malformed orchestration instruction markers; existing instructions preserved");
  return source.slice(0, start) + block + source.slice(finish + end.length);
}
