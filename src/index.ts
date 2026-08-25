import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	loadConfig,
	saveConfig,
	listTemplates,
	loadTemplate,
	deleteTemplate,
	saveTemplate,
	MAIN_TEMPLATE,
	mainTemplateReady,
	type PiShoraConfig,
} from "./config";
import { listTasks } from "./tasks";
import { getOpenRouterAuth } from "./resolve";
import { ensureDataDirs } from "./paths";
import { estimateCost as estCost, formatEstimate, getCredits, getPricing } from "./cost";

const HELP = `Pi-Shora — multi-model deliberation for pi

Usage:
  /pi-shora '<prompt>'                     launch a deliberation (default roles/template)
  /pi-shora run --template <name> '<prompt>'
  /pi-shora judge <model-ref>              set outer/final-answer model
  /pi-shora analyst <model-ref>            set analyst (comparer) model
  /pi-shora analyst-fallback <model-ref>  set fallback analyst (used if primary produces garbage)
  /pi-shora panel add <model-ref>[,<model-ref>...]   add one or more members
  /pi-shora panel set <model-ref>[,<model-ref>...]   replace the whole panel
  /pi-shora panel remove <index> | list | clear
  /pi-shora template save|use|delete|show|list [name]
  /pi-shora limit <usd>                    set hard credit-usage limit ("off" to disable)
  /pi-shora timeout <seconds>              per-model call timeout (default 300s)
  /pi-shora credits                        show OpenRouter balance/usage
  /pi-shora status                         running + recent tasks
  /pi-shora open <task-id>                 print path to a task directory

Model refs: "~vendor/model-slug" (OpenRouter). The leading ~ pins latest-resolution.`;

export default function piShora(pi: ExtensionAPI) {
	ensureDataDirs();

	/** In-memory registry of live deliberation runs (per session instance). */
	const running = new Map<string, { name: string; startedAt: number }>();

	pi.registerCommand("pi-shora", {
		description: "Multi-model deliberation (fusion): configure roles, templates, launch tasks",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (!input || input === "help") {
				ctx.ui.notify(HELP, "info");
				return;
			}
			await handleCommand(input, pi, ctx, running);
		},
	});

	// Agent-facing tool: lets the session model request deliberation when warranted.
	pi.registerTool({
		name: "pi_shora_deliberate",
		label: "Deliberate",
		description:
			"Launch a multi-model deliberation (panel of models answer independently, an analyst compares them, a judge synthesizes a verdict). " +
			"Use ONLY when the task genuinely benefits from multiple independent perspectives: complex implementation plans, architectural decisions, " +
			"research questions, high-stakes conclusions, or when the user asks for a second opinion. Do NOT use for simple tactical prompts. " +
			"Runs in the background (~1-5 min); you will receive a follow-up message pointing to the final verdict file. Cost is roughly 4-5x a single completion.",
		parameters: Type.Object({
			task: Type.String({ description: "Detailed description of what should be deliberated on. Be specific and self-contained — panel models see ONLY this plus optional context." }),
			task_name: Type.Optional(Type.String({ description: "Short name for output files (derived from task if omitted)" })),
			template: Type.Optional(Type.String({ description: "Saved role-configuration template name" })),
			context: Type.Optional(Type.String({ description: "Additional context (e.g. relevant code excerpts, constraints) passed to all roles" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return await launchCore(pi, ctx as any, running, {
					prompt: params.task,
					taskName: params.task_name,
					template: params.template ?? null,
					extraContext: params.context,
					fromAgent: true,
				});
			} catch (err: any) {
				return { content: [{ type: "text", text: `Pi-Shora launch failed: ${err.message}` }] } as any;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateWidget(ctx, running);
	});
}

// ---------------------------------------------------------------------------
// Main template — the default configuration the user defines on first use
// ---------------------------------------------------------------------------

/**
 * Ensure a usable 'main' template exists before launching a deliberation.
 * If it doesn't, interactively prompt the user to pick models for each role
 * and save the result as the 'main' template. This runs for BOTH user commands
 * and agent-initiated deliberations — the agent path is still interactive here
 * because this is a one-time setup, not a cost confirmation.
 */
async function ensureMainTemplate(ctx: any): Promise<PiShoraConfig> {
	const cfg = loadConfig();

	// Already configured via main template?
	if (mainTemplateReady()) return cfg;

	// Backwards-compat: migrate inline cfg.roles to a main template if present
	if (cfg.roles.judge.model && cfg.roles.analyst.model && cfg.roles.panel.length > 0) {
		saveTemplate(MAIN_TEMPLATE, cfg.roles, {});
		cfg.defaults.template = MAIN_TEMPLATE;
		saveConfig(cfg);
		return cfg;
	}

	// Need to prompt. If no UI (print mode, JSON mode), we can't.
	if (!ctx.hasUI) {
		throw new Error(
			"No 'main' template configured. Run /pi-shora and use the judge, analyst, and panel commands to set up your default models, " +
				"or save a template named 'main'."
		);
	}

	ctx.ui.notify(
		"Pi-Shora needs a default model configuration. Let's set up your 'main' template.\n" +
			"You can change these anytime with /pi-shora judge, /pi-shora analyst, /pi-shora panel commands.\n" +
			"Tip: browse models at https://openrouter.ai/models",
		"info"
	);

	const judge = await ctx.ui.input(
		"Pi-Shora setup — Judge model",
		"Enter the model slug for the judge (writes the final answer), e.g. anthropic/claude-opus-5"
	);
	if (!judge?.trim()) throw new Error("Setup cancelled — no judge model provided");

	const analyst = await ctx.ui.input(
		"Pi-Shora setup — Analyst model",
		"Enter the model slug for the analyst (compares panel responses), e.g. openai/gpt-5.6-luna"
	);
	if (!analyst?.trim()) throw new Error("Setup cancelled — no analyst model provided");

	const panelInput = await ctx.ui.input(
		"Pi-Shora setup — Panel models",
		"Enter 1–8 panel model slugs (comma-separated), e.g. google/gemini-3.7-flash, openai/gpt-5.6-luna, anthropic/claude-opus-5"
	);
	if (!panelInput?.trim()) throw new Error("Setup cancelled — no panel models provided");
	const panel = panelInput.split(",").map((s: string) => s.trim()).filter(Boolean);
	if (panel.length === 0 || panel.length > 8) throw new Error("Panel must have 1–8 models");

	const fallback = await ctx.ui.input(
		"Pi-Shora setup — Analyst fallback (optional)",
		"Enter a fallback analyst model (used if primary produces garbage), or press Enter to skip"
	);

	const roles: PiShoraConfig["roles"] = {
		judge: { model: judge.trim() },
		analyst: { model: analyst.trim() },
		analystFallback: fallback?.trim() || undefined,
		panel,
	};

	// Validate all at once
	await validateModelRefWarn(ctx, judge.trim(), analyst.trim(), ...panel);
	if (fallback?.trim()) await validateModelRefWarn(ctx, fallback.trim());

	// Save as the main template AND set as active config
	saveTemplate(MAIN_TEMPLATE, roles, {});
	cfg.roles = roles;
	cfg.defaults.template = MAIN_TEMPLATE;
	saveConfig(cfg);

	ctx.ui.notify("✓ 'main' template saved. Modify it anytime with /pi-shora judge, analyst, or panel commands.", "info");
	return cfg;
}

// ---------------------------------------------------------------------------
// Widget / status rendering
// ---------------------------------------------------------------------------

function updateWidget(ctx: any, running: Map<string, { name: string; startedAt: number }>): void {
	const cfg = loadConfig();
	const ready = mainTemplateReady();
	if (running.size === 0) {
		ctx.ui.setWidget?.("pi-shora", [
			ready
				? `pi-shora: idle (panel=${cfg.roles.panel.length}, judge=${cfg.roles.judge.model})`
				: `pi-shora: ⚠ no 'main' template — run /pi-shora to configure`,
		]);
	} else {
		const lines = [`pi-shora: ${running.size} deliberation(s) running`];
		for (const [, t] of running) {
			const mins = ((Date.now() - t.startedAt) / 60000).toFixed(1);
			lines.push(`  ⧗ ${t.name} (${mins}m)`);
		}
		ctx.ui.setWidget?.("pi-shora", lines);
	}
	ctx.ui.setStatus?.("pi-shora", running.size ? `⧗ ${running.size} deliberating` : "");
}

// ---------------------------------------------------------------------------
// Model-ref validation against the live OpenRouter catalog
// ---------------------------------------------------------------------------

/** Warn (don't block) if a model ref doesn't exist in the catalog; suggest close matches. */
async function validateModelRefWarn(ctx: any, ...refs: string[]): Promise<void> {
	try {
		const { apiKey, baseUrl } = await getOpenRouterAuth(ctx);
		const prices = await getPricing(apiKey, baseUrl);
		const ids = new Set(Object.keys(prices));
		const problems: string[] = [];
		for (const raw of refs) {
			const id = raw.trim().replace(/^~/, "");
			if (ids.has(id)) continue;
			// closest matches by edit distance on lowercase
			const lower = id.toLowerCase();
			const scored = [...ids]
				.map((c) => ({ c, d: editDistance(lower, c.toLowerCase()) }))
				.sort((a, b) => a.d - b.d)
				.slice(0, 3)
				.map((s) => s.c);
			problems.push(`"${raw}" not in catalog — did you mean: ${scored.join(", ")}?`);
		}
		if (problems.length) {
			ctx.ui.notify(`Model ref check:\n  ${problems.join("\n  ")}`, "warning");
		}
	} catch {
		// catalog unavailable — skip validation silently
	}
}

function editDistance(a: string, b: string): number {
	const m = a.length,
		n = b.length;
	const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++)
		for (let j = 1; j <= n; j++)
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
	return dp[m][n];
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function handleCommand(
	input: string,
	pi: ExtensionAPI,
	ctx: any,
	running: Map<string, { name: string; startedAt: number }>
): Promise<void> {
	const cfg = loadConfig();

	// Direct deliberation launch: /pi-shora 'some prompt' or run --template X '...'
	if (input.startsWith("'")) {
		await launchDeliberation(pi, ctx, input, running);
		return;
	}
	if (input.startsWith("run ")) {
		await launchDeliberation(pi, ctx, input.slice(4).trim(), running);
		return;
	}

	const [head, ...rest] = input.split(/\s+/);
	switch (head) {
		case "judge": {
			const ref = rest.join(" ");
			await validateModelRefWarn(ctx, ref);
			cfg.roles.judge = { model: ref };
			saveConfig(cfg);
			ctx.ui.notify(`Judge (outer/final-answer) model set: ${ref}`, "info");
			return;
		}
		case "analyst": {
			const ref = rest.join(" ");
			await validateModelRefWarn(ctx, ref);
			cfg.roles.analyst = { model: ref };
			saveConfig(cfg);
			ctx.ui.notify(`Analyst model set: ${ref}`, "info");
			return;
		}
		case "analyst-fallback": {
			const arg = rest.join(" ").trim();
			if (!arg || arg === "off") {
				cfg.roles.analystFallback = undefined;
				saveConfig(cfg);
				ctx.ui.notify("Analyst fallback disabled.", "info");
				return;
			}
			await validateModelRefWarn(ctx, arg);
			cfg.roles.analystFallback = arg;
			saveConfig(cfg);
			ctx.ui.notify(`Analyst fallback set: ${arg}`, "info");
			return;
		}
		case "panel":
			return handlePanel(rest, cfg, ctx);
		case "timeout": {
			const secs = Number(rest[0]);
			if (!Number.isFinite(secs) || secs < 10) {
				ctx.ui.notify(
					`Per-call timeout: ${cfg.limits.perCallTimeoutMs / 1000}s. Usage: /pi-shora timeout <seconds>`,
					"info"
				);
				return;
			}
			cfg.limits.perCallTimeoutMs = Math.round(secs * 1000);
			saveConfig(cfg);
			ctx.ui.notify(`Per-call timeout set to ${secs}s.`, "info");
			return;
		}
		case "template":
			return handleTemplate(rest, cfg, ctx);
		case "limit": {
			const arg = rest[0];
			if (!arg) {
				ctx.ui.notify(
					`Credit limit: ${cfg.limits.creditLimit === null ? "not set" : `$${cfg.limits.creditLimit}`}`,
					"info"
				);
				return;
			}
			if (arg === "off") {
				cfg.limits.creditLimit = null;
			} else {
				const v = Number(arg);
				if (!Number.isFinite(v) || v <= 0) {
					ctx.ui.notify("Usage: /pi-shora limit <usd> | off", "error");
					return;
				}
				cfg.limits.creditLimit = v;
			}
			saveConfig(cfg);
			ctx.ui.notify(
				`Credit limit ${cfg.limits.creditLimit === null ? "disabled" : `set to $${cfg.limits.creditLimit}`}`,
				"info"
			);
			return;
		}
		case "credits":
			return showCredits(ctx);
		case "status":
			return showStatus(ctx, running);
		case "open": {
			const id = rest[0];
			if (!id) {
				ctx.ui.notify("Usage: /pi-shora open <task-id>", "error");
				return;
			}
			const t = listTasks().find((task) => task.id === id || task.id.startsWith(id));
			ctx.ui.notify(t ? t.dir : `No task matching "${id}"`, t ? "info" : "error");
			return;
		}
		default:
			ctx.ui.notify(`Unknown subcommand "${head}".\n\n${HELP}`, "error");
	}
}

async function handlePanel(args: string[], cfg: any, ctx: any): Promise<void> {
	const [sub, ...rest] = args;
	switch (sub) {
		case "add": {
			// Accept one ref or a comma/space-separated list:
			//   /pi-shora panel add google/gemini-3.7-flash
			//   /pi-shora panel add google/gemini-3.7-flash, openai/gpt-5.6-luna, anthropic/claude-opus-5
			const refs = rest
				.join(" ")
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean);
			if (refs.length === 0) {
				ctx.ui.notify("Usage: /pi-shora panel add <model-ref> [,<model-ref>...]", "error");
				return;
			}
			const room = cfg.limits.maxPanelSize - cfg.roles.panel.length;
			if (room <= 0) {
				ctx.ui.notify(`Panel is full (max ${cfg.limits.maxPanelSize}). Remove one first or use /pi-shora panel set.`, "error");
				return;
			}
			const accepted = refs.slice(0, room);
			const rejected = refs.slice(room);
			cfg.roles.panel.push(...accepted);
			saveConfig(cfg);
			await validateModelRefWarn(ctx, ...accepted);
			let msg = `Added ${accepted.length} panel member(s) (${cfg.roles.panel.length}/${cfg.limits.maxPanelSize}):\n  ${accepted.join("\n  ")}`;
			if (rejected.length) {
				msg += `\nNOT added (panel full, max ${cfg.limits.maxPanelSize}):\n  ${rejected.join("\n  ")}`;
			}
			ctx.ui.notify(msg, rejected.length ? "warning" : "info");
			return;
		}
		case "set": {
			// Replace the entire panel in one shot:
			//   /pi-shora panel set modelA, modelB, modelC
			const refs = rest
				.join(" ")
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean);
			if (refs.length === 0) {
				ctx.ui.notify("Usage: /pi-shora panel set <model-ref>[,<model-ref>...]", "error");
				return;
			}
			if (refs.length > cfg.limits.maxPanelSize) {
				ctx.ui.notify(`Too many models: ${refs.length} given, max ${cfg.limits.maxPanelSize}.`, "error");
				return;
			}
			cfg.roles.panel = refs;
			saveConfig(cfg);
			await validateModelRefWarn(ctx, ...refs);
			ctx.ui.notify(`Panel replaced (${refs.length}/${cfg.limits.maxPanelSize}):\n  ${refs.join("\n  ")}`, "info");
			return;
		}
		case "remove": {
			const i = Number(rest[0]);
			if (!Number.isInteger(i) || i < 1 || i > cfg.roles.panel.length) {
				ctx.ui.notify(`Usage: /pi-shora panel remove <1-${cfg.roles.panel.length}>`, "error");
				return;
			}
			const [removed] = cfg.roles.panel.splice(i - 1, 1);
			saveConfig(cfg);
			ctx.ui.notify(`Panel member removed: ${removed}`, "info");
			return;
		}
		case "clear":
			cfg.roles.panel = [];
			saveConfig(cfg);
			ctx.ui.notify("Panel cleared.", "info");
			return;
		default:
			ctx.ui.notify(panelSummary(cfg), "info");
	}
}

function panelSummary(cfg: any): string {
	if (cfg.roles.panel.length === 0) return "Panel is empty.";
	return (
		`Panel (${cfg.roles.panel.length}/${cfg.limits.maxPanelSize}):\n` +
		cfg.roles.panel.map((m: string, i: number) => `  ${i + 1}. ${m}`).join("\n")
	);
}

async function handleTemplate(args: string[], cfg: any, ctx: any): Promise<void> {
	const [sub, name] = args;
	switch (sub) {
		case "save": {
			if (!name) {
				ctx.ui.notify("Usage: /pi-shora template save <name>", "error");
				return;
			}
			const { saveTemplate } = await import("./config");
			saveTemplate(name, cfg.roles, {});
			ctx.ui.notify(`Template saved: ${name}`, "info");
			return;
		}
		case "use": {
			const tpl = name ? await import("./config").then((m) => m.loadTemplate(name)) : null;
			if (!tpl) {
				ctx.ui.notify(name ? `Template not found: ${name}` : "Usage: /pi-shora template use <name>", "error");
				return;
			}
			cfg.roles = tpl.roles;
			if (tpl.limits) Object.assign(cfg.limits, tpl.limits);
			cfg.defaults.template = tpl.name;
			saveConfig(cfg);
			ctx.ui.notify(`Template applied and set as default: ${tpl.name}`, "info");
			return;
		}
		case "delete": {
			const { deleteTemplate } = await import("./config");
			ctx.ui.notify(
				name && deleteTemplate(name) ? `Template deleted: ${name}` : `Template not found: ${name}`,
				name && deleteTemplate(name) ? "info" : "error"
			);
			return;
		}
		case "show": {
			const tpl = name ? await import("./config").then((m) => m.loadTemplate(name)) : null;
			if (!tpl) {
				ctx.ui.notify(`Template not found: ${name}`, "error");
				return;
			}
			ctx.ui.notify(JSON.stringify(tpl, null, 2), "info");
			return;
		}
		default: {
			const names = listTemplates();
			ctx.ui.notify(names.length ? `Templates:\n  ${names.join("\n  ")}` : "No templates saved.", "info");
		}
	}
}

async function showCredits(ctx: any): Promise<void> {
	try {
		const { apiKey, baseUrl } = await getOpenRouterAuth(ctx);
		const res = await fetch(`${baseUrl}/key`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body: any = await res.json();
		const d = body?.data ?? {};
		const usage = typeof d.usage === "number" ? d.usage : undefined;
		const limit = typeof d.limit === "number" ? d.limit : null;
		ctx.ui.notify(
			limit !== null
				? `Key spend: $${usage?.toFixed?.(4) ?? usage} / $${limit} (remaining $${(limit - usage).toFixed(2)})`
				: `Key spend: $${usage ?? "unknown"} (no hard limit on key)`,
			"info"
		);
	} catch (err: any) {
		ctx.ui.notify(`Could not fetch credits: ${err.message}`, "error");
	}
}

function renderRunning(running: Map<string, { name: string; startedAt: number }>): string {
	const lines = [`Running (${running.size}):`];
	for (const [id, t] of running) {
		const mins = ((Date.now() - t.startedAt) / 60000).toFixed(1);
		lines.push(`  ${id.slice(0, 40)}… — ${t.name} (${mins}m)`);
	}
	return lines.join("\n");
}

function showStatus(ctx: any, running: Map<string, { name: string; startedAt: number }>): void {
	const cfg = loadConfig();
	const ready = mainTemplateReady();
	const tasks = listTasks();
	const lines = [
		"Pi-Shora status",
		`  main template: ${ready ? "✓ configured" : "⚠ not configured — run /pi-shora to set up"}`,
		`  judge:   ${cfg.roles.judge.model || "(not set)"}`,
		`  analyst: ${cfg.roles.analyst.model || "(not set)"}`,
		panelSummary(cfg),
		`  default template: ${cfg.defaults.template ?? "(none)"}`,
		`  credit limit: ${cfg.limits.creditLimit === null ? "not set" : `$${cfg.limits.creditLimit}`}`,
	];
	if (running.size) {
		lines.push(renderRunning(running));
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Launching — fire-and-forget, shared by command & agent tool
// ---------------------------------------------------------------------------

interface LaunchRequest {
	prompt: string;
	taskName?: string;
	template?: string | null;
	extraContext?: string;
	/** true when called from the agent tool (no interactive confirm dialogs) */
	fromAgent?: boolean;
}

async function launchCore(
	pi: ExtensionAPI,
	ctx: any,
	running: Map<string, { name: string; startedAt: number }>,
	req: LaunchRequest
): Promise<any> {
	const prompt = req.prompt.trim();
	const template = req.template ?? null;
	if (!prompt) throw new Error("Empty prompt");

	await getOpenRouterAuth(ctx); // throws with a helpful message if unconfigured

	// ---- Ensure a 'main' template exists before anything else ------------
	// This is interactive even for agent-initiated runs because it's a one-time
	// setup, not a cost confirmation. If the user has no UI (print/JSON mode)
	// and no template is configured, this throws with guidance.
	await ensureMainTemplate(ctx);

	// ---- Cost guardrails (hybrid: always show estimate; ask/block at limits) ----
	const cfg = loadConfig();
	let estText = "(estimate unavailable — pricing catalog not fetched)";
	let blockedMsg: string | null = null;
	let warnOverLimit = false;
	try {
		const { apiKey, baseUrl } = await getOpenRouterAuth(ctx);
		const prices = await getPricing(apiKey, baseUrl);
		// Resolve roles: explicit template wins; otherwise use the default (main) template
		const tplName = template ?? cfg.defaults.template ?? MAIN_TEMPLATE;
		const roles = loadTemplate(tplName)?.roles ?? cfg.roles;
		const fullPrompt = req.extraContext ? `${prompt}\n\nADDITIONAL CONTEXT:\n${req.extraContext}` : prompt;
		const estimate = estCost({
			panel: roles.panel,
			analystModel: roles.analyst.model,
			judgeModel: roles.judge.model,
			promptChars: fullPrompt.length,
		}, prices);
		estText = formatEstimate(estimate);

		const credits = await getCredits(apiKey, baseUrl);
		const spentRecently = cfg.usage.reduce((s, u) => s + u.costUsd, 0);

		if (credits.remainingUsd !== null && estimate.totalUsd > credits.remainingUsd) {
			blockedMsg = `Blocked: estimated cost $${estimate.totalUsd.toFixed(4)} exceeds remaining OpenRouter credits ($${credits.remainingUsd.toFixed(2)}).`;
		} else if (
			cfg.limits.creditLimit !== null &&
			spentRecently + estimate.totalUsd > cfg.limits.creditLimit
		) {
			if (!req.fromAgent && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Pi-Shora — credit limit",
					`Estimated cost $${estimate.totalUsd.toFixed(4)} would exceed your $${cfg.limits.creditLimit.toFixed(2)} usage limit ($${spentRecently.toFixed(4)} spent so far). Proceed anyway?\n\n${formatEstimate(estimate)}`
				);
				if (!ok) return { content: [{ type: "text", text: "Launch cancelled by user (credit limit)." }] } as any;
			} else {
				warnOverLimit = true;
			}
		}
	} catch {
		// estimation failures must never block a launch
	}
	if (blockedMsg) throw new Error(blockedMsg);

	if (running.size >= cfg.limits.maxConcurrentTasks) {
		throw new Error(
			`Concurrency cap reached (${cfg.limits.maxConcurrentTasks}). Wait for a run to finish or check /pi-shora status.`
		);
	}

	ctx.ui.notify(estText, "info");
	if (warnOverLimit) {
		ctx.ui.notify("Warning: this run will cross your configured credit usage limit.", "warning");
	}

	const key = `${Date.now()}-${prompt.slice(0, 40)}`;
	running.set(key, { name: (req.taskName ?? prompt).slice(0, 50), startedAt: Date.now() });
	updateWidget(ctx, running);
	const queuedMsg = `Deliberation launched in background (${running.size}/${cfg.limits.maxConcurrentTasks}). The verdict will land in ~/.pi/agent/pi-shora/tasks/ and be pointed out here when done.`;
	ctx.ui.notify(queuedMsg, "info");

	void (async () => {
		try {
			const { runDeliberation } = await import("./pipeline");
			const result = await runDeliberation(ctx, {
				prompt: req.extraContext ? `${req.prompt}\n\nADDITIONAL CONTEXT:\n${req.extraContext}` : req.prompt,
				taskName: req.taskName,
				template,
			});
			running.delete(key);
			updateWidget(ctx, running);
			// Inject the verdict pointer into the session as a follow-up so the
			// agent sees it and can act on it. Only the pointer enters chat.
			pi.sendUserMessage?.(
				`[Pi-Shora] Deliberation complete: "${req.prompt.slice(0, 120)}"\n` +
					`Final verdict file: ${result.finalFile}\n` +
					`Task dir: ${result.dir}\n` +
					`Read the Final file if relevant to current work and incorporate its conclusions. Do NOT re-run deliberation on this output.`,
				{ deliverAs: "followUp" }
			);
		} catch {
			running.delete(key);
			updateWidget(ctx, running);
			// failure already notified + persisted by the pipeline
		}
	})();

	return {
		content: [
			{
				type: "text",
				text: `Deliberation launched in background. ${queuedMsg}\nCost estimate:\n${estText}${warnOverLimit ? "\nWARNING: this run crosses your configured credit usage limit." : ""}`,
			},
		],
	} as any;
}

async function launchDeliberation(
	pi: ExtensionAPI,
	ctx: any,
	raw: string,
	running: Map<string, { name: string; startedAt: number }>
): Promise<void> {
	let prompt = raw;
	let template: string | null = null;
	const tmatch = raw.match(/^--template\s+(\S+)\s+/);
	if (tmatch) {
		template = tmatch[1];
		prompt = raw.slice(tmatch[0].length);
	}
	prompt = prompt.replace(/^'+|'+$/g, "").trim();
	if (!prompt) {
		ctx.ui.notify("Provide a prompt: /pi-shora '<prompt>'", "error");
		return;
	}
	try {
		await launchCore(pi, ctx, running, { prompt, template });
	} catch (err: any) {
		ctx.ui.notify(err.message, "error");
	}
}

