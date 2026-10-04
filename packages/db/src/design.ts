import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "./index";
import { designMessages, designNodes } from "./schema";

export type DesignNodeRecord = {
	id: string;
	projectId: string;
	sessionId: string | null;
	parentId: string | null;
	title: string;
	brief: string;
	status: string;
	viewport: string;
	html: string;
	errorMessage: string | null;
	durationMs: number | null;
	x: number;
	y: number;
	width: number;
	height: number;
	createdAt: Date;
	updatedAt: Date;
};

export type DesignMessageRecord = {
	id: string;
	projectId: string;
	nodeId: string | null;
	role: string;
	text: string;
	model: string | null;
	errorMessage: string | null;
	durationMs: number | null;
	createdAt: Date;
};

export type CreateDesignNode = {
	id?: string;
	projectId: string;
	title: string;
	brief: string;
	viewport?: string;
	parentId?: string | null;
	sessionId?: string | null;
	status?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
};

const PENDING_DESIGN_STATUSES = ["queued", "generating"];

export function designRepository(db: Database) {
	return {
		async createNode(input: CreateDesignNode): Promise<DesignNodeRecord> {
			const now = new Date();
			const [node] = await db
				.insert(designNodes)
				.values({
					id: input.id ?? randomUUID(),
					projectId: input.projectId,
					title: input.title,
					brief: input.brief,
					viewport: input.viewport ?? "desktop",
					parentId: input.parentId ?? null,
					sessionId: input.sessionId ?? null,
					status: input.status ?? "queued",
					x: input.x ?? 0,
					y: input.y ?? 0,
					width: input.width ?? 420,
					height: input.height ?? 280,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			if (!node) throw new Error("Design node insert returned no row");
			return node;
		},
		getNode(id: string) {
			return db.query.designNodes.findFirst({
				where: eq(designNodes.id, id),
			});
		},
		listNodes(projectId: string) {
			return db
				.select()
				.from(designNodes)
				.where(eq(designNodes.projectId, projectId))
				.orderBy(asc(designNodes.createdAt));
		},
		listPendingNodes() {
			return db
				.select()
				.from(designNodes)
				.where(inArray(designNodes.status, PENDING_DESIGN_STATUSES))
				.orderBy(desc(designNodes.createdAt));
		},
		updateNode(id: string, input: Partial<DesignNodeRecord>) {
			return db
				.update(designNodes)
				.set({ ...input, updatedAt: new Date() })
				.where(eq(designNodes.id, id))
				.returning();
		},
		deleteNode(id: string) {
			return db.delete(designNodes).where(eq(designNodes.id, id));
		},
		async addMessage(input: {
			id?: string;
			projectId: string;
			nodeId?: string | null;
			role: string;
			text: string;
			model?: string | null;
			errorMessage?: string | null;
			durationMs?: number | null;
		}): Promise<DesignMessageRecord> {
			const [message] = await db
				.insert(designMessages)
				.values({
					id: input.id ?? randomUUID(),
					projectId: input.projectId,
					nodeId: input.nodeId ?? null,
					role: input.role,
					text: input.text,
					model: input.model ?? null,
					errorMessage: input.errorMessage ?? null,
					durationMs: input.durationMs ?? null,
				})
				.returning();
			if (!message) throw new Error("Design message insert returned no row");
			return message;
		},
		listMessages(projectId: string) {
			return db
				.select()
				.from(designMessages)
				.where(eq(designMessages.projectId, projectId))
				.orderBy(asc(designMessages.createdAt));
		},
		deleteMessages(projectId: string) {
			return db
				.delete(designMessages)
				.where(eq(designMessages.projectId, projectId));
		},
		async clearProject(projectId: string): Promise<void> {
			await db
				.delete(designMessages)
				.where(eq(designMessages.projectId, projectId))
				.run();
			await db
				.delete(designNodes)
				.where(eq(designNodes.projectId, projectId))
				.run();
		},
		async markInterrupted(ids: string[]): Promise<void> {
			if (!ids.length) return;
			await db
				.update(designNodes)
				.set({
					status: "failed",
					errorMessage: "Design generation was interrupted. Retry it.",
					updatedAt: new Date(),
				})
				.where(
					and(
						inArray(designNodes.id, ids),
						inArray(designNodes.status, PENDING_DESIGN_STATUSES),
					),
				)
				.run();
		},
	};
}

export type DesignRepository = ReturnType<typeof designRepository>;
