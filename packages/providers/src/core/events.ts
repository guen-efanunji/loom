import type { AgentEvent, AgentModel, ProviderConnection } from "./types";

export type ProviderEvent =
	| {
			type: "provider.detected";
			providerId: string;
			connection: ProviderConnection;
	  }
	| {
			type: "provider.connected";
			providerId: string;
			connection: ProviderConnection;
	  }
	| { type: "provider.disconnected"; providerId: string }
	| { type: "provider.authRequired"; providerId: string }
	| { type: "provider.modelsUpdated"; providerId: string; models: AgentModel[] }
	| { type: "provider.error"; providerId: string; message: string };

export type ProviderEventListener = (
	event: ProviderEvent,
) => void | Promise<void>;
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
