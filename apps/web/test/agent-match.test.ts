import { describe, expect, test } from "bun:test";
import { suggestAgentForMessage, type AgentLike } from "../src/lib/agent-match";

const agents: AgentLike[] = [
	{
		id: "agent-fe",
		label: "FRONTEND",
		role: "frontend",
		status: "active",
		allowChat: true,
		projectId: "project-1",
	},
	{
		id: "agent-be",
		label: "AGENT BE",
		role: "backend",
		status: "active",
		allowChat: true,
		projectId: "project-1",
	},
	{
		id: "agent-off",
		label: "Disabled frontend",
		role: "frontend",
		status: "disabled",
		allowChat: true,
		projectId: "project-1",
	},
	{
		id: "agent-nokanban",
		label: "No chat frontend",
		role: "frontend",
		status: "active",
		allowChat: false,
		projectId: "project-1",
	},
];

describe("suggestAgentForMessage", () => {
	test("suggests the FE agent for a landing page request", () => {
		const match = suggestAgentForMessage(
			"Buatkan landing page produk kami, yang bagus dan modern",
			agents,
			"project-1",
		);
		expect(match?.agent.id).toBe("agent-fe");
	});

	test("suggests the BE agent for an api request", () => {
		const match = suggestAgentForMessage(
			"Tambahkan endpoint api baru untuk reset password",
			agents,
			"project-1",
		);
		expect(match?.agent.id).toBe("agent-be");
	});

	test("matches by label when the user names the agent", () => {
		const match = suggestAgentForMessage(
			"FRONTEND, kerjakan tugas ini",
			agents,
			"project-1",
		);
		expect(match?.agent.id).toBe("agent-fe");
	});

	test("returns undefined for small talk", () => {
		expect(
			suggestAgentForMessage("Halo, bagaimana cara kerja ini?", agents, "project-1"),
		).toBeUndefined();
	});

	test("excludes disabled and non-chat agents", () => {
		const onlyDisabled = agents.filter(
			(agent) => agent.id === "agent-off" || agent.id === "agent-nokanban",
		);
		expect(
			suggestAgentForMessage(
				"Buatkan landing page baru",
				onlyDisabled,
				"project-1",
			),
		).toBeUndefined();
	});

	test("excludes agents from other projects", () => {
		expect(
			suggestAgentForMessage(
				"Buatkan landing page baru",
				agents,
				"other-project",
			),
		).toBeUndefined();
	});

	test("stays quiet when two roles match equally", () => {
		const tie = suggestAgentForMessage(
			"Buatkan halaman api yang tampil di sisi depan",
			agents,
			"project-1",
		);
		// Both roles score similarly — the matcher must not guess.
		expect(tie).toBeUndefined();
	});
});
