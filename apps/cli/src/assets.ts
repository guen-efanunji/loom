declare const LOOM_STATIC_ASSETS: Record<string, { body: string; type: string }>;
export const staticAssets = typeof LOOM_STATIC_ASSETS === "undefined" ? undefined : LOOM_STATIC_ASSETS;
