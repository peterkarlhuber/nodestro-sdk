/** Discovery of the app API contract and version negotiation, without a server (the real one is in client.test.ts). */

import { describe, expect, it } from "vitest";
import { CONTRACT_VERSIONS, NodestroAPIError, PublishedWorkflow, discover, negotiate } from "../src/index.js";

const ANONYMOUS = {
  contract: { name: "nodestro-app", versions: [1], current: 1 },
  backend: { id: "bk_0123", name: "" },
  auth: { methods: ["api_key", "session"] },
  tls: { enabled: false },
};
const SIGNED_IN = {
  ...ANONYMOUS,
  backend: { id: "bk_0123", name: "Office", version: "0.2.0", runtime_version: "0.2.0" },
  tls: { enabled: true },
  capabilities: ["runs", "runs.sync", "events.sse", "teleport"],
  apps: [{ slug: "offer", name: "Offer", release: 3, links: { info: "/api/published/offer" } }],
};

function answering(status: number, body: unknown, seen: Request[] = [], contentType = "application/json") {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request);
    expect(new URL(request.url).pathname).toBe("/api/app");
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": contentType } });
  };
}

describe("app discovery", () => {
  it("negotiates the highest common version", () => {
    expect(CONTRACT_VERSIONS).toEqual([1]);
    expect(negotiate([1])).toBe(1);
    expect(negotiate([1, 2], [1, 2, 3])).toBe(2);
    expect(negotiate([2, 3])).toBeNull();
    expect(negotiate([])).toBeNull();
    expect(negotiate(["1", true, 1.5])).toBeNull();
  });

  it("names only the backend without a key", async () => {
    const seen: Request[] = [];
    const found = await discover("http://nodestro.test", { fetch: answering(200, ANONYMOUS, seen) });
    expect(found).toMatchObject({ compatible: true, version: 1, legacy: false, backendId: "bk_0123", tls: false });
    expect([...found.authMethods].sort()).toEqual(["api_key", "session"]);
    expect(found.capabilities.size).toBe(0);
    expect(found.apps).toEqual([]);
    expect(seen[0]!.headers.get("authorization")).toBeNull();
  });

  it("adds capabilities and apps for a key", async () => {
    const seen: Request[] = [];
    const found = await discover("http://nodestro.test", { apiKey: "ndk_x", fetch: answering(200, SIGNED_IN, seen) });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer ndk_x");
    expect(found.backendName).toBe("Office");
    expect(found.tls).toBe(true);
    expect(found.capabilities.has("runs.sync")).toBe(true);
    expect(found.capabilities.has("approvals")).toBe(false);
    expect(found.capabilities.has("teleport")).toBe(true);
    expect(found.apps.map((app) => app.slug)).toEqual(["offer"]);
  });

  it("reports no common version as incompatible, not as an error", async () => {
    const body = { ...ANONYMOUS, contract: { name: "nodestro-app", versions: [2, 3], current: 3 } };
    const found = await discover("http://nodestro.test", { fetch: answering(200, body) });
    expect(found).toMatchObject({ compatible: false, legacy: false, offered: [2, 3] });
  });

  it.each([
    [404, { detail: "Not Found" }, "application/json"],
    [405, { detail: "Method Not Allowed" }, "application/json"],
    [200, "<html>an old web interface</html>", "text/html"],
    [200, { version: "0.1.0" }, "application/json"],
    [200, { contract: { name: "other" }, backend: { id: "x" } }, "application/json"],
    [200, { contract: { name: "nodestro-app", versions: [1] }, backend: { id: "" } }, "application/json"],
  ])("treats a backend older than the contract as legacy (%s)", async (status, body, kind) => {
    const found = await discover("http://nodestro.test", { fetch: answering(status, body, [], kind) });
    expect(found).toMatchObject({ legacy: true, compatible: false, version: null });
  });

  it("rejects a wrong key", async () => {
    const refused = { error: { code: "auth.invalid", message: "Invalid key" } };
    const error = await discover("http://nodestro.test", { apiKey: "ndk_wrong", fetch: answering(401, refused) }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NodestroAPIError);
    expect((error as NodestroAPIError).code).toBe("auth.invalid");
  });

  it("refuses an invalid key value before sending", async () => {
    await expect(discover("http://nodestro.test", { apiKey: "ndk\r\nX-Evil: 1" })).rejects.toBeInstanceOf(TypeError);
  });

  it("discovers through a published workflow with its key", async () => {
    const seen: Request[] = [];
    const api = new PublishedWorkflow("http://nodestro.test", "offer", { apiKey: "ndk_y", fetch: answering(200, SIGNED_IN, seen) });
    expect((await api.discover()).capabilities.has("events.sse")).toBe(true);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer ndk_y");
  });
});
