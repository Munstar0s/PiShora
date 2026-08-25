// Standalone end-to-end test of the Phase 2 pipeline.
// Usage: node --experimental-strip-types scripts/test-pipeline.ts "<prompt>"
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
process.env.OPENROUTER_API_KEY = auth.openrouter?.key;

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
	panelOverride: [
		"~openai/gpt-4o-mini",
		"~google/gemini-flash-latest",
	],
});
console.log("RESULT:", JSON.stringify(result, null, 2));
