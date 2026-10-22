import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first controller test in a file also pays for loading Mastra and opening its stores;
    // under the full suite's CI load that alone took 4.5 s, too close to Vitest's 5 s default.
    testTimeout: 20_000,
  },
});
