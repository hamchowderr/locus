import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sign-in tests hash passwords on purpose (slow by design) and the billing tests write
    // hundreds of rows to a real SQLite file; under the full suite's CI load, Vitest's 5 s
    // default is too tight for them.
    testTimeout: 20_000,
  },
});
