import type { ProviderDefinition } from "../core";

export const claudeCodeDefinition: ProviderDefinition = {
	id: "claude",
	name: "Claude Code CLI",
	executable: "claude",
	homepage: "https://code.claude.com/docs/en/overview",
	authCommand: ["auth", "login"],
	capabilities: [],
	install: { supported: true, url: "https://code.claude.com/docs/en/overview" },
	authStrategy: "provider-managed",
};

export const codexDefinition: ProviderDefinition = {
	id: "codex",
	name: "Codex CLI",
	executable: "codex",
	homepage: "https://learn.chatgpt.com/docs/codex/cli",
	authCommand: ["login"],
	capabilities: [],
	install: { supported: true, url: "https://developers.openai.com/codex/cli/" },
	authStrategy: "provider-managed",
};

export const antigravityDefinition: ProviderDefinition = {
	id: "antigravity",
	name: "Antigravity CLI",
	executable: "agy",
	homepage: "https://antigravity.google/product/antigravity-cli/",
	authCommand: ["login"],
	capabilities: [],
	install: {
		supported: true,
		url: "https://antigravity.google/product/antigravity-cli/",
	},
	authStrategy: "provider-managed",
};

export const grokDefinition: ProviderDefinition = {
	id: "grok",
	name: "Grok CLI",
	executable: "grok",
	homepage: "https://docs.x.ai/docs/overview",
	authCommand: ["login"],
	capabilities: [],
	install: { supported: false, url: "https://docs.x.ai/docs/overview" },
	authStrategy: "provider-managed",
};
