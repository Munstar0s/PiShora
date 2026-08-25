import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Model-reference resolution.
 *
 * v1 grammar: "~vendor/model-slug" -> OpenRouter chat completions.
 * The resolver abstraction exists so v2 can add local/private endpoints
 * (e.g. "local:ollama/llama3") without touching pipeline code.
 */

export interface ResolvedModel {
	transport: "openrouter";
	/** Model id as sent to the OpenRouter API (leading ~ stripped) */
	apiId: string;
}

export function resolveModelRef(ref: string): ResolvedModel {
	const trimmed = ref.trim();
	if (!trimmed) throw new Error("Empty model reference");
	if (trimmed.startsWith("local:")) {
		throw new Error(
			`Local model refs ("${trimmed}") are planned for v2 and not supported yet.`
		);
	}
	// OpenRouter ref: optional "~latest-resolution" prefix per OpenRouter docs.
	return { transport: "openrouter", apiId: trimmed.replace(/^~/, "") };
}

/**
 * Resolve the OpenRouter credentials already configured in pi's provider
 * settings (the same key /model uses). Falls back to $OPENROUTER_API_KEY.
 */
export async function getOpenRouterAuth(
	ctx: ExtensionContext
): Promise<{ apiKey: string; baseUrl: string }> {
	try {
		const result = await ctx.modelRegistry.getProviderAuth("openrouter");
		const auth = (result as any)?.auth ?? result;
		if (auth?.apiKey) {
			return {
				apiKey: auth.apiKey,
				baseUrl: auth.baseUrl ?? "https://openrouter.ai/api/v1",
			};
		}
	} catch {
		// provider not registered in pi; fall through to env var
	}
	const envKey = process.env.OPENROUTER_API_KEY;
	if (envKey) {
		return { apiKey: envKey, baseUrl: "https://openrouter.ai/api/v1" };
	}
	throw new Error(
		"No OpenRouter API key found. Configure the openrouter provider via /model, " +
			"or set OPENROUTER_API_KEY."
	);
}
