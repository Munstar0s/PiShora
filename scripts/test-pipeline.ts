/**
 * Standalone end-to-end test of the deliberation pipeline.
 *
 * Reads OPENROUTER_API_KEY from the environment (do NOT hardcode keys).
 * If absent, falls back to pi's auth.json if it exists on this machine.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node --experimental-strip-types scripts/run.ts scripts/test-pipeline.ts "<prompt>"
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Resolve the API key from env, or optionally from pi's auth.json for local dev.
if (!process.env.OPENROUTER_API_KEY) {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (existsSync(authPath)) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf8"));
			process.env.OPENROUTER_API_KEY = auth.openrouter?.key;
		} catch {
			// ignore
		}
	}
}

if (!process.env.OPENROUTER_API_KEY) {
	console.error("Set OPENROUTER_API_KEY before running this test.");
	process.exit(1);
}

const prompt = process.argv[2] ?? "Is 0.999... equal to 1? Give the strongest argument.";

const fakeCtx: any = {
	ui: {
		notify: (msg: string) => console.log(`[notify] ${msg}`),
		setStatus: (_k: string, v: string) => console.log(`[status] ${v}`),
	},
	modelRegistry: { getProviderAuth: async () => undefined }, // force env-var fallback
};

const { runDeliberation } = await import("../src/pipeline.ts");

const result = await runDeliberation(fakeCtx, {
	prompt,
	taskName: "pipeline-smoke-test",
});
console.log("RESULT:", JSON.stringify(result, null, 2));
