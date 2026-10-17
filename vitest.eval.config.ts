import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/evals/**/*.eval.test.ts"],
    // One reply plus one repair attempt, each capped at 150s by the suite.
    testTimeout: 300_000,
    hookTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
  },
});
