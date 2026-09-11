import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type OutputLog = {
	write(taskId: string, runId: string, output: string): Promise<void>;
};

export type OutputLogOptions = {
	rootDir?: string;
	maxBytes?: number;
	maxEventBytes?: number;
};

const defaultMaxBytes = 5 * 1024 * 1024;
const defaultMaxEventBytes = 16 * 1024;

export function createOutputLogger(options: OutputLogOptions = {}): OutputLog {
	const rootDir =
		options.rootDir ?? join(process.env.HOME ?? ".", ".loom", "logs", "tasks");
	const maxBytes = options.maxBytes ?? defaultMaxBytes;
	const maxEventBytes = options.maxEventBytes ?? defaultMaxEventBytes;

	return {
		async write(taskId, runId, output) {
			const path = join(rootDir, taskId, `${runId}.log`);
			await mkdir(dirname(path), { recursive: true });
			const value =
				output.length > maxEventBytes
					? `${output.slice(0, maxEventBytes)}\n[truncated]`
					: output;
			try {
				const current = await stat(path);
				if (current.size + Buffer.byteLength(value) > maxBytes) {
					await rename(path, `${path}.1`);
				}
			} catch {}
			await appendFile(path, value, "utf8");
		},
	};
}

export function boundOutput(
	output: string,
	maxBytes = defaultMaxEventBytes,
): { output: string; truncated: boolean } {
	const bytes = Buffer.byteLength(output);
	if (bytes <= maxBytes) return { output, truncated: false };
	return {
		output: Buffer.from(output).subarray(0, maxBytes).toString("utf8"),
		truncated: true,
	};
}
