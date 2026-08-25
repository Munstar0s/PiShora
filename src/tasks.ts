import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_DIR } from "./paths";

export type TaskStatus =
	| "queued"
	| "estimating"
	| "running"
	| "analyzing"
	| "judging"
	| "complete"
	| "degraded"
	| "failed";

export interface TaskRecord {
	id: string;
	name: string;
	status: TaskStatus;
	prompt: string;
	template: string | null;
	roles: {
		judge: string;
		analyst: string;
		analystFallback?: string;
		panel: string[];
	};
	createdAt: number;
	finishedAt?: number;
	failedModels?: { model: string; reason: string }[];
	costUsd?: number;
	degradedNote?: string;
	error?: string;
}

export function taskIdFor(nameSlug: string): string {
	const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `${ts}-${nameSlug}`;
}

export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

export interface TaskSummary {
	id: string;
	dir: string;
	status: TaskStatus;
}

export function listTasks(): TaskSummary[] {
	if (!existsSync(TASKS_DIR)) return [];
	return readdirSync(TASKS_DIR)
		.sort()
		.reverse()
		.map((id) => {
			const dir = join(TASKS_DIR, id);
			let status: TaskStatus = "queued";
			try {
				const rec = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as TaskRecord;
				status = rec.status ?? status;
			} catch {
				// unreadable task dir — report as queued
			}
			return { id, dir, status };
		});
}
