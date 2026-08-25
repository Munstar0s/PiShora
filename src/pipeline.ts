import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadTemplate, saveConfig, type PiShoraConfig } from "./config";
import { resolveModelRef, getOpenRouterAuth } from "./resolve";
import { ensureDataDirs, taskDir } from "./paths";
import { taskIdFor, slugify, type TaskRecord, type TaskStatus } from "./tasks";

// ---------------------------------------------------------------------------
// Low-level OpenRouter chat completions
// ---------------------------------------------------------------------------

interface ChatOptions {
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	retries?: number;
	externalSignal?: AbortSignal;
	/** Request JSON-mode from the provider (response_format: json_object) */
	jsonMode?: boolean;
}

function isTransient(err: any): boolean {
	if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return false;
	if (typeof err?.status === "number") return err.status === 429 || err.status >= 500;
	return /timeout|fetch failed|network|econn/i.test(String(err?.message ?? ""));
}

interface ChatResult {
	content: string;
	/** Actual cost in USD from the response's usage data, when reported */
	costUsd: number | null;
}

async function chat(
	apiKey: string,
	baseUrl: string,
	model: string,
	messages: { role: string; content: string }[],
	opts: ChatOptions = {}
): Promise<ChatResult> {
	const maxAttempts = (opts.retries ?? 1) + 1;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await chatOnce(apiKey, baseUrl, model, messages, opts);
		} catch (err: any) {
			lastErr = err;
			if (!isTransient(err) || attempt === maxAttempts) throw err;
			await new Promise((r) => setTimeout(r, 1500 * attempt));
		}
	}
	throw lastErr;
}

async function chatOnce(
	apiKey: string,
	baseUrl: string,
	model: string,
	messages: { role: string; content: string }[],
	opts: ChatOptions = {}
): Promise<ChatResult> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 300_000);
	const onExternalAbort = () => ctrl.abort();
	opts.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	try {
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				messages,
				...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
				...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
				...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
			}),
			signal: ctrl.signal,
		});
		if (!res.ok) {
			const body = await res.text();
			const err = new Error(`HTTP ${res.status} from ${model}: ${body.slice(0, 300)}`) as any;
			err.status = res.status;
			throw err;
		}
		const data: any = await res.json();
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) {
			throw new Error(`Empty completion from ${model}`);
		}
		const costUsd = Number(data?.usage?.cost) || null;
		return { content, costUsd };
	} finally {
		clearTimeout(timer);
		opts.externalSignal?.removeEventListener("abort", onExternalAbort);
	}
}

// ---------------------------------------------------------------------------
// Analyst prompt / schema
// ---------------------------------------------------------------------------

const ANALYST_SYSTEM = `You are a rigorous analyst comparing multiple independent AI model responses to the same prompt.
Do NOT merge the responses. COMPARE them and return ONLY a JSON object (no prose, no markdown fences) with exactly this shape:

{
  "consensus": ["points that all or most models agreed on"],
  "contradictions": [{ "topic": "...", "stances": [{ "model": "...", "stance": "..." }] }],
  "partial_coverage": [{ "models": ["..."], "point": "only some models covered this" }],
  "unique_insights": [{ "model": "...", "insight": "raised by only one model" }],
  "blind_spots": ["important aspects no model addressed"]
}`;

const PANEL_SYSTEM =
	"You are one of several independent expert models asked the same question. " +
	"Answer thoroughly, rigorously, and in good faith from your own perspective.";

const JUDGE_SYSTEM =
	"You are the lead expert answering a user's question. Several independent models answered the same prompt, and an analyst compared their responses. " +
	"Use that comparison to write the best possible final answer. Treat consensus as higher-confidence, weigh contradictions explicitly, preserve unique valid insights, and address blind spots. " +
	"Do not produce a mere average or majority vote — synthesize.";

/**
 * Heuristic detector for degenerate "token soup" output: multi-language gibberish,
 * broken JSON fragments, repeated tokens. Catches what JSON parsing alone would miss
 * (and avoids feeding garbage to the judge or treating it as a valid analysis).
 */
function isDegenerate(text: string): boolean {
	const t = text.trim();
	if (t.length < 20) return true;
	// Non-ASCII ratio: mixing many scripts (CJK/Cyrillic/Arabic) in a JSON analysis is a red flag.
	const nonAscii = (t.match(/[^\x00-\x7f]/g) ?? []).length;
	if (nonAscii / t.length > 0.15) return true;
	// Repeated n-grams indicate a stuck decoding loop.
	const sample = t.slice(0, 200);
	if (/(.{1,8})\1{4,}/.test(sample)) return true;
	// Very low average "word" length (lots of fragments/punctuation soup).
	const words = t.split(/\s+/).filter(Boolean);
	if (words.length > 20) {
		const avgLen = words.reduce((s, w) => s + w.length, 0) / words.length;
		if (avgLen < 2.5) return true;
	}
	return false;
}

function extractJson(text: string): any | null {
	const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(trimmed.slice(start, end + 1));
			} catch {
				return null;
			}
		}
		return null;
	}
}

// ---------------------------------------------------------------------------
// Launch / orchestration
// ---------------------------------------------------------------------------

export interface LaunchOptions {
	prompt: string;
	taskName?: string;
	template?: string | null;
	panelOverride?: string[];
}

export interface LaunchResult {
	taskId: string;
	dir: string;
	finalFile: string;
}

type UiStatus = (text: string) => void;

export async function runDeliberation(
	ctx: ExtensionContext,
	opts: LaunchOptions
): Promise<LaunchResult> {
	ensureDataDirs();

	// ---- Resolve configuration -------------------------------------------
	const cfg = loadConfig();
	let roles = cfg.roles;
	if (opts.template) {
		const tpl = loadTemplate(opts.template);
		if (!tpl) throw new Error(`Template not found: ${opts.template}`);
		roles = tpl.roles;
	}
	const panelModels = opts.panelOverride ?? roles.panel;
	if (panelModels.length === 0) throw new Error("Panel is empty — add models via /pi-shora panel add");

	const taskName = opts.taskName ?? deriveTaskName(opts.prompt);
	const taskId = taskIdFor(slugify(taskName));
	const dir = taskDir(taskId);
	mkdirSync(join(dir, "panel"), { recursive: true });

	let status: TaskStatus = "running";
	const record: TaskRecord = {
		id: taskId,
		name: taskName,
		status,
		prompt: opts.prompt,
		template: opts.template ?? null,
		roles: { judge: roles.judge.model, analyst: roles.analyst.model, analystFallback: cfg.roles.analystFallback, panel: [...panelModels] },
		createdAt: Date.now(),
		costUsd: 0,
	};
	const saveTask = () => {
		record.status = status;
		writeFileSync(join(dir, "task.json"), JSON.stringify(record, null, 2) + "\n");
	};
	saveTask();

	const setUiStatus: UiStatus = (text) => ctx.ui.setStatus?.("pi-shora", text);

	// Abort support: Esc / session shutdown cancels all in-flight calls.
	const runCtrl = new AbortController();
	const onCtxAbort = () => runCtrl.abort();
	ctx.signal?.addEventListener("abort", onCtxAbort, { once: true });
	try {
		const { apiKey, baseUrl } = await getOpenRouterAuth(ctx);
		const timeoutMs = cfg.limits.perCallTimeoutMs;

		// ---- Stage 1: PANEL (parallel fan-out) -----------------------------
		setUiStatus(`⧗ ${taskName} — panel 0/${panelModels.length}`);
		let done = 0;
		const panelResults = await Promise.allSettled(
			panelModels.map(async (ref) => {
				const apiId = resolveModelRef(ref).apiId;
				try {
					const panelRes = await chat(
						apiKey,
						baseUrl,
						apiId,
						[
							{ role: "system", content: PANEL_SYSTEM },
							{ role: "user", content: opts.prompt },
						],
						{ timeoutMs, retries: 1, externalSignal: runCtrl.signal }
					);
					record.costUsd = (record.costUsd ?? 0) + (panelRes.costUsd ?? 0);
					writeFileSync(join(dir, "panel", `${sanitizeFile(apiId)}.md`), panelRes.content + "\n");
					return { model: ref, content: panelRes.content };
				} catch (err: any) {
					record.failedModels = [
						...(record.failedModels ?? []),
						{ model: ref, reason: explainFailure(err) },
					];
					saveTask();
					throw err;
				} finally {
					done++;
					setUiStatus(`⧗ ${taskName} — panel ${done}/${panelModels.length}`);
				}
			})
		);
		const panelOutputs = panelResults
			.filter((r): r is PromiseFulfilledResult<{ model: string; content: string }> => r.status === "fulfilled")
			.map((r) => r.value);

		if (panelOutputs.length === 0) {
			throw new Error(
				"all panel models failed (" +
					(record.failedModels ?? []).map((f) => `${f.model}: ${f.reason}`).join("; ") +
					")"
			);
		}
		if (panelOutputs.length === 1 && !record.degradedNote) {
			record.degradedNote =
				"Only 1 of " + panelModels.length + " panel members responded — this deliberation had no cross-model diversity.";
		}
		if (runCtrl.signal.aborted) throw new Error("aborted by user");

		// ---- Stage 2: ANALYST ----------------------------------------------
		status = "analyzing";
		saveTask();
		setUiStatus(`⧗ ${taskName} — analyst`);
		const panelTranscript = panelOutputs
			.map((p) => `=== RESPONSE FROM MODEL: ${p.model} ===\n${p.content}`)
			.join("\n\n");
		let analysis: any;
		const analystMessages = [
			{ role: "system", content: ANALYST_SYSTEM },
			{
				role: "user",
				content: `ORIGINAL PROMPT GIVEN TO EACH MODEL:\n${opts.prompt}\n\nMODEL RESPONSES:\n\n${panelTranscript}`,
			},
		];
		// Try the configured analyst, then an optional fallback analyst, then degrade.
		const analystCandidates: { label: string; model: string }[] = [
			{ label: "analyst", model: roles.analyst.model },
		];
		if (cfg.roles.analystFallback) {
			analystCandidates.push({ label: "analyst-fallback", model: cfg.roles.analystFallback });
		}
		let analystSavedGarbage: string | null = null;
		analystLoop: for (const cand of analystCandidates) {
			for (let attempt = 1; attempt <= 2; attempt++) {
				if (runCtrl.signal.aborted) break analystLoop;
				try {
					if (attempt === 2) setUiStatus(`⧗ ${taskName} — ${cand.label} (retry, clean JSON)`);
					else setUiStatus(`⧗ ${taskName} — ${cand.label}`);
					const messages =
						attempt === 1
							? analystMessages
							: [
									...analystMessages,
									{ role: "assistant", content: analystSavedGarbage ?? "" },
									{
										role: "user",
										content:
											"Your previous output was not valid JSON matching the required schema. Return ONLY the corrected JSON object now — no prose, no markdown fences.",
									},
								];
					const res = await chat(
						apiKey,
						baseUrl,
						resolveModelRef(cand.model).apiId,
						messages,
						{
							temperature: 0,
							timeoutMs,
							retries: attempt === 1 ? 1 : 0,
							externalSignal: runCtrl.signal,
							jsonMode: true,
						}
					);
					record.costUsd = (record.costUsd ?? 0) + (res.costUsd ?? 0);
					const text = res.content;
					if (isDegenerate(text)) {
						analystSavedGarbage = text;
						continue; // retry this candidate
					}
					const parsed = extractJson(text);
					if (parsed) {
						analysis = parsed;
						writeFileSync(join(dir, "analysis.json"), JSON.stringify(parsed, null, 2) + "\n");
						break analystLoop;
					}
					analystSavedGarbage = text;
				} catch (err: any) {
					record.failedModels = [
						...(record.failedModels ?? []),
						{ model: cand.model + " (" + cand.label + ")", reason: err.message },
					];
					saveTask();
					break; // try next candidate, don't retry crashed calls here
				}
			}
		}
		if (!analysis && analystSavedGarbage !== null) {
			writeFileSync(join(dir, "analysis-fallback.md"), analystSavedGarbage + "\n");
		}
		if (analysis) {
			writeFileSync(join(dir, "analysis.json"), JSON.stringify(analysis, null, 2) + "\n");
		}
		if (runCtrl.signal.aborted) throw new Error("aborted by user");

		// ---- Stage 3: JUDGE -------------------------------------------------
		status = "judging";
		saveTask();
		setUiStatus(`⧗ ${taskName} — judge`);
		const analysisBlock = analysis
			? `STRUCTURED ANALYSIS OF THE PANEL RESPONSES:\n${JSON.stringify(analysis, null, 2)}\n\n`
			: `RAW PANEL RESPONSES (analyst unavailable — compare them yourself):\n\n${panelTranscript}\n\n`;
		let verdict: string | null = null;
		try {
			const judgeRes = await chat(apiKey, baseUrl, resolveModelRef(roles.judge.model).apiId, [
				{ role: "system", content: JUDGE_SYSTEM },
				{
					role: "user",
					content: `ORIGINAL PROMPT:\n${opts.prompt}\n\n${analysisBlock}`,
				},
			], {
				timeoutMs,
				retries: 1,
				externalSignal: runCtrl.signal,
			});
			record.costUsd = (record.costUsd ?? 0) + (judgeRes.costUsd ?? 0);
			verdict = judgeRes.content;
		} catch (err: any) {
			// Judge failed — degrade instead of losing the whole run.
			record.failedModels = [
				...(record.failedModels ?? []),
				{ model: roles.judge.model + " (judge)", reason: err.message },
			];
			saveTask();
		}

		const finalFile = join(dir, `Final-${slugify(taskName)}.md`);
		if (verdict !== null) {
			writeFileSync(finalFile, formatFinal(record, analysis, verdict));
		} else {
			// Degraded mode: hand back the analysis + best available panel output.
			writeFileSync(finalFile, formatDegradedFinal(record, analysis, panelOutputs, panelTranscript));
		}

		status = verdict !== null ? "complete" : "degraded";
		record.finishedAt = Date.now();
		saveTask();
		// Record spend in persistent config for limit enforcement.
		try {
			const cfg2 = loadConfig();
			cfg2.usage.push({ taskId, taskName, costUsd: record.costUsd ?? 0, finishedAt: Date.now() });
			saveConfig(cfg2);
		} catch {
			// non-fatal
		}
		ctx.ui.setStatus?.("pi-shora", "");
		ctx.ui.notify(`Deliberation complete: ${taskId}`, "info");
		return { taskId, dir, finalFile };
	} catch (err: any) {
		status = err.name === "AbortError" || /aborted/i.test(err.message) ? "failed" : "failed";
		record.error = err.message;
		record.finishedAt = Date.now();
		saveTask();
		ctx.ui.setStatus?.("pi-shora", "");
		ctx.ui.notify(`Deliberation failed (${taskId}): ${err.message}`, "error");
		throw err;
	} finally {
		ctx.signal?.removeEventListener("abort", onCtxAbort);
	}
}

function deriveTaskName(prompt: string): string {
	const firstLine = prompt.split("\n")[0].trim();
	return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine || "deliberation";
}

function formatDegradedFinal(
	record: TaskRecord,
	analysis: any,
	panelOutputs: { model: string; content: string }[],
	panelTranscript: string
): string {
	const bestPanel = panelOutputs[0]; // only survivor ordering; all are listed below anyway
	const lines = [
		`# Deliberation Result (DEGRADED) — ${record.name}`,
		"",
		`> **The judge model (${record.roles.judge}) failed**, so no synthesized verdict was produced.`,
		"> Below is what the deliberation did produce: the analyst's structured comparison",
		"> and the surviving panel response(s). Re-run with a working judge to get a synthesis.",
		"",
		formatFinal(record, analysis, "").split("---")[0],
		"---",
		"",
	];
	if (analysis) {
		lines.push("## Analyst comparison", "", "```json", JSON.stringify(analysis, null, 2), "```", "");
	}
	if (bestPanel) {
		lines.push(`## Panel response — ${bestPanel.model}`, "", bestPanel.content, "");
	}
	if (!analysis && !bestPanel) {
		lines.push("## Raw material", "", panelTranscript, "");
	}
	return lines.join("\n") + "\n";
}

function explainFailure(err: any): string {
	const msg = String(err?.message ?? err);
	if (/rate-limited upstream|add your own key/i.test(msg)) {
		return (
			msg +
			" [NOTE: this is a shared-pool limit on a :free model — not an auth problem. " +
			"Retry later or use paid-tier models.]"
		);
	}
	if (err?.name === "AbortError" || /operation was aborted/i.test(msg)) {
		return (
			msg +
			` [NOTE: Pi-Shora per-call timeout fired — raise it with /pi-shora timeout <seconds>.]`
		);
	}
	return msg;
}

function sanitizeFile(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function formatFinal(record: TaskRecord, analysis: any, verdict: string): string {
	const lines = [
		`# Deliberation Verdict — ${record.name}`,
		"",
		`- **Task ID:** \`${record.id}\``,
		`- **Completed:** ${new Date().toISOString()}`,
		`- **Judge:** ${record.roles.judge}`,
		`- **Analyst:** ${record.roles.analyst}`,
		`- **Panel:** ${record.roles.panel.join(", ")}`,
	];
	if (record.failedModels?.length) {
		lines.push(`- **Failures:** ${record.failedModels.map((f) => `${f.model} (${f.reason.split(":")[0]})`).join("; ")}`);
	}
	if (record.degradedNote) {
		lines.push("", `> ⚠️ ${record.degradedNote}`, "");
	}
	lines.push(
		`- **Prompt:**`,
		"",
		"> " + record.prompt.replace(/\n/g, "\n> "),
		"",
		"---",
		"",
		verdict
	);
	if (!analysis) {
		lines.push("", "---", "", "_Note: analyst output was unavailable or invalid; the judge worked directly from raw panel responses (see analysis-fallback.md / panel/)._");
	}
	return lines.join("\n") + "\n";
}
