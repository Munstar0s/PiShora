import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CREDITS_FILE } from "./paths";

// ---------------------------------------------------------------------------
// Pricing catalog (from /api/v1/models), cached daily on disk
// ---------------------------------------------------------------------------

export interface ModelPricing {
	/** USD per million prompt tokens */
	promptPerM: number;
	/** USD per million completion tokens */
	completionPerM: number;
}

interface PricingCache {
	fetchedAt: number;
	prices: Record<string, ModelPricing>;
}

const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function pricingCachePath(): string {
	return CREDITS_FILE.replace(/credits\.json$/, "pricing.json");
}

async function fetchPricing(apiKey: string, baseUrl: string): Promise<Record<string, ModelPricing>> {
	const res = await fetch(`${baseUrl}/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching model catalog`);
	const body: any = await res.json();
	const prices: Record<string, ModelPricing> = {};
	for (const m of body?.data ?? []) {
		const p = m?.pricing;
		if (!p) continue;
		const prompt = Number(p.prompt);
		const completion = Number(p.completion);
		if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
		prices[m.id] = {
			promptPerM: prompt * 1_000_000,
			completionPerM: completion * 1_000_000,
		};
	}
	return prices;
}

export async function getPricing(
	apiKey: string,
	baseUrl: string
): Promise<Record<string, ModelPricing>> {
	const path = pricingCachePath();
	if (existsSync(path)) {
		try {
			const cache = JSON.parse(readFileSync(path, "utf8")) as PricingCache;
			if (Date.now() - cache.fetchedAt < PRICING_CACHE_TTL_MS && Object.keys(cache.prices).length > 0) {
				return cache.prices;
			}
		} catch {
			// corrupt cache → refetch
		}
	}
	const prices = await fetchPricing(apiKey, baseUrl);
	try {
		writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), prices } satisfies PricingCache));
	} catch {
		// non-fatal
	}
	return prices;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

export interface EstimateInput {
	panel: string[];
	analystModel: string;
	judgeModel: string;
	promptChars: number;
	/** Assumed output tokens per role call */
	maxOutputTokens?: number;
}

export interface EstimateResult {
	totalUsd: number;
	breakdown: { label: string; usd: number | null }[];
	hasUnknownPrices: boolean;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;
/** Analyst/judge receive the full panel transcript as extra input. */
const TRANSCRIPT_OVERHEAD_FACTOR = 2.5;

function priceCall(
	model: string,
	inputTokens: number,
	outputTokens: number,
	prices: Record<string, ModelPricing>
): number | null {
	const p = prices[model];
	if (!p) return null;
	return (inputTokens / 1_000_000) * p.promptPerM + (outputTokens / 1_000_000) * p.completionPerM;
}

export function estimateCost(input: EstimateInput, prices: Record<string, ModelPricing>): EstimateResult {
	const outTok = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const promptTok = Math.ceil(input.promptChars / CHARS_PER_TOKEN);

	const breakdown: EstimateResult["breakdown"] = [];
	let total = 0;
	let hasUnknown = false;

	for (const model of input.panel) {
		const c = priceCall(model, promptTok + 200, outTok, prices);
		if (c === null) {
			hasUnknown = true;
			breakdown.push({ label: `panel ${model}: unknown pricing`, usd: null });
		} else {
			total += c;
			breakdown.push({ label: `panel ${model}`, usd: c });
		}
	}

	const innerInputTok = promptTok * TRANSCRIPT_OVERHEAD_FACTOR + promptTok + 500;
	for (const [label, model] of [
		["analyst", input.analystModel],
		["judge", input.judgeModel],
	] as const) {
		const c = priceCall(model, innerInputTok, outTok, prices);
		if (c === null) {
			hasUnknown = true;
			breakdown.push({ label: `${label} ${model}: unknown pricing`, usd: null });
		} else {
			total += c;
			breakdown.push({ label: `${label} ${model}`, usd: c });
		}
	}

	return { totalUsd: total, breakdown, hasUnknownPrices: hasUnknown };
}

export function formatEstimate(est: EstimateResult): string {
	const lines = est.breakdown.map((b) => {
		const v = b.usd === null ? "?" : `$${b.usd.toFixed(4)}`;
		return `    ${b.label}: ${v}`;
	});
	lines.unshift(`  Estimated cost: ~$${est.totalUsd.toFixed(4)}${est.hasUnknownPrices ? " (+ models with unknown pricing)" : ""}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Credits (OpenRouter key balance)
// ---------------------------------------------------------------------------

export interface CreditSnapshot {
	checkedAt: number;
	/** Remaining credits in USD, null if the key has no hard pool */
	remainingUsd: number | null;
	spendUsd: number | null;
	limitUsd: number | null;
}

export function readCreditCache(): CreditSnapshot | null {
	if (!existsSync(CREDITS_FILE)) return null;
	try {
		return JSON.parse(readFileSync(CREDITS_FILE, "utf8")) as CreditSnapshot;
	} catch {
		return null;
	}
}

const CREDIT_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getCredits(apiKey: string, baseUrl: string): Promise<CreditSnapshot> {
	const cached = readCreditCache();
	if (cached && Date.now() - cached.checkedAt < CREDIT_CACHE_TTL_MS) return cached;

	const snap: CreditSnapshot = { checkedAt: Date.now(), remainingUsd: null, spendUsd: null, limitUsd: null };
	try {
		const res = await fetch(`${baseUrl}/credits`, { headers: { Authorization: `Bearer ${apiKey}` } });
		if (res.ok) {
			const d = (await res.json())?.data ?? {};
			const total = Number(d.total_credits);
			const used = Number(d.total_usage);
			if (Number.isFinite(total) && Number.isFinite(used)) {
				snap.spendUsd = used;
				snap.remainingUsd = total - used;
			}
		} else {
			// Fallback: /key gives usage vs optional hard limit
			const kres = await fetch(`${baseUrl}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
			if (kres.ok) {
				const d = (await kres.json())?.data ?? {};
				snap.spendUsd = Number.isFinite(Number(d.usage)) ? Number(d.usage) : null;
				snap.limitUsd = Number.isFinite(Number(d.limit)) && Number(d.limit) > 0 ? Number(d.limit) : null;
				if (snap.spendUsd !== null && snap.limitUsd !== null) {
					snap.remainingUsd = snap.limitUsd - snap.spendUsd;
				}
			}
		}
	} catch {
		// network error → keep nulls, caller treats as unknown
	}
	try {
		writeFileSync(CREDITS_FILE, JSON.stringify(snap, null, 2) + "\n");
	} catch {
		// non-fatal
	}
	return snap;
}
