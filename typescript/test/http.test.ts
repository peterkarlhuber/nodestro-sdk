/** The HTTP layer without a server: retries, error formats and the event parser. */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  EventParser,
  NodestroAPIError,
  NodestroClient,
  NodestroClientError,
  NodestroConnectionError,
  NodestroTimeoutError,
  PublishedWorkflow,
  newIdempotencyKey,
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

  it("delivers the complete events of a stream and drops one the connection broke off", async () => {
    const { client, state } = streaming(['event: snapshot\ndata: {"a":1}\n\n', 'event: end\nid: 2\ndata: {"status": "succ']);
    const events: ServerEvent[] = [];
    for await (const event of client.events("run_1")) events.push(event);
    // WHATWG: "If the file ends in the middle of an event, before the final empty line, the incomplete event is not dispatched."
    expect(events).toEqual([{ event: "snapshot", data: { a: 1 }, id: undefined }]);
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
    await expect(consume()).rejects.toThrow(NodestroConnectionError);
    await expect(consume()).rejects.toThrow("terminated");
    expect(events.map((event) => event.data)).toEqual([1, 1]);
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

/** A fetch that records its calls and answers with `answer`. */
function recording(answer: (url: string, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, headers: new Headers(init.headers) });
    return answer(String(input), init, calls.length);
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("ids, base URLs and options", () => {
  it("refuses ids that URL normalization would change, before sending anything", async () => {
    const { calls, fetcher } = recording(() => json(200, {}));
    const client = new NodestroClient("http://nodestro.test", { fetch: fetcher });
    const api = new PublishedWorkflow("http://nodestro.test", "slug", { apiKey: "ndk_test", fetch: fetcher });
    for (const bad of ["", ".", ".."]) {
      await expect(client.getRun(bad)).rejects.toThrow(/not a valid id/);
      await expect(client.downloadFile("run_1", bad)).rejects.toThrow(/not a valid id/);
      await expect(api.status(bad)).rejects.toThrow(/not a valid id/);
      expect(() => new PublishedWorkflow("http://nodestro.test", bad, { apiKey: "ndk_test" })).toThrow(/not a valid id/);
    }
    expect(calls).toHaveLength(0);
    await client.getRun("run.1..x");
    await client.getRun("../workflows?x=1#y");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/runs/run.1..x", "/api/runs/..%2Fworkflows%3Fx%3D1%23y"]);
  });

  it("accepts the documented base URLs and refuses others", async () => {
    const { calls, fetcher } = recording(() => json(200, { version: "0.2.0" }));
    for (const base of ["http://127.0.0.1:8000/", "https://nodestro.example.com", "http://[::1]:8060", "https://proxy.example.com/nodestro/"]) {
      await new NodestroClient(base, { fetch: fetcher }).meta();
    }
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8000/api/meta",
      "https://nodestro.example.com/api/meta",
      "http://[::1]:8060/api/meta",
      "https://proxy.example.com/nodestro/api/meta",
    ]);
    for (const bad of ["127.0.0.1:8000", "ftp://host", "http://host/?x=1", "http://host/#a", "http://user:pw@host", "nonsense"]) {
      expect(() => new NodestroClient(bad)).toThrow(/base URL/);
    }
  });

  it("validates retry and time options", () => {
    for (const retry of [{ attempts: 0 }, { attempts: -1 }, { attempts: 1.5 }, { attempts: Number.NaN }, { backoffMs: -1 }, { maxBackoffMs: Infinity }]) {
      expect(() => new NodestroClient("http://nodestro.test", { retry })).toThrow(RangeError);
    }
    for (const timeoutMs of [0, -1, Number.NaN, Infinity, 2 ** 31]) {
      expect(() => new NodestroClient("http://nodestro.test", { timeoutMs })).toThrow(RangeError);
    }
    for (const apiKey of ["", "  ", "ndk\r\nX-Evil: 1"]) {
      expect(() => new PublishedWorkflow("http://nodestro.test", "slug", { apiKey })).toThrow(/apiKey/);
    }
  });

  it("sends one attempt when attempts is 1", async () => {
    const { calls, fetcher } = recording(() => json(503, {}));
    const client = new NodestroClient("http://nodestro.test", { fetch: fetcher, retry: { attempts: 1 } });
    await expect(client.meta()).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });
});

describe("headers, redirects and answers", () => {
  it("sends the key once, whatever the case of a custom header", async () => {
    const { calls, fetcher } = recording(() => json(200, {}));
    const api = new PublishedWorkflow("http://nodestro.test", "slug", {
      apiKey: "ndk_key",
      fetch: fetcher,
      headers: { authorization: "Bearer other", "X-Trace": "1" },
    });
    await api.info();
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer ndk_key");
    expect(calls[0]!.headers.get("x-trace")).toBe("1");
  });

  it("does not follow redirects", async () => {
    const { calls, fetcher } = recording(
      () => new Response(null, { status: 307, headers: { Location: "https://elsewhere.test/x" } }),
    );
    const api = new PublishedWorkflow("http://nodestro.test", "slug", { apiKey: "ndk_secret", fetch: fetcher });
    const error = (await api.info().catch((caught: unknown) => caught)) as NodestroAPIError;
    expect([error.status, error.code]).toEqual([307, "http_redirect"]);
    expect(error.message).toContain("elsewhere.test");
    expect(error.message).not.toContain("ndk_secret");
    expect(calls.map((call) => call.init.redirect)).toEqual(["manual"]);
  });

  it("keeps the key on this origin when a real server redirects", async () => {
    const seen: Array<string | undefined> = [];
    const other = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.end("{}");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const { port: otherPort } = other.address() as AddressInfo;
    const server = createServer((_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/steal` });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const api = new PublishedWorkflow(`http://127.0.0.1:${port}`, "slug", { apiKey: "ndk_secret" });
      await expect(api.info()).rejects.toMatchObject({ code: "http_redirect", status: 302 });
      await expect(api.start({})).rejects.toMatchObject({ code: "http_redirect" });
      expect(seen).toEqual([]);
    } finally {
      server.close();
      other.close();
    }
  });

  it("reports an answer that is no JSON as a client error", async () => {
    const { fetcher } = recording(() => new Response("<html>Studio</html>", { headers: { "Content-Type": "text/html" } }));
    const error = await new NodestroClient("http://nodestro.test", { fetch: fetcher }).meta().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NodestroClientError);
    expect(error).not.toBeInstanceOf(NodestroAPIError);
    expect((error as Error).message).toMatch(/not JSON \(text\/html\)/);
  });

  it("turns malformed error bodies and proxy pages into API errors", async () => {
    const cases: Array<[unknown, string]> = [
      [{ error: { code: "auth.scope", message: "No", params: ["x"] } }, "auth.scope"],
      [{ detail: "Nope", code: "x.y", params: "text" }, "x.y"],
      [{ detail: null }, "error"],
      [{ error: "plain" }, "http_error"],
      [[1, 2], "http_error"],
    ];
    for (const [body, code] of cases) {
      const error = NodestroAPIError.fromResponse(418, body, JSON.stringify(body));
      expect([error.status, error.code, error.params]).toEqual([418, code, {}]);
    }
    const page = `<html>${"Bad Gateway ".repeat(200)}</html>`;
    const { fetcher } = recording(() => new Response(page, { status: 502 }));
    const client = new NodestroClient("http://nodestro.test", { fetch: fetcher, retry: { attempts: 1 } });
    const error = (await client.meta().catch((caught: unknown) => caught)) as NodestroAPIError;
    expect([error.status, error.code, error.detail.length]).toEqual([502, "http_error", 500]);
  });

  it("frees the body of every answer it retries", async () => {
    const bodies: ReadableStream[] = [];
    let cancelled = 0;
    const { fetcher } = recording((_url, _init, call) => {
      if (call === 3) return json(200, { version: "0.2.0" });
      const body = new ReadableStream({ cancel: () => void cancelled++ });
      bodies.push(body);
      return new Response(body, { status: 503 });
    });
    const client = new NodestroClient("http://nodestro.test", { fetch: fetcher, retry: { backoffMs: 1 } });
    expect((await client.meta()).version).toBe("0.2.0");
    expect(cancelled).toBe(2);
  });

  it("maps a body that breaks off or times out to client errors and keeps the cause", async () => {
    const broken = recording(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"version"'));
              controller.error(new TypeError("terminated"));
            },
          }),
        ),
    );
    const client = new NodestroClient("http://nodestro.test", { fetch: broken.fetcher, retry: { backoffMs: 1 } });
    const error = (await client.meta().catch((caught: unknown) => caught)) as NodestroConnectionError;
    expect(error).toBeInstanceOf(NodestroConnectionError);
    expect((error.cause as Error).message).toBe("terminated");
    expect(broken.calls).toHaveLength(3); // a read is retried
    const slow = recording(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const impatient = new NodestroClient("http://nodestro.test", { fetch: slow.fetcher, timeoutMs: 20, retry: { attempts: 1 } });
    await expect(impatient.meta()).rejects.toBeInstanceOf(NodestroTimeoutError);
  });
});

describe("published starts and waiting", () => {
  it("retries a start with the same idempotency key and extends the time limit by the wait", async () => {
    const { calls, fetcher } = recording((_url, _init, call) => {
      if (call === 1) throw new TypeError("fetch failed");
      if (call === 2) return json(504, {});
      return json(200, { run_id: "run_1", status: "running" });
    });
    const api = new PublishedWorkflow("http://nodestro.test", "slug", { apiKey: "ndk_test", fetch: fetcher, retry: { backoffMs: 1 } });
    expect((await api.start({ input: "x" }, { waitSeconds: 1, version: 2 })).run_id).toBe("run_1");
    const keys = new Set(calls.map((call) => call.headers.get("idempotency-key")));
    expect(calls).toHaveLength(3);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new URL(calls[0]!.url).pathname + new URL(calls[0]!.url).search).toBe("/api/published/slug/versions/2/runs?wait=1");
    await api.start({}, { idempotencyKey: "mine" });
    expect(calls.at(-1)!.headers.get("idempotency-key")).toBe("mine");
    await expect(api.start({}, { waitSeconds: -1 })).rejects.toThrow(RangeError);
  });

  it("makes idempotency keys from getRandomValues, without randomUUID", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const keys = new Set(Array.from({ length: 1000 }, () => newIdempotencyKey()));
      expect(keys.size).toBe(1000);
      for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  it("ends a wait at its timeout even with a long poll interval and validates both", async () => {
    const { fetcher } = recording(() => json(200, { id: "run_1", status: "running" }));
    const client = new NodestroClient("http://nodestro.test", { fetch: fetcher });
    const began = Date.now();
    await expect(client.waitForRun("run_1", { timeoutMs: 200, pollMs: 60_000 })).rejects.toThrow(/still running/);
    expect(Date.now() - began).toBeLessThan(5_000);
    for (const options of [{ pollMs: 0 }, { pollMs: Number.NaN }, { timeoutMs: -1 }, { timeoutMs: Infinity }]) {
      await expect(client.waitForRun("run_1", options)).rejects.toThrow(RangeError);
    }
  });
});

describe("event parser line endings", () => {
  it("accepts CR, LF and CRLF, also when CRLF is split across chunks", () => {
    const parser = new EventParser();
    const events = [...parser.push("data: a\r"), ...parser.push("\n\r\ndata: b\r\r"), ...parser.push("id: 5\0\ndata: c\n\n")];
    expect(events.map((event) => [event.data, event.id])).toEqual([
      ["a", undefined],
      ["b", undefined],
      ["c", undefined],
    ]);
  });

  it("sends Last-Event-ID and passes an abort before the answer on unchanged", async () => {
    const { calls, fetcher } = recording(async (_url, init) => {
      if (init.signal?.aborted) throw init.signal.reason;
      return new Response("id: 8\nevent: end\ndata: {}\n\n");
    });
    const api = new PublishedWorkflow("http://nodestro.test", "slug", { apiKey: "ndk_test", fetch: fetcher });
    const events: ServerEvent[] = [];
    for await (const event of api.events("run_1", { lastEventId: "7", text: true })) events.push(event);
    expect(events).toEqual([{ event: "end", data: {}, id: "8" }]);
    expect(calls[0]!.headers.get("last-event-id")).toBe("7");
    expect(calls[0]!.url).toBe("http://nodestro.test/api/published/slug/runs/run_1/events?text=true");
    const controller = new AbortController();
    controller.abort();
    await expect(api.events("run_1", { signal: controller.signal }).next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
