/**
 * Starts a real Nodestro API server with scripted model answers (../scripts/test_server.py) for the
 * tests, or uses the one in NODESTRO_SDK_SERVER (which must itself be a running test server: the
 * tests change its data, and a real installation would call paid models). The Python that runs it
 * is NODESTRO_SDK_PYTHON (default `python3`) and needs nodestro-api installed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    server: string;
  }
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });

let child: ChildProcess | undefined;
let data: string | undefined;

export async function setup(project: TestProject) {
  const given = process.env.NODESTRO_SDK_SERVER;
  if (given) {
    const url = given.replace(/\/+$/, "");
    const marker = await fetch(`${url}/sdk-test-server`)
      .then((response) => response.json())
      .catch(() => undefined);
    if (marker?.nodestro_sdk_test_server !== true) {
      throw new Error(`NODESTRO_SDK_SERVER=${url} is not a scripts/test_server.py server; refusing to change its data`);
    }
    project.provide("server", url);
    return;
  }
  const port = await freePort();
  data = mkdtempSync(join(tmpdir(), "nodestro-sdk-ts-"));
  const script = resolve(import.meta.dirname, "../../scripts/test_server.py");
  let log = "";
  child = spawn(process.env.NODESTRO_SDK_PYTHON ?? "python3", [script, "--data-dir", join(data, "data"), "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (log += chunk));
  child.stderr?.on("data", (chunk) => (log += chunk));
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`The test server ended:\n${log}`);
    try {
      if ((await fetch(`${url}/api/meta`)).ok) {
        project.provide("server", url);
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`The test server did not start:\n${log}`);
}

export async function teardown() {
  if (child && child.exitCode === null) {
    const ended = new Promise((done) => child?.once("exit", done));
    child.kill("SIGTERM");
    const killer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    await ended;
    clearTimeout(killer);
  }
  if (data) rmSync(data, { recursive: true, force: true });
}
