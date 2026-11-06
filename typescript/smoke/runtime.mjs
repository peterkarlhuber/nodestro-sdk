/**
 * Runs the smoke checks in this JavaScript runtime: `node`, `bun` or `deno run --allow-net --allow-read`
 * typescript/smoke/runtime.mjs <API URL> <name>. Needs the built package (npm run build in typescript/).
 */

import * as sdk from "../dist/index.js";
import { runChecks } from "./checks.mjs";

const args = globalThis.Deno ? globalThis.Deno.args : process.argv.slice(2);
const [baseUrl, name = "runtime"] = args;
if (!baseUrl) throw new Error("usage: runtime.mjs <API URL> [name]");
const passed = await runChecks(sdk, baseUrl, name);
console.log(`${name}: ${passed.length} smoke checks passed (${passed.join(", ")})`);
