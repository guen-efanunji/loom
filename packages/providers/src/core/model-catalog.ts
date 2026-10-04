import type { AgentModel, ModelRef } from "./types";

export interface ModelCatalog {
	set(models: AgentModel[]): void;
	replaceConnection(connectionId: string, models: AgentModel[]): void;
	listAvailable(): AgentModel[];
	listByProvider(providerId: string): AgentModel[];
	get(ref: ModelRef): AgentModel | null;
	all(): AgentModel[];
}

export class InMemoryModelCatalog implements ModelCatalog {
	private readonly models = new Map<string, AgentModel>();

	set(models: AgentModel[]): void {
		for (const model of models) this.models.set(model.id, model);
	}

	replaceConnection(connectionId: string, models: AgentModel[]): void {
		for (const [id, model] of this.models) {
			if (model.connectionId === connectionId)
				this.models.set(id, { ...model, isAvailable: false });
		}
		this.set(models);
	}

	listAvailable(): AgentModel[] {
		return [...this.models.values()].filter((model) => model.isAvailable);
	}

	listByProvider(providerId: string): AgentModel[] {
		return this.listAvailable().filter(
			(model) => model.providerId === providerId,
		);
	}

	get(ref: ModelRef): AgentModel | null {
		return (
			this.models.get(compositeModelId(ref)) ??
			[...this.models.values()].find(
				(model) =>
					model.providerId === ref.providerId &&
					model.connectionId === ref.connectionId &&
					model.metadata?.modelId === ref.modelId,
			) ??
			null
		);
	}

	all(): AgentModel[] {
		return [...this.models.values()];
	}
}

export function compositeModelId(ref: ModelRef): string {
	return `${ref.providerId}:${ref.connectionId}:${ref.modelId}`;
}

export function normalizeModel(
	input: Omit<AgentModel, "id"> & { id?: string; modelId?: string },
): AgentModel {
	const metadataModelId = input.metadata?.modelId;
	const modelId =
		input.modelId ??
		(typeof metadataModelId === "string" ? metadataModelId : undefined);
	if (!modelId) throw new Error("A normalized model requires a model ID");
	const ref = {
		providerId: input.providerId,
		connectionId: input.connectionId,
		modelId,
	};
	return {
		...input,
		id: input.id ?? compositeModelId(ref),
		metadata: { ...input.metadata, modelId },
	};
}
