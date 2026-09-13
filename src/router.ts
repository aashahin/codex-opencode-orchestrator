import { preferences, roles, type Config, type Role } from "./config";
export interface Model {
  id: string;
  providerID: string;
  modelID: string;
  key: string;
  vision: boolean;
  cost: number;
  variants?: Array<{ id: string; reasoningEffort?: string }>;
  reasoningVariants?: Array<{id: string; effort: string}>;
}
export function choose(
  models: Model[],
  role: Role,
  config: Config,
  explicit?: string,
): Model {
  if (explicit) {
    const m = models.find((m) => m.key === explicit);
    if (!m) throw Error("Requested V2 model is unavailable");
    if (role === "vision" && !m.vision)
      throw Error("Requested model has no image input");
    return m;
  }
  const candidates = models.filter((m) => role !== "vision" || m.vision);
  for (const p of config.routing[role] ?? preferences[role]) {
    const m = candidates.find((m) => m.key === p);
    if (m) return m;
  }
  const score = (m: Model) =>
    (m.providerID === "opencode-go" ? 100 : 0) +
    (role === "implementer" && /kimi|code|qwen|glm/.test(m.id) ? 40 : 0) +
    (role === "hard_reasoning" && /pro|max|grok|kimi/.test(m.id) ? 40 : 0) +
    (role === "explorer" || role === "cheap"
      ? /flash|free|mini/.test(m.id)
        ? 40
        : 0
      : 0);
  const sorted = [...candidates].sort(
    (a, b) =>
      score(b) - score(a) || a.cost - b.cost || a.key.localeCompare(b.key),
  );
  if (!sorted[0]) throw Error(`No available V2 model for ${role}`);
  return sorted[0];
}
export function mappings(models: Model[], config: Config) {
  return Object.fromEntries(
    roles.map((r) => {
      try {
        return [r, choose(models, r, config).key];
      } catch {
        return [r, null];
      }
    }),
  );
}
