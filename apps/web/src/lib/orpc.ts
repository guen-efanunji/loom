import type { AppRouterClient } from "@loom/api/routers/index";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/svelte-query";
import { PUBLIC_SERVER_URL } from "$app/env/public";
import { dev } from "$app/environment";
import { provisionDaemonToken } from "$lib/daemon";

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error) => {
			console.error(`Error: ${error.message}`);
		},
	}),
});

function getServerUrl(url: string) {
	const processEnv = (
		globalThis as {
			process?: { env?: Record<string, string | undefined> };
		}
	).process?.env;
	if (typeof window === "undefined" && processEnv?.SERVER_URL) {
		return processEnv.SERVER_URL.endsWith("/")
			? processEnv.SERVER_URL.slice(0, -1)
			: processEnv.SERVER_URL;
	}

	const normalized = url.endsWith("/") ? url.slice(0, -1) : url;

	if (!normalized.startsWith("/")) {
		return normalized;
	}

	if (typeof window !== "undefined") {
		return `${window.location.origin}${normalized}`;
	}

	const vercelUrl =
		processEnv?.VERCEL_ENV === "production"
			? (processEnv?.VERCEL_PROJECT_PRODUCTION_URL ?? processEnv?.VERCEL_URL)
			: (processEnv?.VERCEL_URL ?? processEnv?.VERCEL_PROJECT_PRODUCTION_URL);
	if (vercelUrl) {
		const origin = vercelUrl.startsWith("http")
			? vercelUrl
			: `https://${vercelUrl}`;
		return `${origin}${normalized}`;
	}

	return `http://localhost:3000${normalized}`;
}
export const link = new RPCLink({
	url: `${getServerUrl(dev ? PUBLIC_SERVER_URL || "/" : "/")}/rpc`,
	async fetch(url, options) {
		const headers = new Headers(url instanceof Request ? url.headers : undefined);
		headers.set("Authorization", `Bearer ${await provisionDaemonToken()}`);
		return fetch(url, {
			...options,
			headers,
			credentials: "include",
		});
	},
});

export const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
