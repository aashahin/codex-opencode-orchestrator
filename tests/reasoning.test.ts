import { expect, test } from "bun:test";
import { TaskSchema } from "../src/config";
import { requestedModel, verifyModelSelection } from "../src/reasoning";
import type { Model } from "../src/router";

const model: Model = {
  id: "fixture", modelID: "fixture", key: "opencode-go/fixture",
  providerID: "opencode-go", vision: true, cost: 0,
  variants: [{ id: "xhigh", reasoningEffort: "xhigh" }, { id: "deep", reasoningEffort: "high" }, { id: "max" }],
};

test("exact variants and the existing effort input select advertised SDK variants", () => {
  const task = TaskSchema.parse({ task: "verify", repoDir: "/tmp/repo", variant: "xhigh", reasoningEffort: "xhigh" });
  expect(requestedModel(model, task.reasoningEffort, task.variant)).toEqual({ id: "fixture", providerID: "opencode-go", variant: "xhigh" });
  expect(requestedModel(model, "xhigh").variant).toBe("xhigh");
  expect(requestedModel(model, "high").variant).toBe("deep");
  expect(requestedModel(model, undefined, "max").variant).toBe("max");
  expect(requestedModel(model)).toEqual({ id: "fixture", providerID: "opencode-go" });
});

test("unknown and conflicting variants fail without downgrading", () => {
  expect(() => requestedModel(model, undefined, "ultra")).toThrow("not advertised");
  expect(() => requestedModel(model, "high", "xhigh")).toThrow("does not advertise");
  expect(() => requestedModel(model, "max", "max")).toThrow("does not advertise");
  expect(() => requestedModel(model, "low")).toThrow("not uniquely advertised");
  expect(() => requestedModel({ ...model, variants: [] }, undefined, "xhigh")).toThrow();
});

test("ambiguous effort requires an exact variant unless the matching named variant exists", () => {
  const variants = [{ id: "deep", reasoningEffort: "high" }, { id: "thorough", reasoningEffort: "high" }];
  expect(() => requestedModel({ ...model, variants }, "high")).toThrow("not uniquely advertised");
  expect(requestedModel({ ...model, variants: [...variants, { id: "high", reasoningEffort: "high" }] }, "high").variant).toBe("high");
});

test("effective model checks reject a lost or changed selection", () => {
  const expected = requestedModel(model, undefined, "xhigh");
  verifyModelSelection(expected, expected);
  for (const actual of [undefined, { ...expected, variant: undefined }, { ...expected, variant: "high" }, { ...expected, id: "other" }, { ...expected, providerID: "other" }])
    expect(() => verifyModelSelection(expected, actual)).toThrow("did not preserve");
});
