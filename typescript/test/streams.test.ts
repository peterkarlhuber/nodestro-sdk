/**
 * Reconnecting event streams and streamed downloads (SDK-004), without a Nodestro server: fetch doubles whose
 * bodies break like fetch bodies do, and small real Node.js HTTP servers that drop their connections.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECONNECT,
  NodestroClient,
  NodestroConnectionError,
  NodestroTimeoutError,
  PublishedWorkflow,
  type ServerEvent,
} from "../src/index.js";

const encoder = new TextEncoder();
const FAST = { attempts: 3, backoffMs: 1, maxBackoffMs: 1 };

/** A body that sends `chunks`, then ends (`end`), breaks (`fail`) or stays open (`hold`); aborting the request errors it. */
function body(chunks: string[], after: "end" | "fail" | "hold", signal?: AbortSignal | null, state = { pulled: 0, cancels: 0 }) {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
      pull(controller) {
        if (state.pulled < chunks.length) controller.enqueue(encoder.encode(chunks[state.pulled++]!));
        else if (after === "end") controller.close();
        else if (after === "fail") controller.error(new TypeError("terminated"));
        else return new Promise(() => undefined);
      },
      cancel() {
        state.cancels++;
      },
    },
    { highWaterMark: 0 },
  );
}

type Answer = (init: RequestInit) => Response | Promise<Response>;

/** A fetch that gives `answers` in order (the last one repeats) and records the request headers. */
function scripted(answers: Answer[]) {
  const seen: Headers[] = [];
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    seen.push(new Headers(init.headers));
    urls.push(String(input));
    return answers[Math.min(seen.length, answers.length) - 1]!(init);
  }) as typeof fetch;
  return { fetcher, seen, urls };
}

const sse = (chunks: string[], after: "end" | "fail" | "hold" = "end"): Answer => (init) =>
  new Response(body(chunks, after, init.signal), { headers: { "Content-Type": "text/event-stream" } });

const published = (fetcher: typeof fetch) => new PublishedWorkflow("http://nodestro.test", "slug", { apiKey: "ndk_test", fetch: fetcher });

async function collect(events: AsyncIterable<ServerEvent>): Promise<ServerEvent[]> {
  const got: ServerEvent[] = [];
  for await (const event of events) got.push(event);
  return got;
}

describe("reconnecting event streams", () => {
  it("resumes a dropped published stream with the last event id", async () => {
    const { fetcher, seen } = scripted([
      sse(['id: 1\nevent: status\ndata: {"status":"running"}\n\n', "id: 2\nevent: node_started\ndata: {}\n\n"], "fail"),
      sse(['event: status\ndata: {"status":"running"}\n\nid: 3\nevent: node_finished\ndata: {}\n\n', "event: end\ndata: {}\n\n"]),
    ]);
    const events = await collect(published(fetcher).events("run_1", { reconnect: FAST }));
    expect(events.map((event) => [event.event, event.id])).toEqual([
      ["status", "1"],
      ["node_started", "2"],
      ["status", undefined],
      ["node_finished", "3"],
      ["end", "3"],
    ]);
    expect(seen.map((headers) => headers.get("last-event-id"))).toEqual([null, "2"]);
  });

  it("sends a given last event id first and replaces it with newer ones", async () => {
    const { fetcher, seen } = scripted([sse(["id: 9\nevent: x\ndata: 1\n\n"], "fail"), sse(["event: end\ndata: {}\n\n"])]);
    const events = await collect(published(fetcher).events("run_1", { lastEventId: "7", reconnect: FAST }));
    expect(events.map((event) => event.event)).toEqual(["x", "end"]);
    expect(seen.map((headers) => headers.get("last-event-id"))).toEqual(["7", "9"]);
  });

  it("reconnects a stream that ends before its end event, and stops after end", async () => {
    const { fetcher, seen } = scripted([sse(["event: status\ndata: {}\n\n"]), sse(["event: end\ndata: {}\n\nevent: extra\ndata: {}\n\n"])]);
    expect((await collect(published(fetcher).events("run_1", { reconnect: FAST }))).map((event) => event.event)).toEqual(["status", "end"]);
    expect(seen).toHaveLength(2);
    const once = scripted([sse(["event: status\ndata: {}\n\n"])]);
    expect((await collect(published(once.fetcher).events("run_1"))).map((event) => event.event)).toEqual(["status"]);
    expect(once.seen).toHaveLength(1);
  });

  it("throws as before without reconnect", async () => {
    const { fetcher, seen } = scripted([sse(["data: 1\n\n"], "fail")]);
    await expect(collect(published(fetcher).events("run_1"))).rejects.toThrow(NodestroConnectionError);
    expect(seen).toHaveLength(1);
  });

  it("gives up after the attempts in a row without progress", async () => {
    const refused = scripted([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(collect(published(refused.fetcher).events("run_1", { reconnect: { ...FAST, attempts: 4 } }))).rejects.toThrow(
      NodestroConnectionError,
    );
    expect(refused.seen).toHaveLength(4);
    const opening = scripted([sse(["event: status\ndata: {}\n\n"], "fail")]);
    await expect(collect(published(opening.fetcher).events("run_1", { reconnect: FAST }))).rejects.toThrow("terminated");
    expect(opening.seen).toHaveLength(3);
  });

  it("starts the count again after every connection that brings new events", async () => {
    let step = 0;
    const progress: Answer = (init) => sse(["event: status\ndata: {}\n\n", `id: ${++step}\nevent: step\ndata: {}\n\n`], "fail")(init);
    const { fetcher, seen } = scripted([...Array<Answer>(6).fill(progress), sse(["event: end\ndata: {}\n\n"])]);
    const events = await collect(published(fetcher).events("run_1", { reconnect: { ...FAST, attempts: 2 } }));
    expect(events.filter((event) => event.event === "step")).toHaveLength(6);
    expect(seen.map((headers) => headers.get("last-event-id"))).toEqual([null, "1", "2", "3", "4", "5", "6"]);
  });

  it("reconnects after 502/503 and throws other errors at once", async () => {
    const busy = scripted([() => new Response("starting", { status: 503 }), () => new Response("proxy", { status: 502 }), sse(["event: end\ndata: {}\n\n"])]);
    expect(await collect(published(busy.fetcher).events("run_1", { reconnect: FAST }))).toHaveLength(1);
    expect(busy.seen).toHaveLength(3);
    const missing = scripted([
      sse(["data: 1\n\n"], "fail"),
      () => new Response(JSON.stringify({ error: { code: "run.not_found", message: "No run" } }), { status: 404 }),
    ]);
    await expect(collect(published(missing.fetcher).events("run_1", { reconnect: { ...FAST, attempts: 5 } }))).rejects.toMatchObject({
      code: "run.not_found",
    });
    expect(missing.seen).toHaveLength(2);
  });

  it("stops at an abort during the pause before a reconnect", async () => {
    const { fetcher, seen } = scripted([sse(["event: status\ndata: {}\n\n"], "fail")]);
    const controller = new AbortController();
    const events = published(fetcher).events("run_1", { signal: controller.signal, reconnect: { attempts: 5, backoffMs: 30_000, maxBackoffMs: 30_000 } });
    expect((await events.next()).value).toMatchObject({ event: "status" });
    const waiting = events.next(); // the connection breaks; the stream pauses about 30 s
    await new Promise((resolve) => setTimeout(resolve, 50));
    const began = Date.now();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - began).toBeLessThan(1000);
    expect(seen).toHaveLength(1);
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("stops at an abort while connected and before the first connection", async () => {
    const { fetcher, seen } = scripted([sse(["data: 1\n\n"], "hold")]);
    const controller = new AbortController();
    const events = published(fetcher).events("run_1", { signal: controller.signal, reconnect: true });
    expect((await events.next()).value).toMatchObject({ data: 1 });
    const waiting = events.next();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(collect(published(fetcher).events("run_1", { signal: controller.signal, reconnect: true }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(seen).toHaveLength(1);
  });

  it("reconnects the studio streams with a new snapshot and no ids", async () => {
    for (const method of ["events", "runChatEvents"] as const) {
      const { fetcher, seen } = scripted([
        sse(['event: snapshot\ndata: {"status":"running"}\n\n', 'event: event\ndata: {"seq":1}\n\n'], "fail"),
        sse(['event: snapshot\ndata: {"status":"succeeded"}\n\nevent: end\ndata: {}\n\n']),
      ]);
      const client = new NodestroClient("http://nodestro.test", { fetch: fetcher });
      const events = await collect(client[method]("run_1", { reconnect: FAST }));
      expect(events.map((event) => event.event)).toEqual(["snapshot", "event", "snapshot", "end"]);
      expect(seen.map((headers) => headers.get("last-event-id"))).toEqual([null, null]);
    }
  });

  it("validates the reconnect option and offers its defaults", async () => {
    expect(DEFAULT_RECONNECT).toEqual({ attempts: 5, backoffMs: 1000, maxBackoffMs: 15_000 });
    const { fetcher } = scripted([sse(["event: end\ndata: {}\n\n"])]);
    await expect(collect(published(fetcher).events("run_1", { reconnect: { attempts: 0 } }))).rejects.toThrow(RangeError);
    await expect(collect(published(fetcher).events("run_1", { reconnect: 3 as unknown as boolean }))).rejects.toThrow(TypeError);
  });

  it("reconnects a real connection that breaks inside its chunked body", async () => {
    const connections: Array<string | undefined> = [];
    await serving(
      (request, response) => {
        connections.push(request.headers["last-event-id"] as string | undefined);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (connections.length === 1) {
          response.write("id: 5\nevent: node_started\ndata: {}\n\n");
          response.write("id: 6\nevent: node_fin", () => setTimeout(() => request.socket.destroy(), 20));
          return;
        }
        response.end("id: 6\nevent: node_finished\ndata: {}\n\nevent: end\ndata: {}\n\n");
      },
      async (url) => {
        const api = new PublishedWorkflow(url, "slug", { apiKey: "ndk_test" });
        const events = await collect(api.events("run_1", { reconnect: FAST }));
        expect(events.map((event) => [event.event, event.id])).toEqual([
          ["node_started", "5"],
          ["node_finished", "6"],
          ["end", "6"],
        ]);
      },
    );
    expect(connections).toEqual([undefined, "5"]);
  });
});

async function serving(handler: (request: IncomingMessage, response: ServerResponse) => void, use: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, into: Uint8Array[] = []): Promise<string> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    into.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(into));
}

describe("streamed downloads", () => {
  it("delivers a file piece by piece, reading nothing ahead", async () => {
    const state = { pulled: 0, cancels: 0 };
    const { fetcher, urls } = scripted([(init) => new Response(body(["aaaa", "bbbb", "cccc"], "end", init.signal, state))]);
    const client = new NodestroClient("http://nodestro.test", { fetch: fetcher });
    const stream = await client.streamFile("run 1", "file/1");
    expect(urls[0]).toBe("http://nodestro.test/api/runs/run%201/files/file%2F1");
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("aaaa");
    expect(state.pulled).toBe(1);
    reader.releaseLock();
    expect(await readAll(stream)).toBe("bbbbcccc");
  });

  it("ends the connection when the consumer cancels", async () => {
    const state = { pulled: 0, cancels: 0 };
    const { fetcher } = scripted([(init) => new Response(body(["x", "y"], "hold", init.signal, state))]);
    const stream = await new NodestroClient("http://nodestro.test", { fetch: fetcher }).streamFile("run_1", "file_1");
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(state.cancels).toBe(1);
  });

  it("retries before the body starts and keeps the code of errors", async () => {
    const busy = scripted([() => new Response(null, { status: 503 }), () => new Response("content")]);
    const client = new NodestroClient("http://nodestro.test", { fetch: busy.fetcher, retry: { backoffMs: 1 } });
    expect(await readAll(await client.streamFile("run_1", "file_1"))).toBe("content");
    expect(busy.seen).toHaveLength(2);
    const missing = scripted([
      () => new Response(JSON.stringify({ error: { code: "file.not_found", message: "No file with this id" } }), { status: 404 }),
    ]);
    const api = published(missing.fetcher);
    await expect(api.streamFile("run_1", "file_1")).rejects.toMatchObject({ status: 404, code: "file.not_found" });
    expect(missing.urls).toEqual(["http://nodestro.test/api/published/slug/runs/run_1/files/file_1"]);
    expect(missing.seen).toHaveLength(1);
  });

  it("errors the stream after the pieces that arrived when the body breaks off", async () => {
    const { fetcher } = scripted([(init) => new Response(body(["1234", "5678"], "fail", init.signal))]);
    const stream = await new NodestroClient("http://nodestro.test", { fetch: fetcher }).streamFile("run_1", "file_1");
    const got: Uint8Array[] = [];
    const error = await readAll(stream, got).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NodestroConnectionError);
    expect((error as Error).message).toContain("broke off after 8 bytes");
    expect(got.map((piece) => piece.byteLength)).toEqual([4, 4]);
  });

  it("errors the stream when the body stalls longer than timeoutMs", async () => {
    const { fetcher } = scripted([(init) => new Response(body(["1234"], "hold", init.signal))]);
    const stream = await new NodestroClient("http://nodestro.test", { fetch: fetcher }).streamFile("run_1", "file_1", { timeoutMs: 50 });
    await expect(readAll(stream)).rejects.toThrow(NodestroTimeoutError);
  });

  it("passes an abort on unchanged, before the answer and during the body", async () => {
    const controller = new AbortController();
    const { fetcher } = scripted([(init) => new Response(body(["1234"], "hold", init.signal))]);
    const client = new NodestroClient("http://nodestro.test", { fetch: fetcher });
    const stream = await client.streamFile("run_1", "file_1", { signal: controller.signal });
    const reader = stream.getReader();
    await reader.read();
    const waiting = reader.read();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.streamFile("run_1", "file_1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a real answer shorter than its Content-Length as a broken download", async () => {
    await serving(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "1000" });
        response.write("z".repeat(400), () => setTimeout(() => response.socket?.destroy(), 20));
      },
      async (url) => {
        const client = new NodestroClient(url, { retry: { attempts: 1 } });
        const got: Uint8Array[] = [];
        const error = await readAll(await client.streamFile("run_1", "file_1"), got).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(NodestroConnectionError);
        expect((error as Error).message).toContain("broke off after 400 bytes");
        expect(got.reduce((sum, piece) => sum + piece.byteLength, 0)).toBe(400);
      },
    );
  });
});
