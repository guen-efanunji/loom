import type { CliProviderAdapter } from "./types";

export class ProviderRegistry {
	private readonly providers = new Map<string, CliProviderAdapter>();

	register(adapter: CliProviderAdapter): this {
		if (this.providers.has(adapter.definition.id))
			throw new Error(
				`Provider is already registered: ${adapter.definition.id}`,
			);
		this.providers.set(adapter.definition.id, adapter);
		return this;
	}

	get(providerId: string): CliProviderAdapter | undefined {
		return this.providers.get(providerId);
	}

	require(providerId: string): CliProviderAdapter {
		const adapter = this.get(providerId);
		if (!adapter) throw new Error(`Provider is not registered: ${providerId}`);
		return adapter;
	}

	list(): CliProviderAdapter[] {
		return [...this.providers.values()];
	}
}
