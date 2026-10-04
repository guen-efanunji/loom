import type { ProviderEvent, ProviderEventListener } from "./events";
import { InMemoryModelCatalog } from "./model-catalog";
import type { ProviderRegistry } from "./registry";
import {
	type AgentModel,
	type AgentRuntime,
	type ProviderConnection,
	ProviderError,
} from "./types";

export type ProviderManagerOptions = {
	registry: ProviderRegistry;
	onEvent?: ProviderEventListener;
};

export class ProviderManager {
	readonly catalog = new InMemoryModelCatalog();
	private readonly connections = new Map<string, ProviderConnection>();
	private readonly listeners = new Set<ProviderEventListener>();
	readonly registry: ProviderRegistry;

	constructor(options: ProviderManagerOptions) {
		this.registry = options.registry;
		if (options.onEvent) this.listeners.add(options.onEvent);
	}

	subscribe(listener: ProviderEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): ProviderConnection[] {
		return [...this.connections.values()];
	}

	get(providerIdOrConnectionId: string): ProviderConnection | undefined {
		const providerId = this.normalizeProviderId(providerIdOrConnectionId);
		return this.connections.get(connectionId(providerId));
	}

	getByConnectionId(id: string): ProviderConnection | undefined {
		return this.connections.get(id);
	}

	normalizeProviderId(providerIdOrConnectionId: string): string {
		if (this.registry.get(providerIdOrConnectionId))
			return providerIdOrConnectionId;
		const adapter = this.registry
			.list()
			.find(
				(item) => connectionId(item.definition.id) === providerIdOrConnectionId,
			);
		if (adapter) return adapter.definition.id;
		return this.registry.require(providerIdOrConnectionId).definition.id;
	}

	async refreshAll(): Promise<ProviderConnection[]> {
		const results = await Promise.allSettled(
			this.registry
				.list()
				.map((adapter) => this.refresh(adapter.definition.id)),
		);
		return results.map((result, index) => {
			if (result.status === "fulfilled") return result.value;
			const adapter = this.registry.list()[index];
			if (!adapter) throw new Error("Provider registry changed during refresh");
			return this.setConnection(adapter.definition.id, {
				status: "error",
				error: errorMessage(result.reason),
			});
		});
	}

	async refresh(providerIdOrConnectionId: string): Promise<ProviderConnection> {
		const providerId = this.normalizeProviderId(providerIdOrConnectionId);
		const adapter = this.registry.require(providerId);
		this.setConnection(providerId, { status: "checking", error: undefined });
		try {
			const detection = await adapter.detect();
			const auth = detection.installed
				? await adapter.getAuthStatus()
				: { authenticated: false, strategy: adapter.definition.authStrategy };
			const connection = this.setConnection(providerId, {
				status: !detection.installed
					? "disconnected"
					: auth.authenticated
						? "connected"
						: "auth-required",
				executablePath: detection.executablePath ?? null,
				version: detection.version ?? null,
				authenticated: auth.authenticated,
				error: detection.error,
			});
			await this.emit({ type: "provider.detected", providerId, connection });
			if (connection.status === "connected")
				await this.refreshModels(providerId);
			return connection;
		} catch (error) {
			this.catalog.replaceConnection(connectionId(providerId), []);
			const connection = this.setConnection(providerId, {
				status: "error",
				error: errorMessage(error),
			});
			await this.emit({
				type: "provider.error",
				providerId,
				message: connection.error ?? "Provider check failed",
			});
			return connection;
		}
	}

	async connect(
		providerIdOrConnectionId: string,
		input?: { cwd?: string },
	): Promise<ProviderConnection> {
		const providerId = this.normalizeProviderId(providerIdOrConnectionId);
		const adapter = this.registry.require(providerId);
		this.setConnection(providerId, { status: "checking", error: undefined });
		try {
			const detection = await adapter.detect();
			if (!detection.installed) {
				this.catalog.replaceConnection(connectionId(providerId), []);
				return this.setConnection(providerId, {
					status: "disconnected",
					error: "Provider is not installed",
				});
			}
			const auth = await adapter.authenticate(input);
			const connection = this.setConnection(providerId, {
				status: auth.status.authenticated ? "connected" : "auth-required",
				executablePath: detection.executablePath ?? null,
				version: detection.version ?? null,
				authenticated: auth.status.authenticated,
				error: auth.status.message,
			});
			if (connection.status === "connected") {
				await this.emit({ type: "provider.connected", providerId, connection });
				await this.refreshModels(providerId);
			} else await this.emit({ type: "provider.authRequired", providerId });
			return connection;
		} catch (error) {
			this.catalog.replaceConnection(connectionId(providerId), []);
			const connection = this.setConnection(providerId, {
				status: "error",
				error: errorMessage(error),
			});
			await this.emit({
				type: "provider.error",
				providerId,
				message: connection.error ?? "Provider connection failed",
			});
			return connection;
		}
	}

	async disconnect(
		providerIdOrConnectionId: string,
	): Promise<ProviderConnection | undefined> {
		const providerId = this.normalizeProviderId(providerIdOrConnectionId);
		const adapter = this.registry.require(providerId);
		await adapter.disconnect();
		const current = this.get(providerId);
		this.catalog.replaceConnection(connectionId(providerId), []);
		let disconnected: ProviderConnection | undefined;
		if (current) {
			disconnected = {
				...current,
				status: "disconnected",
				authenticated: false,
			};
			this.connections.set(current.id, disconnected);
		}
		await this.emit({ type: "provider.disconnected", providerId });
		return disconnected;
	}

	async refreshModels(providerIdOrConnectionId: string): Promise<AgentModel[]> {
		const providerId = this.normalizeProviderId(providerIdOrConnectionId);
		const adapter = this.registry.require(providerId);
		const connection = this.get(providerId);
		if (connection?.status !== "connected") {
			this.catalog.replaceConnection(connectionId(providerId), []);
			return [];
		}
		if (!adapter.definition.capabilities.includes("models")) return [];
		const models = await adapter.listModels();
		this.catalog.replaceConnection(connection.id, models);
		await this.emit({ type: "provider.modelsUpdated", providerId, models });
		return models;
	}

	getModels(providerIdOrConnectionId?: string): AgentModel[] {
		return providerIdOrConnectionId
			? this.catalog.listByProvider(
					this.normalizeProviderId(providerIdOrConnectionId),
				)
			: this.catalog.listAvailable();
	}

	resolve(selection?: {
		providerId?: string;
		connectionId?: string;
		modelId?: string;
	}): {
		adapter: ReturnType<ProviderRegistry["require"]>;
		connection: ProviderConnection;
		model: AgentModel | null;
	} {
		const providerId = selection?.providerId ?? "opencode";
		const adapter = this.registry.require(providerId);
		const connection = selection?.connectionId
			? this.getByConnectionId(selection.connectionId)
			: this.get(providerId);
		if (connection?.status !== "connected")
			throw new ProviderError(
				"AUTH_REQUIRED",
				`Provider is not connected: ${providerId}`,
				{ providerId },
			);
		const model = selection?.modelId
			? this.catalog.get({
					providerId,
					connectionId: connection.id,
					modelId: selection.modelId,
				})
			: null;
		return { adapter, connection, model };
	}

	getRuntime(providerId = "opencode"): AgentRuntime {
		const runtime = this.registry.require(providerId).getRuntime?.();
		if (!runtime)
			throw new ProviderError(
				"UNSUPPORTED",
				`Runtime is not available for provider: ${providerId}`,
				{ providerId },
			);
		return runtime;
	}

	private setConnection(
		providerId: string,
		patch: Partial<ProviderConnection>,
	): ProviderConnection {
		const adapter = this.registry.require(providerId);
		const id = connectionId(providerId);
		const previous = this.connections.get(id);
		const connection: ProviderConnection = {
			id,
			providerId,
			name: previous?.name ?? adapter.definition.name,
			status: previous?.status ?? "disconnected",
			executablePath: previous?.executablePath ?? null,
			version: previous?.version ?? null,
			authenticated: previous?.authenticated ?? false,
			authCommand: adapter.definition.authCommand ?? null,
			lastCheckedAt: new Date().toISOString(),
			capabilities: [...adapter.definition.capabilities],
			...patch,
		};
		this.connections.set(id, connection);
		return connection;
	}

	private async emit(event: ProviderEvent): Promise<void> {
		await Promise.all([...this.listeners].map((listener) => listener(event)));
	}
}

export function connectionId(providerId: string): string {
	return `${providerId}:local`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
