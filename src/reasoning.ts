import type { ModelRef } from "@opencode/client";
import type { Model } from "./router";

export function requestedModel(model: Model, effort?: string, variantID?: string): ModelRef {
  const selection: ModelRef = { id: model.id, providerID: model.providerID };
  if (!effort && !variantID) return selection;
  const variants = model.variants ?? [];
  let variant;
  if (variantID) {
    variant = variants.find(v => v.id === variantID);
    if (!variant) throw Error(`Requested variant ${variantID} is not advertised by ${model.key}`);
    if (effort && variant.reasoningEffort !== effort)
      throw Error(`Requested variant ${variantID} does not advertise reasoning effort ${effort}`);
  } else {
    const matches = variants.filter(v => v.reasoningEffort === effort);
    variant = matches.find(v => v.id === effort);
    if (!variant && matches.length === 1) variant = matches[0];
    if (!variant) throw Error(`Requested reasoning effort ${effort} is not uniquely advertised by ${model.key}; select an exact variant from oc_models`);
  }
  return { ...selection, variant: variant.id };
}

export function verifyModelSelection(expected: ModelRef, actual?: ModelRef) {
  if (actual?.id !== expected.id || actual.providerID !== expected.providerID ||
      (expected.variant !== undefined && actual.variant !== expected.variant)) {
    throw Error("OpenCode did not preserve the requested model and reasoning variant");
  }
}
