/**
 * Conservative first-message → registered-agent matcher.
 *
 * When a fresh chat tab gets its first message and the text looks like the
 * specialty of exactly one registered (custom) agent, the composer offers a
 * one-click "hand off to <agent>?" suggestion. Pure client-side heuristics —
 * zero latency, no new API, and the suggestion is opt-in (the user confirms).
 */

export type AgentLike = {
	id: string;
	label: string;
	role?: string;
	roleDescription?: string | null;
	allowChat?: boolean;
	status?: string;
	provider?: string;
	modelId?: string | null;
	projectId?: string | null;
};

/** Role keyword dictionaries. Keys align with the settings agents role list. */
const ROLE_SIGNALS: Record<string, RegExp> = {
	uiux: /\b(ui|ux|desain|design|figma|mockup|wireframe|typography|palet|warna|color)\b/i,
	frontend:
		/\b(frontend|front-end|landing|halaman|page|component|komponen|ui web|css|tailwind|svelte|react|vue|html|responsive|animasi|animation|hero|navbar|form)\b/i,
	backend:
		/\b(backend|back-end|api|endpoint|server|database|db|migration|migrasi|schema|skema|sql|auth|autentikasi|queue|cron|webhook)\b/i,
	fullstack:
		/\b(fullstack|full-stack|full stack|fitur|feature|aplikasi|app|integrasi|integration)\b/i,
	qa: /\b(qa|test|testing|uji|bug|regression|regresi|unit test|e2e|playwright)\b/i,
	pm: /\b(pm|product|roadmap|road map|epic|user story|backlog|prioritas|prioritize|spec|spesifikasi|breakdown)\b/i,
};

const GENERIC_BUILD =
	/\b(buat|bikin|build|create|implement|tambahkan|add|improve|perbaiki|fix|refactor|redesign|kerjakan|tolong)\b/i;

export type AgentMatch = {
	agent: AgentLike;
	/** 0..1 rough confidence; used only to pick between multiple candidates. */
	score: number;
	reason: "role" | "label";
};

/**
 * Pick at most one suggested agent for a first chat message.
 * Returns undefined when nothing matches confidently enough to suggest.
 */
export function suggestAgentForMessage(
	text: string,
	agents: AgentLike[],
	currentProjectId: string,
): AgentMatch | undefined {
	const eligible = agents.filter(
		(agent) =>
			agent.allowChat !== false &&
			(agent.status ?? "active") === "active" &&
			(!agent.projectId || agent.projectId === currentProjectId),
	);
	if (!eligible.length) return;
	const normalized = text.slice(0, 500);
	const scored: AgentMatch[] = [];
	for (const agent of eligible) {
		let score = 0;
		let reason: AgentMatch["reason"] = "role";
		const role = (agent.role ?? "").toLowerCase();
		if (role) {
			const signal = ROLE_SIGNALS[role];
			if (signal?.test(normalized)) score += 2;
			// Also match when the agent's own label names its specialty.
			if (new RegExp(`\\b${escapeRegExp(role)}\\b`, "i").test(normalized))
				score += 2;
		}
		const label = agent.label;
		if (
			label &&
			label.length > 2 &&
			new RegExp(`\\b${escapeRegExp(label)}\\b`, "i").test(normalized)
		) {
			score += 3;
			reason = "label";
		}
		// A build verb makes a delegation suggestion plausible at all.
		if (score > 0 && GENERIC_BUILD.test(normalized)) score += 1;
		if (score > 0) scored.push({ agent, score, reason });
	}
	if (!scored.length) return;
	scored.sort((a, b) => b.score - a.score);
	const best = scored[0]!;
	// Only suggest when clearly ahead of the runner-up — avoid noisy guesses
	// when backend and frontend agents both plausibly apply.
	const runnerUp = scored[1];
	if (runnerUp && best.score - runnerUp.score < 2) return;
	if (best.score < 2) return;
	return best;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
