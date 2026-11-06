#!/usr/bin/env bash
# Builds @nodestro/client, starts a test server (scripts/test_server.py) and runs the smoke checks
# (typescript/smoke/checks.mjs) in each given runtime: node, bun, deno, chromium, firefox, webkit (SDK-006).
# Usage: scripts/check_runtimes.sh node bun deno chromium firefox webkit
# Environment: PYTHON (with nodestro-api installed; default python3), BUN and DENO (commands; default `npx --yes
# bun@1.4.4` and `npx --yes deno@2.9.6`), API_PORT (port of the test server) and SMOKE_PORT (port of the page server
# of the browser checks); both default to a free port.
# The browsers need Playwright (a devDependency) and its browsers: npx playwright install --with-deps <browser>.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -gt 0 ] || { echo "usage: $0 node|bun|deno|chromium|firefox|webkit ..." >&2; exit 2; }
python="${PYTHON:-python3}"
bun="${BUN:-npx --yes bun@1.4.4}"
deno="${DENO:-npx --yes deno@2.9.6}"
port="${API_PORT:-$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}"
data="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$data"
}
trap cleanup EXIT

(cd "$root/typescript" && npm run --silent build)
"$python" "$root/scripts/test_server.py" --data-dir "$data/data" --port "$port" >"$data/server.log" 2>&1 &
server_pid=$!
url="http://127.0.0.1:$port"
for _ in $(seq 1 240); do
  if curl -fsS "$url/api/meta" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$data/server.log" >&2; exit 1; fi
  sleep 0.25
done
curl -fsS "$url/api/meta" >/dev/null || { cat "$data/server.log" >&2; exit 1; }

browsers=()
status=0
for runtime in "$@"; do
  case "$runtime" in
    node) node "$root/typescript/smoke/runtime.mjs" "$url" "node-$(node --version)" || status=1 ;;
    bun) $bun "$root/typescript/smoke/runtime.mjs" "$url" "bun-$($bun --version)" || status=1 ;;
    deno) $deno run --allow-net --allow-read --allow-env "$root/typescript/smoke/runtime.mjs" "$url" \
      "deno-$($deno --version | head -1 | cut -d' ' -f2)" || status=1 ;;
    chromium|firefox|webkit) browsers+=("$runtime") ;;
    *) echo "unknown runtime: $runtime" >&2; exit 2 ;;
  esac
done
if [ ${#browsers[@]} -gt 0 ]; then
  (node "$root/typescript/smoke/browsers.mjs" "$url" "${browsers[@]}") || status=1
fi
exit "$status"
