import type { ConvertedPlanTask } from "@loom/db";
import type { AutomationPlanTask } from "@loom/protocol";

/** Pure mapping from validated plan tasks to persistable Kanban task inputs. */
export function convertPlanTask(task: AutomationPlanTask): ConvertedPlanTask {
	return {
		key: task.key,
		title: task.title,
		description: task.description,
		prompt: task.description,
		priority: task.priority,
		acceptanceCriteria: [...task.acceptanceCriteria],
		suggestedFiles: [...task.suggestedFiles],
		dependsOn: [...task.dependencies],
		parallelGroup: task.parallelGroup ?? null,
	};
}

export function convertPlanTasks(
	tasks: AutomationPlanTask[],
): ConvertedPlanTask[] {
	return tasks.map(convertPlanTask);
}
