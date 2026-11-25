export type LineDiffSummary = {
	additions: number;
	deletions: number;
	patch?: string;
};

export type FileDiffMetadata = {
	file: string;
	additions: number;
	deletions: number;
	patch?: string;
};

/** Count added and removed lines in a unified diff or +/- patch string. */
export function diffCountsFromPatch(patch: string): {
	additions: number;
	deletions: number;
} {
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	let additions = 0;
	let deletions = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { additions, deletions };
}

/** Build the same file diff metadata consumed by CLI activities and chat previews. */
export function describeLineChanges(
	before: string,
	after: string,
): LineDiffSummary {
	const lines = (value: string) => {
		const result = value.replace(/\r\n/g, "\n").split("\n");
		if (result.at(-1) === "") result.pop();
		return result;
	};
	const oldLines = lines(before);
	const newLines = lines(after);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	)
		prefix += 1;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (
		oldEnd > prefix &&
		newEnd > prefix &&
		oldLines[oldEnd - 1] === newLines[newEnd - 1]
	) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	const oldMiddle = oldLines.slice(prefix, oldEnd);
	const newMiddle = newLines.slice(prefix, newEnd);
	// Keep memory bounded for very large rewrites; prefix/suffix trimming above
	// still gives an accurate count for the common single-region edit case.
	const maxCells = 1_000_000;
	let unchanged = 0;
	let operations: string[] = [];
	if (oldMiddle.length * newMiddle.length <= maxCells) {
		const table = Array.from(
			{ length: oldMiddle.length + 1 },
			() => new Uint32Array(newMiddle.length + 1),
		);
		for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
			const row = table[i]!;
			const nextRow = table[i + 1]!;
			for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
				row[j] =
					oldMiddle[i] === newMiddle[j]
						? nextRow[j + 1]! + 1
						: Math.max(nextRow[j]!, row[j + 1]!);
			}
		}
		unchanged = table[0]![0]!;
		let oldIndex = 0;
		let newIndex = 0;
		while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
			if (
				oldIndex < oldMiddle.length &&
				newIndex < newMiddle.length &&
				oldMiddle[oldIndex] === newMiddle[newIndex]
			) {
				operations.push(` ${oldMiddle[oldIndex]}`);
				oldIndex += 1;
				newIndex += 1;
			} else if (
				oldIndex < oldMiddle.length &&
				(newIndex >= newMiddle.length ||
					table[oldIndex + 1]![newIndex]! >= table[oldIndex]![newIndex + 1]!)
			) {
				operations.push(`-${oldMiddle[oldIndex]}`);
				oldIndex += 1;
			} else {
				operations.push(`+${newMiddle[newIndex]}`);
				newIndex += 1;
			}
		}
	} else {
		operations = [
			...oldMiddle.map((line) => `-${line}`),
			...newMiddle.map((line) => `+${line}`),
		];
	}
	const additions = newMiddle.length - unchanged;
	const deletions = oldMiddle.length - unchanged;
	const oldStart = oldMiddle.length ? prefix + 1 : prefix;
	const newStart = newMiddle.length ? prefix + 1 : prefix;
	const header = `@@ -${oldStart},${oldMiddle.length} +${newStart},${newMiddle.length} @@`;
	let patch =
		additions || deletions ? `${header}\n${operations.join("\n")}` : "";
	if (Buffer.byteLength(patch, "utf8") > 120_000) {
		patch = `${patch.slice(0, 120_000)}\n[Diff preview truncated]`;
	}
	return {
		additions,
		deletions,
		...(patch ? { patch } : {}),
	};
}

export function extractToolFilePath(
	input: Record<string, unknown> | undefined,
): string {
	if (!input) return "";
	for (const key of [
		"Path",
		"TargetFile",
		"targetFile",
		"target_file",
		"filePath",
		"file_path",
		"AbsolutePath",
		"absolute_path",
		"notebook_path",
		"path",
		"file",
		"filename",
	]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function combineDiffSummaries(summaries: LineDiffSummary[]): LineDiffSummary {
	let additions = 0;
	let deletions = 0;
	const patches: string[] = [];
	for (const summary of summaries) {
		additions += summary.additions;
		deletions += summary.deletions;
		if (summary.patch) patches.push(summary.patch);
	}
	let patch = patches.join("\n");
	if (Buffer.byteLength(patch, "utf8") > 120_000) {
		patch = `${patch.slice(0, 120_000)}\n[Diff preview truncated]`;
	}
	return {
		additions,
		deletions,
		...(patch ? { patch } : {}),
	};
}

const WRITE_LIKE_TOOL =
	/^(?:write|write_file|write_to_file|create_file|notebook_?edit)$/i;

/**
 * Derive filediff metadata (`file`, `additions`, `deletions`, `patch`) from
 * a CLI tool call's explicit patch or normalized edit/write parameters.
 */
export function buildToolFileDiff(
	toolName: string,
	input: Record<string, unknown> | undefined,
	rawPatch?: string,
	explicitFile?: string,
): FileDiffMetadata | undefined {
	const file = explicitFile || extractToolFilePath(input);
	if (typeof rawPatch === "string" && rawPatch.trim()) {
		const counts = diffCountsFromPatch(rawPatch);
		return {
			file: file || "Changes",
			patch: rawPatch,
			additions: counts.additions,
			deletions: counts.deletions,
		};
	}
	if (!input) return undefined;

	const chunkLists = [input.edits, input.ReplacementChunks].filter(
		Array.isArray,
	);
	for (const list of chunkLists) {
		const summaries: LineDiffSummary[] = [];
		for (const item of list) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const entry = item as Record<string, unknown>;
			const before = [
				entry.old_string,
				entry.oldString,
				entry.oldText,
				entry.TargetContent,
				entry.Target,
			].find((value): value is string => typeof value === "string");
			const after = [
				entry.new_string,
				entry.newString,
				entry.newText,
				entry.ReplacementContent,
				entry.Replacement,
			].find((value): value is string => typeof value === "string");
			if (before !== undefined || after !== undefined) {
				summaries.push(describeLineChanges(before ?? "", after ?? ""));
			}
		}
		if (summaries.length) {
			return {
				file: file || "Changes",
				...combineDiffSummaries(summaries),
			};
		}
	}

	const before = [
		input.old_string,
		input.oldString,
		input.oldText,
		input.TargetContent,
		input.Target,
	].find((value): value is string => typeof value === "string");
	const after = [
		input.new_string,
		input.newString,
		input.newText,
		input.ReplacementContent,
		input.Replacement,
	].find((value): value is string => typeof value === "string");
	if (before !== undefined || after !== undefined) {
		return {
			file: file || "Changes",
			...describeLineChanges(before ?? "", after ?? ""),
		};
	}

	const content = [
		input.content,
		input.Content,
		input.CodeContent,
		input.new_source,
	].find((value): value is string => typeof value === "string");
	if (
		content !== undefined &&
		(WRITE_LIKE_TOOL.test(toolName.trim()) ||
			typeof input.Content === "string" ||
			typeof input.CodeContent === "string" ||
			typeof input.new_source === "string")
	) {
		return {
			file: file || "Changes",
			...describeLineChanges("", content),
		};
	}

	return undefined;
}
