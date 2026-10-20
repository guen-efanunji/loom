import type { RuntimeModel } from "@loom/providers";

export function runtimeModelRef(adapterId: string, modelId: string): RuntimeModel {
	if (adapterId === "opencode" && modelId.includes("/")) {
		const separator = modelId.indexOf("/");
		return {
			providerID: modelId.slice(0, separator),
			modelID: modelId.slice(separator + 1),
		};
	}
	return { providerID: adapterId, modelID: modelId };
}
