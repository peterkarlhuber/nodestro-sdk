/** The HTTP layer without a server: retries, error formats and the event parser. */

import { describe, expect, it } from "vitest";
import { EventParser, NodestroAPIError, NodestroConnectionError, NodestroClient } from "../src/index.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("transport", () => {
  it("retries a safe request after 503 and a connection error", async () => {
    const answers: Array<() => Response> = [
      () => json(503, {}),
      () => {
        throw new TypeError("fetch failed");
      },
      () => json(200, { version: "0.2.0" }),
    ];
    let calls = 0;
    const client = new NodestroClient("http://nodestro.test", {
      retry: { backoffMs: 1 },
      fetch: async () => answers[calls++]!(),
    });
    expect((await client.meta()).version).toBe("0.2.0");
    expect(calls).toBe(3);
  });

  it("never retries a request that changes something", async () => {
    let calls = 0;
    const client = new NodestroClient("http://nodestro.test", {
      retry: { backoffMs: 1 },
      fetch: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
    });
    await expect(client.startRun("wf_1")).rejects.toBeInstanceOf(NodestroConnectionError);
    expect(calls).toBe(1);
  });

  it("reads both error formats", () => {
    const studio = NodestroAPIError.fromResponse(400, { detail: "x", code: "run.agents_invalid", params: { n: 1 } });
    expect([studio.code, studio.params]).toEqual(["run.agents_invalid", { n: 1 }]);
    const published = NodestroAPIError.fromResponse(401, { error: { code: "auth.missing", message: "no key" } });
    expect([published.code, published.detail]).toEqual(["auth.missing", "no key"]);
    expect(NodestroAPIError.fromResponse(500, undefined, "boom").code).toBe("http_error");
  });
});

describe("event parser", () => {
  it("parses events split across chunks, multi-line data and comments", () => {
    const parser = new EventParser();
    const events = [
      ...parser.push(": keep-alive\n\nevent: snap"),
      ...parser.push('shot\nid: 1\ndata: {"a":\ndata: 1}\n\n'),
      ...parser.push("data: plain\r\n\r\n"),
    ];
    expect(events).toEqual([
      { event: "snapshot", data: { a: 1 }, id: "1" },
      { event: "message", data: "plain", id: "1" },
    ]);
  });
});
