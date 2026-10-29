import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/server.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
});
