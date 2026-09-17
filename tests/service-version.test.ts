import { test, expect } from "bun:test";
import { assertSupportedService } from "../src/service-version";

test("admits stable compatible releases without pinning every patch", () => {
  for (const version of ["2.0.0", "2.0.1", "2.0.3", "2.0.4", "2.0.5", "2.1.0", "2.10.12", "3.0.0", "2.0.5+build"])
    expect(() => assertSupportedService({ healthy: true, version })).not.toThrow();
});

test("rejects prereleases, pre-V2 runtimes, malformed versions, and unhealthy services", () => {
  for (const version of ["", "1.9.0", "2.0.3-beta.1", "0.0.0-beta-19271", "2.00.3", "2.0.03", "2.0.3\n"])
    expect(() => assertSupportedService({ healthy: true, version })).toThrow("stable OpenCode");
  expect(() => assertSupportedService({ healthy: false, version: "2.0.3" })).toThrow("healthy=false");
});
