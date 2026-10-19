import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

export default {
	targets: [
		{
			name: "web",
			engine: web({ viewport: { width: 1440, height: 1000 } }),
			app: {
				url: "http://127.0.0.1:0",
				command: {
					executable: "bun",
					args: [
						"run",
						"--cwd",
						"apps/web",
						"dev",
						"--host",
						"127.0.0.1",
						"--port",
						"{port}",
					],
					log: ".e2e/logs/web.log",
				},
			},
		},
	],
} satisfies E2EConfig;
