/** The HTTP layer shared by both clients: timeouts, retries, errors and Server-Sent Events. */

import { NodestroAPIError, NodestroClientError, NodestroConnectionError, NodestroTimeoutError } from "./errors.js";

/** Answers worth retrying: the server is starting, overloaded or a proxy failed. */
const RETRY_STATUS = new Set([502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RetryPolicy {
  /** Tries in total, counting the first (an integer >= 1; default 3; 1 = never retry). */
  attempts: number;
  /** First pause in milliseconds, doubled for every further try and varied by ±25 % (default 500). */
  backoffMs: number;
  /** Longest pause in milliseconds (default 8000). */
  maxBackoffMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, backoffMs: 500, maxBackoffMs: 8000 };

/**
 * The policy of `reconnect: true` on event streams: up to 5 connection attempts in a row without progress, pauses
 * from 1 s up to 15 s.
 */
export const DEFAULT_RECONNECT: RetryPolicy = { attempts: 5, backoffMs: 1000, maxBackoffMs: 15_000 };

/**
 * A connection that stayed open this long (milliseconds) counts as progress, even if it delivered no new event (the
 * API sends keep-alive comments every 15 s, so a quiet run that a proxy cuts off now and then is not given up).
 */
export const STABLE_CONNECTION_MS = 60_000;

/** Options of the event streams. */
export interface EventStreamOptions {
  /** Ends the stream, also during the pause before a reconnect; its abort reason is thrown unchanged. */
  signal?: AbortSignal;
  /**
   * Connect again after a lost connection, a stream that ends before its `end` event or a 502/503/504, with growing
   * pauses (`true`: {@link DEFAULT_RECONNECT}; or your own policy). `attempts` counts the connection attempts in a
   * row that bring no progress (no event after the opening one, open less than a minute); then the last error is
   * thrown. Other errors (401, 403, 404 ...) are thrown at once. Each reconnect sends the id of the last event
   * received as `Last-Event-ID`. The stream then ends after the `end` event.
   */
  reconnect?: boolean | Partial<RetryPolicy>;
}

/** Options of the streamed downloads. */
export interface DownloadOptions {
  /** Stops the download; its abort reason is thrown (or errors the stream) unchanged. */
  signal?: AbortSignal;
  /** Longest wait for the answer and then for each piece of the body, in milliseconds (default: the client's). */
  timeoutMs?: number;
}

export interface ClientOptions {
  /** Time limit of one request in milliseconds, from sending it to the end of its body (default 30 000). */
  timeoutMs?: number;
  /** Retries of reads (and of starts with an idempotency key) after connection errors and 502/503/504. */
  retry?: Partial<RetryPolicy>;
  /** Sent with every request. */
  headers?: Record<string, string>;
  /** Replaces the global fetch (tests, proxies). */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** Retry also a request that changes something (it carries an idempotency key). */
  retryUnsafe?: boolean;
  timeoutMs?: number;
}

/** One Server-Sent Event: its name, id and decoded JSON data. */
export interface ServerEvent {
  event: string;
  data: unknown;
  id?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The base URL without a trailing slash; refuses what cannot be the address of a Nodestro API. */
export function baseUrlOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new TypeError(`The base URL must start with http:// or https:// and name a host, not ${JSON.stringify(baseUrl)}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new TypeError(`The base URL must start with http:// or https:// and name a host, not ${JSON.stringify(baseUrl)}`);
  }
  if (url.search || url.hash) throw new TypeError("The base URL cannot have a query (?) or fragment (#)");
  if (url.username || url.password) throw new TypeError("The base URL cannot contain credentials; pass them as headers");
  return url.toString().replace(/\/+$/, "");
}

/**
 * One path segment, percent-encoded (an id with `/`, `?` or `#` cannot change the path). `""`, `.`
 * and `..` are refused: URL normalization would turn them into a different endpoint, and no id or
 * slug of the API has these values.
 */
export function pathSegment(value: string | number): string {
  const text = String(value);
  if (text === "" || text === "." || text === "..") {
    throw new TypeError(`${JSON.stringify(text)} is not a valid id: ids and slugs cannot be empty, "." or ".."`);
  }
  return encodeURIComponent(text);
}

function retryPolicy(given: Partial<RetryPolicy> | undefined, defaults: RetryPolicy = DEFAULT_RETRY): RetryPolicy {
  const policy = { ...defaults, ...given };
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new RangeError(`retry.attempts must be an integer of at least 1, not ${policy.attempts}`);
  }
  for (const name of ["backoffMs", "maxBackoffMs"] as const) {
    if (!Number.isFinite(policy[name]) || policy[name] < 0) {
      throw new RangeError(`retry.${name} must be a finite number of milliseconds >= 0, not ${policy[name]}`);
    }
  }
  return policy;
}

/** Throws unless `value` can be the time limit of AbortSignal.timeout(). */
export function checkTimeout(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2 ** 31 - 1) {
    throw new RangeError(`${name} must be a positive number of milliseconds up to 2147483647, not ${value}`);
  }
  return value;
}

/** Sets every header of `sources` in order, ignoring case: a later `authorization` replaces an earlier `Authorization`. */
function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) for (const [key, value] of Object.entries(source ?? {})) headers.set(key, value);
  return headers;
}

/** Ends a body that is not read (a discarded retry or an error), so its connection is free again. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** The reconnect policy of `reconnect` (`undefined` when off). */
export function reconnectPolicy(value: boolean | Partial<RetryPolicy> | undefined): RetryPolicy | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return DEFAULT_RECONNECT;
  if (typeof value !== "object" || value === null) throw new TypeError(`reconnect must be true, false or a retry policy, not ${String(value)}`);
  return retryPolicy(value, DEFAULT_RECONNECT);
}

/** The pause before try `attempt + 1`: doubled from `backoffMs` per try, at most `maxBackoffMs`, varied by ±25 %. */
function backoff(policy: RetryPolicy, attempt: number): number {
  const base = Math.min(policy.maxBackoffMs, policy.backoffMs * 2 ** Math.min(attempt - 1, 64));
  return base * (0.75 + Math.random() / 2);
}

/** Errors after which an event stream may connect again: a lost or stalled connection, a 502/503/504. */
function reconnectable(error: unknown): boolean {
  if (error instanceof NodestroAPIError) return RETRY_STATUS.has(error.status);
  return error instanceof NodestroConnectionError || error instanceof NodestroTimeoutError;
}

/** Calls `fetch` every `pollMs` until `done`; at most `timeoutMs` in total. */
export async function pollUntil<T extends { status?: string }>(
  fetch: () => Promise<T>,
  done: (found: T) => boolean,
  runId: string,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = checkTimeout("pollMs", options.pollMs ?? 500);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError(`timeoutMs must be a number >= 0, not ${timeoutMs}`);
  const { signal } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const found = await fetch();
    signal?.throwIfAborted();
    if (done(found)) return found;
    const left = deadline - Date.now();
    if (left <= 0) throw new NodestroTimeoutError(`Run ${runId} is still ${found.status} after ${timeoutMs} ms`);
    await pause(Math.min(pollMs, left), signal);
  }
}

/** Waits `ms`; an aborted `signal` ends the wait at once with its reason. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms).then(() => undefined);
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** The version of this package (package.json; a test checks they agree). */
export const SDK_VERSION = "0.3.0";
/**
 * Sent with every request (API2-14), so the server's logs show which SDK and version called; a `User-Agent` in the
 * client's `headers` wins. (Browsers may keep their own.)
 */
export const USER_AGENT = `nodestro-sdk-ts/${SDK_VERSION}`;

/** The version of the Nodestro API whose OpenAPI document the types were generated from. */
export const API_VERSION = "0.2.0";

export class Transport {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.baseUrl = baseUrlOf(baseUrl);
    this.timeoutMs = checkTimeout("timeoutMs", options.timeoutMs ?? 30_000);
    this.retry = retryPolicy(options.retry);
    this.headers = { ...options.headers };
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") throw new TypeError("No fetch function: pass options.fetch (Node.js 20+ has one)");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * One request with retries for connection errors and 502/503/504; `read` consumes the body within
   * the same time limit, so a body that breaks off is retried like a lost connection.
   */
  async send<T>(method: string, path: string, options: RequestOptions, read: (response: Response) => Promise<T>): Promise<T> {
    const retryable = SAFE_METHODS.has(method.toUpperCase()) || options.retryUnsafe === true;
    const attempts = retryable ? this.retry.attempts : 1;
    const timeoutMs = checkTimeout("timeoutMs", options.timeoutMs ?? this.timeoutMs);
    const headers = mergeHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, this.headers, options.headers);
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
    const url = this.url(path, options.query);
    let last: Error = new NodestroConnectionError(`${method} ${path}: no answer`);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        // Redirects are not followed: a key never goes to another address, and a POST is never turned into a GET.
        const response = await this.fetcher(url, { method, headers, body, signal, redirect: "manual" });
        if (RETRY_STATUS.has(response.status) && attempt < attempts) {
          await discard(response);
          last = new NodestroAPIError(response.status, "http_error", `HTTP ${response.status}`);
        } else {
          return await read(await checked(response));
        }
      } catch (error) {
        if (error instanceof NodestroClientError) throw error;
        const name = (error as { name?: string }).name;
        last =
          name === "TimeoutError" || name === "AbortError"
            ? new NodestroTimeoutError(`${method} ${path}: no answer within the time limit`, { cause: error })
            : new NodestroConnectionError(`${method} ${path}: ${(error as Error).message}`, { cause: error });
      }
      if (attempt < attempts) await sleep(backoff(this.retry, attempt));
    }
    throw last;
  }

  /** A request whose answer has no body of interest (it is read to the end). */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<void> {
    await this.send(method, path, options, async (response) => void (await response.arrayBuffer()));
  }

  /**
   * The body of `GET path` as a stream, never held in memory as a whole. Connection errors and 502/503/504 before
   * the body starts are retried as for any read; `timeoutMs` limits the wait for the answer and then for each piece
   * of the body (not the whole download). A body that breaks off errors the stream with a
   * {@link NodestroConnectionError} (a stall: {@link NodestroTimeoutError}) after the pieces that arrived; an abort
   * of `signal` with its reason. Cancelling the stream ends the connection.
   */
  async download(path: string, options: DownloadOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const { signal } = options;
    const idleMs = checkTimeout("timeoutMs", options.timeoutMs ?? this.timeoutMs);
    const headers = mergeHeaders({ Accept: "*/*", "User-Agent": USER_AGENT }, this.headers);
    const url = this.url(path);
    let last: Error = new NodestroConnectionError(`GET ${path}: no answer`);
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      signal?.throwIfAborted();
      const watch = new Watchdog(idleMs, signal);
      try {
        const response = await this.fetcher(url, { headers, signal: watch.signal, redirect: "manual" });
        if (RETRY_STATUS.has(response.status) && attempt < this.retry.attempts) {
          await discard(response);
          watch.close();
          last = new NodestroAPIError(response.status, "http_error", `HTTP ${response.status}`);
        } else {
          await checked(response);
          return bodyStream(response, path, watch);
        }
      } catch (error) {
        watch.close();
        if (signal?.aborted) throw signal.reason;
        if (error instanceof NodestroClientError) throw error;
        last = watch.timedOut
          ? new NodestroTimeoutError(`GET ${path}: no answer within the time limit`, { cause: error })
          : new NodestroConnectionError(`GET ${path}: ${(error as Error).message}`, { cause: error });
      }
      if (attempt < this.retry.attempts) await pause(backoff(this.retry, attempt), signal);
    }
    throw last;
  }

  /** The body of the answer as bytes (held in memory as a whole). */
  async bytes(method: string, path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.send(method, path, options, async (response) => new Uint8Array(await response.arrayBuffer()));
  }

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return this.send(method, path, options, async (response) => {
      const text = response.status === 204 ? "" : await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        const kind = response.headers.get("content-type") ?? "no content type";
        throw new NodestroClientError(`${method} ${path}: the answer is not JSON (${kind}); is the base URL a Nodestro API?`, {
          cause: error,
        });
      }
    });
  }

  /**
   * Server-Sent Events of `path` until the server ends the stream (keep-alive comments skipped).
   * `signal` stops the stream; its abort error is passed on unchanged. With `reconnect` (see
   * {@link EventStreamOptions}) a lost connection is followed by a new one.
   */
  async *events(
    path: string,
    options: { headers?: Record<string, string>; lastEventId?: string } & EventStreamOptions = {},
  ): AsyncGenerator<ServerEvent> {
    const { signal } = options;
    const policy = reconnectPolicy(options.reconnect);
    let lastId = options.lastEventId;
    let failures = 0;
    for (;;) {
      signal?.throwIfAborted();
      const headers: Record<string, string> = { ...options.headers };
      if (lastId) headers["Last-Event-ID"] = lastId;
      if (!policy) {
        yield* this.connection(path, headers, signal);
        return;
      }
      const opened = Date.now();
      let delivered = 0;
      let error: unknown;
      try {
        for await (const event of this.connection(path, headers, signal)) {
          delivered++;
          if (delivered > 1) failures = 0;
          if (event.id) lastId = event.id;
          yield event;
          if (event.event === "end") return;
        }
        error = new NodestroConnectionError(`GET ${path}: the event stream ended before its end event`);
      } catch (caught) {
        if (signal?.aborted || !reconnectable(caught)) throw caught;
        error = caught;
      }
      if (Date.now() - opened >= STABLE_CONNECTION_MS) failures = 0;
      failures++;
      if (failures >= policy.attempts) throw error;
      await pause(backoff(policy, failures), signal);
    }
  }

  /** One connection of {@link events}. */
  private async *connection(path: string, extraHeaders: Record<string, string>, signal?: AbortSignal): AsyncGenerator<ServerEvent> {
    const failed = (error: unknown): unknown =>
      error instanceof NodestroClientError || signal?.aborted
        ? error
        : new NodestroConnectionError(`GET ${path}: ${(error as Error).message}`, { cause: error });
    let response: Response;
    try {
      response = await this.fetcher(this.url(path), {
        headers: mergeHeaders({ "User-Agent": USER_AGENT }, this.headers, { Accept: "text/event-stream" }, extraHeaders),
        signal,
        redirect: "manual",
      });
    } catch (error) {
      throw failed(error);
    }
    await checked(response);
    if (!response.body) return;
    const decoder = new TextDecoder();
    const parser = new EventParser();
    const reader = response.body.getReader();
    let ended = false;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          ended = true; // a failed stream has nothing left to cancel
          throw failed(error);
        }
        if (chunk.done) break;
        yield* parser.push(decoder.decode(chunk.value, { stream: true }));
      }
      ended = true;
    } finally {
      // The consumer stopped early (break, return, an exception): end the connection instead of
      // leaving it open until garbage collection.
      if (!ended) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    // An event is complete at its blank line; what is left now is an event the connection broke off
    // in the middle of, and it is dropped (WHATWG: "the incomplete event is not dispatched").
    yield* parser.push(decoder.decode());
  }
}

/**
 * The signal of one download: aborted by the caller's `signal`, or when nothing arrives for `idleMs` (`timedOut`).
 * `arm()` restarts the time limit before each wait, `rest()` stops it while the consumer holds the stream.
 */
class Watchdog {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly stop: () => void;
  timedOut = false;

  constructor(
    private readonly idleMs: number,
    private readonly outer?: AbortSignal,
  ) {
    this.stop = () => this.controller.abort(outer?.reason);
    if (outer?.aborted) this.stop();
    else outer?.addEventListener("abort", this.stop, { once: true });
    this.arm();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(): void {
    this.rest();
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort(new DOMException("The download stalled", "TimeoutError"));
    }, this.idleMs);
  }

  rest(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  close(): void {
    this.rest();
    this.outer?.removeEventListener("abort", this.stop);
  }
}

/** The body of a download, read piece by piece under the watchdog, with errors mapped to client errors. */
function bodyStream(response: Response, path: string, watch: Watchdog): ReadableStream<Uint8Array> {
  if (!response.body) {
    watch.close();
    return new ReadableStream({ start: (controller) => controller.close() });
  }
  const reader = response.body.getReader();
  let received = 0;
  watch.rest();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      watch.arm();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        watch.close();
        if (watch.signal.aborted && !watch.timedOut) controller.error(watch.signal.reason);
        else if (watch.timedOut) {
          controller.error(new NodestroTimeoutError(`GET ${path}: the download stalled after ${received} bytes`, { cause: error }));
        } else {
          controller.error(
            new NodestroConnectionError(`GET ${path}: the download broke off after ${received} bytes: ${(error as Error).message}`, {
              cause: error,
            }),
          );
        }
        return;
      }
      watch.rest();
      if (chunk.done) {
        watch.close();
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      watch.close();
      await reader.cancel(reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 }); // nothing is read before the consumer asks for it
}

async function checked(response: Response): Promise<Response> {
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await discard(response);
    const target = response.headers.get("location") ?? "";
    throw new NodestroAPIError(
      response.status,
      "http_redirect",
      `The server redirects to ${JSON.stringify(target.slice(0, 300))}; use the final address as the base URL ` +
        "(redirects are not followed, so a key is never sent elsewhere)",
    );
  }
  if (response.status < 400) return response;
  let text = "";
  try {
    text = await response.text();
  } catch {
    // the error body broke off; the status alone still tells what happened
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  throw NodestroAPIError.fromResponse(response.status, body, text);
}

/**
 * Incremental `text/event-stream` parser (WHATWG): `event:`, multi-line `data:`, `id:`, comments;
 * lines end with CRLF, LF or CR. An event is delivered at the blank line that ends it.
 */
export class EventParser {
  private buffer = "";
  private name = "message";
  private data: string[] = [];
  private id: string | undefined;

  *push(chunk: string): Generator<ServerEvent> {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0) break;
      let next = index + 1;
      if (this.buffer[index] === "\r") {
        // A CR at the end of a chunk may be the first half of CRLF: wait for the next chunk.
        if (index === this.buffer.length - 1 && chunk !== "") break;
        if (this.buffer[next] === "\n") next++;
      }
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(next);
      if (line === "") {
        if (this.data.length) {
          const text = this.data.join("\n");
          let value: unknown = text;
          try {
            value = JSON.parse(text);
          } catch {
            value = text;
          }
          yield { event: this.name, data: value, id: this.id };
        }
        this.name = "message";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.name = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id" && !value.includes("\0")) this.id = value;
    }
  }
}

/**
 * A new idempotency key: 128 random bits as 32 hex digits. `crypto.getRandomValues` exists in
 * Node.js 20+ and in every browser page; `crypto.randomUUID` only in secure contexts (HTTPS,
 * localhost), so a page served over plain HTTP in a local network could not start runs with it.
 */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
