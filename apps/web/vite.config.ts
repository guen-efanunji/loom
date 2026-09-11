import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		varlockVitePlugin({ ssrInjectMode: "auto-load" }),
		tailwindcss(),
		sveltekit(),
	],
});
