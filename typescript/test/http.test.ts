/** The HTTP layer without a server: retries, error formats and the event parser. */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  EventParser,
  NodestroAPIError,
  NodestroConnectionError,
  NodestroClient,
  type ServerEvent,
} from "../src/index.js";

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

describe("event streams", () => {
  const encoder = new TextEncoder();

  /** A client whose event stream sends `chunks`, then ends (`end`), stays open (`hold`) or breaks (`fail`). */
  function streaming(chunks: string[], after: "end" | "hold" | "fail" = "end") {
    const state = {
      cancels: 0,
      stream: undefined as ReadableStream<Uint8Array> | undefined,
      signal: undefined as AbortSignal | undefined,
    };
    const client = new NodestroClient("http://nodestro.test", {
      fetch: async (_url, init) => {
        state.signal = init?.signal ?? undefined;
        let sent = 0;
        state.stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Like fetch: aborting the request errors its body.
            init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
          pull(controller) {
            if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]!));
            else if (after === "end") controller.close();
            else if (after === "fail") controller.error(new TypeError("terminated"));
            else return new Promise(() => undefined);
          },
          cancel() {
            state.cancels++;
          },
        });
        return new Response(state.stream, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    return { client, state };
  }

  it("delivers every event of a stream the server ends, including a last one without a blank line", async () => {
    const { client, state } = streaming(['event: snapshot\ndata: {"a":1}\n\n', "event: end\nid: 2\ndata: {}"]);
    const events: ServerEvent[] = [];
    for await (const event of client.events("run_1")) events.push(event);
    expect(events).toEqual([
      { event: "snapshot", data: { a: 1 }, id: undefined },
      { event: "end", data: {}, id: "2" },
    ]);
    expect(state.cancels).toBe(0);
    expect(state.stream!.locked).toBe(false);
  });

  it("ends the connection when the consumer stops early, once", async () => {
    const { client, state } = streaming(['event: snapshot\ndata: {"a":1}\n\n'], "hold");
    for await (const event of client.events("run_1")) {
      expect(event.event).toBe("snapshot");
      break;
    }
    expect(state.cancels).toBe(1);
    expect(state.stream!.locked).toBe(false);
    const events = client.events("run_2");
    await events.next();
    await Promise.all([events.return(undefined), events.return(undefined)]);
    expect(state.cancels).toBe(2); // once more, for the second stream
  });

  it("ends the connection when the consumer throws", async () => {
    const { client, state } = streaming(["data: 1\n\n"], "hold");
    const consume = async () => {
      for await (const _ of client.events("run_1")) throw new Error("consumer failed");
    };
    await expect(consume()).rejects.toThrow("consumer failed");
    expect(state.cancels).toBe(1);
    expect(state.stream!.locked).toBe(false);
  });

  it("stops on an abort signal while waiting for data and tolerates repeated stops", async () => {
    const { client, state } = streaming(["data: 1\n\n"], "hold");
    const controller = new AbortController();
    const events = client.events("run_1", { signal: controller.signal });
    expect((await events.next()).value).toMatchObject({ data: 1 });
    expect(state.signal).toBe(controller.signal);
    const waiting = events.next();
    controller.abort();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(state.stream!.locked).toBe(false);
    await expect(events.return(undefined)).resolves.toEqual({ done: true, value: undefined });
    await expect(events.return(undefined)).resolves.toEqual({ done: true, value: undefined });
    expect(state.cancels).toBe(0); // the aborted request already ended its stream
  });

  it("reports a broken connection and releases the stream", async () => {
    const { client, state } = streaming(["data: 1\n\n", "data: 2\n"], "fail");
    const events: ServerEvent[] = [];
    const consume = async () => {
      for await (const event of client.events("run_1")) events.push(event);
    };
    await expect(consume()).rejects.toThrow("terminated");
    expect(events.map((event) => event.data)).toEqual([1]);
    expect(state.stream!.locked).toBe(false);
    expect(state.cancels).toBe(0); // a failed stream has nothing left to cancel
  });

  it("passes data that is no JSON through as text and skips malformed lines", async () => {
    const { client } = streaming(["data: {not json\n\n", "nonsense line\n: comment\nretry: 5\ndata: [1]\n\n"]);
    const events: ServerEvent[] = [];
    for await (const event of client.events("run_1")) events.push(event);
    expect(events.map((event) => event.data)).toEqual(["{not json", [1]]);
  });

  it("ends the connection of a real Node.js HTTP stream when the consumer stops", async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => (closed = resolve));
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("event: snapshot\ndata: {}\n\n");
      const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20);
      request.socket.on("close", () => {
        clearInterval(keepAlive);
        closed();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new NodestroClient(`http://127.0.0.1:${port}`);
      for await (const event of client.events("run_1")) {
        expect(event.event).toBe("snapshot");
        break;
      }
      await disconnected; // the test times out if the connection stays open
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
