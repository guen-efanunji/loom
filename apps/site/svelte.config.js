import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: { "$ui": "../web/src/lib/components/ui", "$lib/components/ui": "../web/src/lib/components/ui" },
    paths: { base: process.env.SITE_BASE_PATH || "" },
  },
};
