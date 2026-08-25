/**
 * Runner that uses jiti (the same loader pi uses) so extensionless TS imports
 * resolve during standalone testing.
 *
 * Usage:
 *   node --experimental-strip-types scripts/run.ts scripts/test-pipeline.ts "<prompt>"
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const target = process.argv[2];
if (!target) {
	console.error("Usage: node --experimental-strip-types scripts/run.ts <target.ts> [args...]");
	process.exit(1);
}
await jiti.import(target);
