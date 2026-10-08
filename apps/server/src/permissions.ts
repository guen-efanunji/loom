import { randomUUID } from "node:crypto";

export type AgyPermissionDecision = "allow" | "deny";

export type AgyPermissionRequest = {
	id: string;
	token: string;
	sessionId: string;
	conversationId: string;
	toolName: string;
	args: Record<string, unknown>;
	stepIdx: number;
	createdAt: number;
};

export type SubmitResult =
	| { status: "unknown" }
	| { status: "auto" }
	| {
			status: "pending";
			request: AgyPermissionRequest;
			decision: Promise<AgyPermissionDecision>;
	  };

type PendingEntry = {
	request: AgyPermissionRequest;
	resolve: (decision: AgyPermissionDecision) => void;
	timer: ReturnType<typeof setTimeout>;
};

/**
 * Correlates a spawned Agy run (identified by a per-run secret token) with its
 * Loom chat session and tracks the tool-permission requests its PreToolUse hook
 * raises. The hook blocks on the returned promise until the user clicks
 * Accept/Reject; when auto-accept is on for the run, requests are approved
 * immediately without ever surfacing in the UI. A single-user local daemon makes
 * an in-memory store sufficient, so pending requests are never persisted.
 */
export function createAgyPermissionStore() {
	const runs = new Map<string, { sessionId: string; autoAccept: boolean }>();
	const pending = new Map<string, PendingEntry>();

	const settle = (id: string, decision: AgyPermissionDecision) => {
		const entry = pending.get(id);
		if (!entry) return false;
		clearTimeout(entry.timer);
		pending.delete(id);
		entry.resolve(decision);
		return true;
	};

	return {
		registerRun(input: {
			token: string;
			sessionId: string;
			autoAccept: boolean;
		}) {
			runs.set(input.token, {
				sessionId: input.sessionId,
				autoAccept: input.autoAccept,
			});
		},
		unregisterRun(token: string) {
			runs.delete(token);
		},
		// "Always allow" flips the in-flight run so later tools auto-approve.
		enableAutoAccept(sessionId: string) {
			for (const run of runs.values())
				if (run.sessionId === sessionId) run.autoAccept = true;
		},
		/**
		 * Records a hook request. Returns `unknown` for an unregistered run (the
		 * daemon denies it), `auto` when the run auto-accepts, or a
		 * `pending` request whose `decision` promise the caller awaits. The request
		 * is registered synchronously so the chat poll can surface it meanwhile.
		 */
		submit(
			input: {
				token: string;
				conversationId: string;
				toolName: string;
				args: Record<string, unknown>;
				stepIdx: number;
			},
			timeoutMs: number,
		): SubmitResult {
			const run = runs.get(input.token);
			if (!run) return { status: "unknown" };
			if (run.autoAccept) return { status: "auto" };
			const request: AgyPermissionRequest = {
				id: randomUUID(),
				token: input.token,
				sessionId: run.sessionId,
				conversationId: input.conversationId,
				toolName: input.toolName,
				args: input.args,
				stepIdx: input.stepIdx,
				createdAt: Date.now(),
			};
			let resolve!: (decision: AgyPermissionDecision) => void;
			const decision = new Promise<AgyPermissionDecision>((done) => {
				resolve = done;
			});
			const timer = setTimeout(() => {
				// No decision within the window: deny the tool, let the run continue.
				pending.delete(request.id);
				resolve("deny");
			}, timeoutMs);
			timer.unref?.();
			pending.set(request.id, { request, resolve, timer });
			return { status: "pending", request, decision };
		},
		pendingFor(sessionId: string): AgyPermissionRequest[] {
			return [...pending.values()]
				.map((entry) => entry.request)
				.filter((request) => request.sessionId === sessionId)
				.sort((a, b) => a.createdAt - b.createdAt);
		},
		get(id: string): AgyPermissionRequest | undefined {
			return pending.get(id)?.request;
		},
		decide(id: string, decision: AgyPermissionDecision): boolean {
			return settle(id, decision);
		},
		// Deny every outstanding request for a session (abort/finish).
		denySession(sessionId: string) {
			for (const [id, entry] of [...pending])
				if (entry.request.sessionId === sessionId) settle(id, "deny");
		},
	};
}

export type AgyPermissionStore = ReturnType<typeof createAgyPermissionStore>;
