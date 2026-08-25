// Runner that uses jiti (same loader pi uses) so extensionless TS imports resolve.
import { createJiti } from "file:///Users/star0s/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
await jiti.import("./test-pipeline.ts");
