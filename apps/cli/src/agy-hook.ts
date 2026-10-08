// Reads a PreToolUse hook payload from Agy on stdin and prints a decision on
// stdout. Agy blocks the tool until this process exits, which is what lets the
// Loom web UI gate a run's tools with Accept/Reject. When the per-run permission
// environment is absent the process is running for a non-Loom Agy session, so it
// immediately allows and never contacts the daemon — this is the env gate that
// keeps the global hook inert outside Loom.
type PreToolUsePayload = {
	toolCall?: { name?: string; args?: Record<string, unknown> };
	stepIdx?: number;
	conversationId?: string;
};

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function emit(decision: string, reason?: string) {
	process.stdout.write(
		`${JSON.stringify(reason ? { decision, reason } : { decision })}\n`,
	);
}

function report(event: string, error: unknown) {
	process.stderr.write(
		`${JSON.stringify({
			component: "agy-hook",
			event,
			error: error instanceof Error ? error.message : String(error),
		})}\n`,
	);
}

export async function runAgyHook(): Promise<number> {
	const url = process.env.LOOM_PERMISSION_URL;
	const token = process.env.LOOM_PERMISSION_TOKEN;
	// Env gate: not a Loom-driven run, so let the tool proceed untouched.
	if (!url || !token) {
		emit("allow");
		return 0;
	}

	let payload: PreToolUsePayload = {};
	try {
		const raw = await readStdin();
		if (raw.trim()) payload = JSON.parse(raw) as PreToolUsePayload;
	} catch (error) {
		report("stdin-parse-failed", error);
	}

	try {
		const response = await fetch(`${url.replace(/\/$/, "")}/request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token,
				conversationId: payload.conversationId ?? "",
				toolName: payload.toolCall?.name ?? "unknown",
				args: payload.toolCall?.args ?? {},
				stepIdx: payload.stepIdx ?? 0,
			}),
		});
		if (!response.ok) {
			// The daemon rejected the run (unknown/expired): deny rather than run a
			// gated tool the user never had a chance to approve.
			emit("deny", "Loom permission service unavailable");
			return 0;
		}
		const body = (await response.json()) as { decision?: string };
		emit(body.decision === "deny" ? "deny" : "allow");
		return 0;
	} catch (error) {
		report("permission-request-failed", error);
		// Cannot reach the daemon to obtain a decision: deny and let the run continue.
		emit("deny", "Loom permission request failed");
		return 0;
	}
}
