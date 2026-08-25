import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, TEMPLATES_DIR } from "./paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleConfig {
	/** OpenRouter model ref, e.g. "~anthropic/claude-opus-latest" */
	model: string;
}

export interface Limits {
	/** Hard credit cap in USD; null = ask on first big spend */
	creditLimit: number | null;
	maxConcurrentTasks: number;
	maxPanelSize: number;
	perCallTimeoutMs: number;
}

export interface Defaults {
	template: string | null;
	webSearchOnPanel: boolean;
}

export interface UsageEntry {
	taskId: string;
	taskName: string;
	costUsd: number;
	finishedAt: number;
}

export interface PiShoraConfig {
	roles: {
		judge: RoleConfig;
		analyst: RoleConfig;
		analystFallback?: string;
		panel: string[];
	};
	limits: Limits;
	defaults: Defaults;
	usage: UsageEntry[];
}

export const DEFAULT_CONFIG: PiShoraConfig = {
	roles: {
		judge: { model: "" },
		analyst: { model: "" },
		analystFallback: undefined,
		panel: [],
	},
	limits: {
		creditLimit: null,
		maxConcurrentTasks: 3,
		maxPanelSize: 8,
		perCallTimeoutMs: 300_000,
	},
	defaults: { template: "main", webSearchOnPanel: true },
	usage: [],
};

/** Name of the default template that serves as the user's baseline configuration. */
export const MAIN_TEMPLATE = "main";

/** Check whether a usable main template exists (has models for all roles). */
export function mainTemplateReady(): boolean {
	const tpl = loadTemplate(MAIN_TEMPLATE);
	return !!(
		tpl?.roles?.judge?.model &&
		tpl?.roles?.analyst?.model &&
		tpl?.roles?.panel?.length > 0
	);
}

// ---------------------------------------------------------------------------
// Config load / save
// ---------------------------------------------------------------------------

export function loadConfig(): PiShoraConfig {
	if (!existsSync(CONFIG_FILE)) return structuredClone(DEFAULT_CONFIG);
	try {
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<PiShoraConfig>;
		return mergeConfig(DEFAULT_CONFIG, raw);
	} catch {
		// Corrupt config: keep defaults but don't silently overwrite the file.
		return structuredClone(DEFAULT_CONFIG);
	}
}

function mergeConfig(base: PiShoraConfig, override: Partial<PiShoraConfig>): PiShoraConfig {
	return {
		roles: {
			judge: override.roles?.judge ?? base.roles.judge,
			analyst: override.roles?.analyst ?? base.roles.analyst,
			analystFallback: override.roles?.analystFallback ?? base.roles.analystFallback,
			panel: override.roles?.panel ?? base.roles.panel,
		},
		limits: { ...base.limits, ...override.limits },
		defaults: { ...base.defaults, ...override.defaults },
		usage: override.usage ?? [],
	};
}

export function saveConfig(config: PiShoraConfig): void {
	mkdirSync(join(CONFIG_FILE, ".."), { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Templates — named snapshots of the roles block (+ optional limit overrides)
// ---------------------------------------------------------------------------

export interface Template {
	name: string;
	savedAt: number;
	roles: PiShoraConfig["roles"];
	limits?: Partial<Limits>;
}

export function listTemplates(): string[] {
	if (!existsSync(TEMPLATES_DIR)) return [];
	return readdirSync(TEMPLATES_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.sort();
}

export function templatePath(name: string): string {
	return join(TEMPLATES_DIR, `${name}.json`);
}

export function loadTemplate(name: string): Template | null {
	const p = templatePath(name);
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf8")) as Template;
}

export function saveTemplate(name: string, roles: PiShoraConfig["roles"], limits?: Partial<Limits>): void {
	mkdirSync(TEMPLATES_DIR, { recursive: true });
	const tpl: Template = { name, savedAt: Date.now(), roles, limits };
	writeFileSync(templatePath(name), JSON.stringify(tpl, null, 2) + "\n", "utf8");
}

export function deleteTemplate(name: string): boolean {
	const p = templatePath(name);
	if (!existsSync(p)) return false;
	unlinkSync(p);
	return true;
}
