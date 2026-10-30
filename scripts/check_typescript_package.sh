#!/usr/bin/env bash
# Installs the packed @nodestro/client tarball into a fresh project outside the checkout, compiles a
# strict TypeScript consumer against its type definitions and runs it with Node.js.
# Usage: scripts/check_typescript_package.sh [SERVER_URL]  (with a URL the consumer also calls the API)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$root/typescript" && npm run --silent build && npm pack --silent --pack-destination "$work" >/dev/null)
tarball="$(ls "$work"/nodestro-client-*.tgz)"
tsc_version="$(node -p "require('$root/typescript/package.json').devDependencies.typescript")"
types_version="$(node -p "require('$root/typescript/package.json').devDependencies['@types/node']")"

cd "$work"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --silent --no-audit --no-fund "$tarball" "typescript@$tsc_version" "@types/node@$types_version"

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": false,
    "outDir": "out",
    "skipLibCheck": false,
    "types": ["node"]
  },
  "files": ["consumer.ts"]
}
JSON

cat > consumer.ts <<'TS'
import {
  API_VERSION,
  NodestroAPIError,
  NodestroClient,
  NodestroClientError,
  NodestroConnectionError,
  PublishedWorkflow,
  type Run,
  type RunStatusOut,
  type components,
} from "@nodestro/client";

const meta: components["schemas"]["Meta"] | undefined = undefined;
void meta;
const server = process.argv[2];
const unreachable = new NodestroClient("http://127.0.0.1:9", { retry: { attempts: 1 } });
const error = await unreachable.meta().catch((caught: unknown) => caught);
if (!(error instanceof NodestroConnectionError) || !(error instanceof NodestroClientError)) throw new Error("expected a connection error");
const api = new PublishedWorkflow("http://127.0.0.1:9", "slug", { apiKey: "ndk_test" });
const started: Promise<RunStatusOut> = api.start({}).catch(() => ({}) as RunStatusOut);
await started;
if (server) {
  const nodestro = new NodestroClient(server);
  const info = await nodestro.meta();
  const missing = await nodestro.getRun("run_missing").catch((caught: unknown) => caught);
  if (!(missing instanceof NodestroAPIError) || missing.status !== 404) throw new Error("expected a 404");
  const runs: Run[] = [];
  console.log(`consumer ok: API ${API_VERSION}, server ${info.version}, ${runs.length} runs`);
} else {
  console.log(`consumer ok: API ${API_VERSION}`);
}
TS

npx tsc -p tsconfig.json
node out/consumer.js ${1:-}
# The package holds the build, its type definitions, the README and the license, nothing else.
tar -tzf "$tarball" | sort
