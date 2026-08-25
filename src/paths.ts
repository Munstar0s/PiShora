import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Filesystem layout for Pi-Shora.
 *
 * Code lives in ~/.pi/agent/extensions/pi-shora/ (or wherever the package is installed).
 * Data lives in ~/.pi/agent/pi-shora/ so sessions/templates survive /reload and
 * are never swept up with extension code.
 */
export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
export const DATA_DIR = join(PI_AGENT_DIR, "pi-shora");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const TEMPLATES_DIR = join(DATA_DIR, "templates");
export const TASKS_DIR = join(DATA_DIR, "tasks");
export const CREDITS_FILE = join(DATA_DIR, "credits.json");

export function taskDir(taskId: string): string {
	return join(TASKS_DIR, taskId);
}

export function ensureDataDirs(): void {
	for (const dir of [DATA_DIR, TEMPLATES_DIR, TASKS_DIR]) {
		mkdirSync(dir, { recursive: true });
	}
}
