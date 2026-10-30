/** Errors of the Nodestro API, the same for both of its error formats. */

/** Base class of every error this client throws (`cause` holds the underlying error, if any). */
export class NodestroClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The server could not be reached (after the configured retries). */
export class NodestroConnectionError extends NodestroClientError {}

/** A request or a wait took longer than allowed. */
export class NodestroTimeoutError extends NodestroClientError {}

/**
 * The API answered with an error. `code` and `params` are machine-readable (e.g. `run.agents_invalid`,
 * `auth.missing`), `detail` is the technical text. The studio API answers `{detail, code, params}`,
 * published workflow APIs `{error: {...}}`; answers in neither format (a proxy's HTML page, an empty
 * body) get the code `http_error` and the start of their text. A redirect is `http_redirect`.
 */
export class NodestroAPIError extends NodestroClientError {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(`${status} ${code}: ${detail}`);
  }

  static fromResponse(status: number, body: unknown, text = ""): NodestroAPIError {
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const nested = record.error;
      if (nested && typeof nested === "object") {
        const error = nested as Record<string, unknown>;
        return new NodestroAPIError(status, String(error.code || "error"), String(error.message ?? ""), params(error.params));
      }
      if ("code" in record || "detail" in record) {
        const detail = record.detail;
        if (Array.isArray(detail)) {
          return new NodestroAPIError(status, String(record.code || "validation_error"), JSON.stringify(detail), {
            errors: detail,
          });
        }
        return new NodestroAPIError(status, String(record.code || "error"), String(detail ?? ""), params(record.params));
      }
    }
    return new NodestroAPIError(status, "http_error", text.trim().slice(0, 500) || `HTTP ${status}`);
  }
}

const params = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A run that was waited for ended as failed or cancelled. */
export class NodestroRunFailed extends NodestroClientError {
  constructor(readonly run: { status?: string; error?: unknown; id?: string; run_id?: string }) {
    super(`Run ${run.id ?? run.run_id} ${run.status}: ${JSON.stringify(run.error ?? null)}`);
  }
}
