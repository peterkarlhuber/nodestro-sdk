/**
 * Discovery of the Nodestro app API contract (`nodestro-app`, `GET /api/app`).
 *
 * Any backend that serves the contract (the desktop studio, its network listener, an exported project, a portable
 * package) answers `GET /api/app` with its contract versions, its id and, for a valid credential, its capabilities
 * and apps. {@link discover} reads that answer and picks the contract version to use: the highest one both sides
 * support. A backend older than the contract has no discovery; the answer then says so (`legacy`) instead of failing,
 * so a client can fall back to the published workflow API as it is.
 */

import type { Schemas } from "./client.js";
import { NodestroAPIError } from "./errors.js";
import { type ClientOptions, Transport } from "./http.js";

export type AppSummary = Schemas["AppSummary"];

/** The contract name and the versions this SDK supports, oldest first. */
export const CONTRACT = "nodestro-app";
export const CONTRACT_VERSIONS: readonly number[] = [1];
const PATH = "/api/app";

/** The answer of {@link discover}. */
export interface Discovery {
  /** The contract version to use; `null`: no common version, or `legacy`. */
  version: number | null;
  /** Whether this SDK and the backend share a contract version. */
  compatible: boolean;
  /** The backend predates the contract (no discovery route); its published workflow API may still work. */
  legacy: boolean;
  offered: number[];
  backendId: string;
  backendName: string;
  authMethods: Set<string>;
  tls: boolean;
  /** Only filled for a valid credential; unknown names are kept and simply not used. */
  capabilities: Set<string>;
  apps: AppSummary[];
  raw: Record<string, unknown>;
}

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

/** The highest contract version in both `offered` (the backend's `contract.versions`) and `supported`; else `null`. */
export function negotiate(offered: readonly unknown[], supported: readonly number[] = CONTRACT_VERSIONS): number | null {
  const common = offered.filter(isWhole).filter((v) => supported.includes(v));
  return common.length ? Math.max(...common) : null;
}

function legacy(): Discovery {
  return {
    version: null,
    compatible: false,
    legacy: true,
    offered: [],
    backendId: "",
    backendName: "",
    authMethods: new Set(),
    tls: false,
    capabilities: new Set(),
    apps: [],
    raw: {},
  };
}

/** A {@link Discovery} from the decoded JSON of `GET /api/app`; an answer that is not a discovery counts as legacy. */
export function readDiscovery(body: unknown, supported: readonly number[] = CONTRACT_VERSIONS): Discovery {
  if (!isRecord(body)) return legacy();
  const { contract, backend } = body;
  if (!isRecord(contract) || contract.name !== CONTRACT || !isRecord(backend)) return legacy();
  if (typeof backend.id !== "string" || !backend.id) return legacy();
  const offered = Array.isArray(contract.versions) ? contract.versions.filter(isWhole) : [];
  const version = negotiate(offered, supported);
  return {
    version,
    compatible: version !== null,
    legacy: false,
    offered,
    backendId: backend.id,
    backendName: typeof backend.name === "string" ? backend.name : "",
    authMethods: new Set(strings(isRecord(body.auth) ? body.auth.methods : undefined)),
    tls: isRecord(body.tls) && body.tls.enabled === true,
    capabilities: new Set(strings(body.capabilities)),
    apps: Array.isArray(body.apps) ? (body.apps.filter(isRecord) as AppSummary[]) : [],
    raw: body,
  };
}

/** {@link discover} over an existing transport (with its credential headers). */
export async function discoverWith(transport: Transport): Promise<Discovery> {
  let text: string;
  try {
    text = await transport.send("GET", PATH, {}, (response) => response.text());
  } catch (error) {
    // 404 (and 405 from a backend that routes /api/app elsewhere): a backend older than the contract.
    if (error instanceof NodestroAPIError && (error.status === 404 || error.status === 405)) return legacy();
    throw error;
  }
  try {
    return readDiscovery(JSON.parse(text));
  } catch {
    return legacy();
  }
}

/**
 * Ask the backend at `baseUrl` which contract versions, capabilities and apps it serves.
 *
 * Without `apiKey` the answer only has the contract, the backend id and name, the sign-in methods and TLS. A wrong
 * key rejects with a {@link NodestroAPIError} (401); it is never treated as no key. When `compatible` is false, show
 * "incompatible version" and do not try the routes (with `legacy`, a client may fall back to the published API).
 */
export async function discover(baseUrl: string, options: ClientOptions & { apiKey?: string } = {}): Promise<Discovery> {
  const { apiKey, ...rest } = options;
  const headers = { ...rest.headers };
  if (apiKey !== undefined) {
    if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new TypeError("apiKey must be the non-empty token of a Nodestro API key");
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return discoverWith(new Transport(baseUrl, { ...rest, headers }));
}
