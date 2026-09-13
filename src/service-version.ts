export const TESTED_OPENCODE_VERSION = "2.0.3";

/** Admit stable 2.x releases; runtime policy and model checks still apply. */
export function assertSupportedService(health: { healthy: boolean; version: string }): void {
  const match = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(health.version);
  const supported = match && (Number(match[1]) > 0 || Number(match[2]) >= 3);
  if (!health.healthy || !supported) {
    throw Error(
      `Expected a healthy stable OpenCode >=${TESTED_OPENCODE_VERSION} <3.0.0 service; received ${health.version} (healthy=${health.healthy}). Prereleases are unsupported.`,
    );
  }
}
