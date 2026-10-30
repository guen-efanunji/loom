import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const serverUrl =
		env.PUBLIC_SERVER_URL ||
		env.SERVER_URL ||
		`http://127.0.0.1:${env.LOOM_PORT || process.env.LOOM_PORT || "4318"}`;
	const proxy: ProxyOptions = {
		target: serverUrl,
		changeOrigin: true,
		configure: (proxyServer) => {
			// The daemon intentionally trusts this fixed local dev origin. Keep the
			// browser request same-origin with Vite so any available Vite port works.
			proxyServer.on("proxyReq", (proxyRequest) => {
				proxyRequest.setHeader("origin", "http://localhost:5173");
			});
			proxyServer.on("proxyReqWs", (proxyRequest) => {
				proxyRequest.setHeader("origin", "http://localhost:5173");
			});
		},
	};

	return {
		plugins: [tailwindcss(), sveltekit()],
		server: {
			proxy: {
				"/api": { ...proxy, ws: true },
				"/rpc": proxy,
			},
		},
	};
});
