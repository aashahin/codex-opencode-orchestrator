/** Version is only a baseline; API capabilities, policy and model checks decide compatibility. */
export function assertSupportedService(health: { healthy: boolean; version: string }): void {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(health.version);
  const supported = match && BigInt(match[1]!) >= 2n;
  if (!health.healthy || !supported) {
    throw Error(
      `Expected a healthy stable OpenCode >=2.0.0 service; received ${health.version} (healthy=${health.healthy}). Prereleases are unsupported.`,
    );
  }
}
