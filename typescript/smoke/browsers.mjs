/**
 * Runs the smoke checks in real browsers with Playwright: node typescript/smoke/browsers.mjs <API URL> chromium firefox
 * webkit. A small server on 127.0.0.1 serves a page, the built package and checks.mjs, and passes every other path
 * to the API, so the page and the API share one origin (the API sends no CORS headers for other origins). Needs
 * the built package and the Playwright browsers (npx playwright install --with-deps <browser>).
 */

import { createReadStream, existsSync } from "node:fs";
import { createServer, request as forward } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist");
const [apiUrl, ...wanted] = process.argv.slice(2);
if (!apiUrl || wanted.length === 0) throw new Error("usage: browsers.mjs <API URL> chromium|firefox|webkit ...");
const engines = { chromium, firefox, webkit };
for (const name of wanted) if (!engines[name]) throw new Error(`unknown browser ${name}`);

const page = `<!doctype html><meta charset="utf-8"><title>smoke</title>
<script type="module">
  import * as sdk from "/__smoke/sdk/index.js";
  import { runChecks } from "/__smoke/checks.mjs";
  window.smoke = (name) => runChecks(sdk, location.origin, name);
</script>`;

const api = new URL(apiUrl);
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json" };

function serveFile(file, response) {
  if (!existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://smoke").pathname;
  if (path === "/__smoke/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
  } else if (path === "/__smoke/checks.mjs") {
    serveFile(join(here, "checks.mjs"), response);
  } else if (path.startsWith("/__smoke/sdk/")) {
    const file = normalize(join(dist, path.slice("/__smoke/sdk/".length)));
    if (!file.startsWith(dist)) response.writeHead(404).end();
    else serveFile(file, response);
  } else {
    // Everything else goes to the API, streamed both ways (event streams included). The Host header stays this
    // server's, as behind a reverse proxy, so the API sees the page's own origin.
    const upstream = forward(
      { host: api.hostname, port: api.port, method: request.method, path: request.url, headers: request.headers },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  }
});
await new Promise((done) => server.listen(Number(process.env.SMOKE_PORT ?? 0), "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

let failed = false;
try {
  for (const name of wanted) {
    let browser;
    try {
      browser = await engines[name].launch();
      const tab = await browser.newPage();
      const errors = [];
      tab.on("pageerror", (error) => errors.push(String(error)));
      await tab.goto(`${origin}/__smoke/`);
      await tab.waitForFunction(() => typeof window.smoke === "function", null, { timeout: 15_000 });
      const passed = await tab.evaluate((label) => window.smoke(label), name);
      console.log(`${name} ${browser.version()}: ${passed.length} smoke checks passed (${passed.join(", ")})`);
      if (errors.length) throw new Error(errors.join("\n"));
    } catch (error) {
      failed = true;
      console.error(`${name}: FAILED: ${error instanceof Error ? error.message.split("\n").filter((line) => line.trim()).slice(0, 4).join(" ") : error}`);
    } finally {
      await browser?.close();
    }
  }
} finally {
  server.closeAllConnections();
  server.close();
}
process.exitCode = failed ? 1 : 0;
