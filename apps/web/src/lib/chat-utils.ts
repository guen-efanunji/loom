import type { ChatMessage } from "./chat";

/** Group a flat message list into chat turns (assistant runs merge together). */
export function groupTurns(messages: ChatMessage[]) {
	const groups: Array<{ key: string; role: string; messages: ChatMessage[] }> =
		[];
	for (const message of messages) {
		const last = groups[groups.length - 1];
		if (message.info.role === "assistant" && last?.role === "assistant")
			last.messages.push(message);
		else
			groups.push({
				key: message.info.id,
				role: message.info.role,
				messages: [message],
			});
	}
	return groups;
}

/** Extract the visible text of a user message (ignores hidden design/meta parts). */
export function userMessageText(message: ChatMessage): string {
	return message.parts
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text as string)
		.join("\n\n")
		.trim();
}

/**
 * Turn ids that a regenerate/edit supersedes: the target user message plus the
 * assistant answers that follow it up to (but not including) the next user turn.
 */
export function supersededIds(
	messages: ChatMessage[],
	userMessageId: string,
): string[] {
	const index = messages.findIndex(
		(message) => message.info.id === userMessageId,
	);
	if (index < 0) return [];
	const hidden: string[] = [messages[index]!.info.id];
	for (let i = index + 1; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.info.role === "user") break;
		hidden.push(message.info.id);
	}
	return hidden;
}

/** A short, human label for what a permission request is about to do. */
export function permissionActionLabel(permission: string, patterns: string[]) {
	const tool = permission.toLowerCase().replace(/[^a-z]/g, "");
	const target = patterns.find(
		(pattern) => pattern && !pattern.startsWith("-"),
	);
	const action = /read|view|open|grep|glob|search|list/.test(tool)
		? "Read"
		: /edit|write|patch|apply|create|delete|replace|multiedit/.test(tool)
			? "Edit"
			: /bash|shell|exec|command|terminal/.test(tool)
				? "Run"
				: permission.replace(/[_-]+/g, " ");
	return target ? `${action} \u00b7 ${target}` : action;
}

/** Encode a chat sub-path so provider ids never break the request route. */
export function chatReplyPath(
	kind: "permission" | "question",
	sessionId: string,
	requestId: string,
) {
	return `/api/chat/sessions/${encodeURIComponent(sessionId)}/${kind}/${encodeURIComponent(requestId)}`;
}
