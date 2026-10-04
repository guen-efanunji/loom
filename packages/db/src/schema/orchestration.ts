import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tasks } from "./workflow";

export const taskDependencies = sqliteTable(
	"task_dependencies",
	{
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		dependsOnTaskId: text("depends_on_task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
	},
	(t) => [
		uniqueIndex("task_dependencies_uidx").on(t.taskId, t.dependsOnTaskId),
	],
);
