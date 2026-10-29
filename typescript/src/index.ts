/**
 * Nodestro Client: the TypeScript SDK of the Nodestro API.
 *
 * - {@link NodestroClient}: the studio REST API of an installation.
 * - {@link PublishedWorkflow}: a published workflow API, authenticated with a Nodestro key.
 *
 * The types are generated from the API's OpenAPI document (`npm run generate`).
 */

export * from "./client.js";
export * from "./errors.js";
export { DEFAULT_RETRY, EventParser, type ClientOptions, type RequestOptions, type RetryPolicy, type ServerEvent } from "./http.js";
export * from "./published.js";
export type { components, paths } from "./generated/openapi.js";

/** The version of the Nodestro API whose OpenAPI document the types were generated from. */
export const API_VERSION = "0.2.0";
