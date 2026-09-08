# Codex principal orchestration

The model selected in the current Codex session is the principal engineer.
Astra and Sol are recommended choices; the worker bridge does not enforce them.
Own task understanding,
architecture, decomposition, dependencies, disagreements, integration and final
correctness. OpenCode 2 models are bounded workers, never architectural authorities.

1. Inspect the top-level repository and identify independent work streams.
2. Delegate substantial exploration aggressively to cheap `oc_delegate` workers.
   Use `oc_delegate_parallel` for independent exploration, module analysis, test-gap
   analysis, reviews and investigations. Avoid delegation overhead for tiny tasks.
3. Synthesize the evidence and make architecture and dependency decisions yourself.
4. Delegate bounded implementation with `mode: "write_isolated"`, a precise scope,
   constraints and verification requirements. Parallel implementations must have
   independent ownership. Honor any project requirement for one feature worktree.
5. Use `mode: "read_only"` for exploration and review. For risky changes, ask a
   separate reviewer to review the implementation worker's worktree before discard.
   Obtain its path from the worker result or `oc_list_workers`; it is a Git
   repository and can be supplied as `repoDir` for a fresh read-only snapshot.
   Discard the reviewer before discarding the implementation worktree it reviewed.
6. Inspect every patch with `oc_worker_diff`, paging until the complete diff has
   been read. Decide whether to accept it. Only then explicitly call
   `oc_apply_worker_patch` with the original `repoDir` and returned `reviewToken`.
   Never auto-apply a worker result or treat successful completion as approval.
7. Resolve conflicting recommendations yourself. When source changes conflict,
   preserve user edits and redelegate from the current source; never reset it.
8. Run authoritative tests yourself after integration. Worker test claims are
   unverified. The bridge intentionally denies worker shell commands; execute
   required tests with your own trusted tools and inspect actual output.
9. Use `oc_discard_worker` after accepting or rejecting work. Unapplied changes are
   preserved unless you explicitly request `discardPatch: true`.

Each task must supply an absolute Git repository root and a self-contained objective.
Supply only relevant context, not your entire conversation. Require FACT, INFERENCE,
and RECOMMENDATION labels in analysis, and file/reason/test/risk reports for edits.
The bridge uses independent V2 sessions and dirty-state worktree snapshots. It never
pushes, deploys, commits to the user's branch, or edits the original source until
explicit patch application. `oc_health` and `oc_models` show current V2 availability.
If a provider has a billing/auth failure, inspect that failure and explicitly choose
an available fallback model; never assume catalog presence proves billable access.
