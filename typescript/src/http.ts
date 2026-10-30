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

function retryPolicy(given: Partial<RetryPolicy> | undefined): RetryPolicy {
  const policy = { ...DEFAULT_RETRY, ...given };
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

/** Calls `fetch` every `pollMs` until `done`; at most `timeoutMs` in total. */
export async function pollUntil<T extends { status?: string }>(
  fetch: () => Promise<T>,
  done: (found: T) => boolean,
  runId: string,
  options: { timeoutMs?: number; pollMs?: number },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = checkTimeout("pollMs", options.pollMs ?? 500);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError(`timeoutMs must be a number >= 0, not ${timeoutMs}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await fetch();
    if (done(found)) return found;
    const left = deadline - Date.now();
    if (left <= 0) throw new NodestroTimeoutError(`Run ${runId} is still ${found.status} after ${timeoutMs} ms`);
    await sleep(Math.min(pollMs, left));
  }
}

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
    const headers = mergeHeaders({ Accept: "application/json" }, this.headers, options.headers);
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
      if (attempt < attempts) {
        const base = Math.min(this.retry.maxBackoffMs, this.retry.backoffMs * 2 ** Math.min(attempt - 1, 64));
        await sleep(base * (0.75 + Math.random() / 2));
      }
    }
    throw last;
  }

  /** A request whose answer has no body of interest (it is read to the end). */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<void> {
    await this.send(method, path, options, async (response) => void (await response.arrayBuffer()));
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
   * `signal` stops the stream; its abort error is passed on unchanged.
   */
  async *events(path: string, options: { headers?: Record<string, string>; signal?: AbortSignal } = {}): AsyncGenerator<ServerEvent> {
    const { signal } = options;
    const failed = (error: unknown): unknown =>
      error instanceof NodestroClientError || signal?.aborted
        ? error
        : new NodestroConnectionError(`GET ${path}: ${(error as Error).message}`, { cause: error });
    let response: Response;
    try {
      response = await this.fetcher(this.url(path), {
        headers: mergeHeaders(this.headers, { Accept: "text/event-stream" }, options.headers),
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
