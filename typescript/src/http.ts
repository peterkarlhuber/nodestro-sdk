/** The HTTP layer shared by both clients: timeouts, retries, errors and Server-Sent Events. */

import { NodestroAPIError, NodestroConnectionError, NodestroTimeoutError } from "./errors.js";

/** Answers worth retrying: the server is starting, overloaded or a proxy failed. */
const RETRY_STATUS = new Set([502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RetryPolicy {
  /** Tries in total (default 3). */
  attempts: number;
  /** First pause in milliseconds, doubled for every further try (default 500). */
  backoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, backoffMs: 500, maxBackoffMs: 8000 };

export interface ClientOptions {
  /** Time limit of one request in milliseconds (default 30 000). */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
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

export class Transport {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.headers = { ...options.headers };
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const retryable = SAFE_METHODS.has(method.toUpperCase()) || options.retryUnsafe === true;
    const attempts = retryable ? Math.max(1, this.retry.attempts) : 1;
    const headers: Record<string, string> = { Accept: "application/json", ...this.headers, ...options.headers };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let last: Error | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const signal = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
      try {
        const response = await this.fetcher(this.url(path, options.query), { method, headers, body, signal });
        if (RETRY_STATUS.has(response.status) && attempt < attempts) {
          last = undefined;
        } else {
          return await checked(response);
        }
      } catch (error) {
        if (error instanceof NodestroAPIError) throw error;
        const name = (error as { name?: string }).name;
        last =
          name === "TimeoutError" || name === "AbortError"
            ? new NodestroTimeoutError(`${method} ${path}: no answer within the time limit`)
            : new NodestroConnectionError(`${method} ${path}: ${(error as Error).message}`);
      }
      if (attempt < attempts) {
        const base = Math.min(this.retry.maxBackoffMs, this.retry.backoffMs * 2 ** (attempt - 1));
        await sleep(base * (0.75 + Math.random() / 2));
      }
    }
    throw last ?? new NodestroConnectionError(`${method} ${path}: no answer`);
  }

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(method, path, options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Server-Sent Events of `path` until the server ends the stream (keep-alive comments skipped). */
  async *events(path: string, options: { headers?: Record<string, string>; signal?: AbortSignal } = {}): AsyncGenerator<ServerEvent> {
    let response: Response;
    try {
      response = await this.fetcher(this.url(path), {
        headers: { Accept: "text/event-stream", ...this.headers, ...options.headers },
        signal: options.signal,
      });
    } catch (error) {
      throw new NodestroConnectionError(`GET ${path}: ${(error as Error).message}`);
    }
    await checked(response);
    if (!response.body) return;
    const decoder = new TextDecoder();
    const parser = new EventParser();
    const reader = response.body.getReader();
    let ended = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        yield* parser.push(decoder.decode(value, { stream: true }));
      }
      ended = true;
    } finally {
      // The consumer stopped early (break, return, an exception) or reading failed: end the connection
      // instead of leaving it open until garbage collection. A failed stream rejects cancel(); nothing to do.
      if (!ended) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    yield* parser.push(decoder.decode() + "\n\n");
  }
}

async function checked(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  throw NodestroAPIError.fromResponse(response.status, body, text);
}

/** Incremental `text/event-stream` parser (WHATWG): `event:`, multi-line `data:`, `id:`, comments. */
export class EventParser {
  private buffer = "";
  private name = "message";
  private data: string[] = [];
  private id: string | undefined;

  *push(chunk: string): Generator<ServerEvent> {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.search(/\r?\n/)) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(this.buffer[index] === "\r" ? index + 2 : index + 1);
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
      else if (field === "id") this.id = value;
    }
  }
}
