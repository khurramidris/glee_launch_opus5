import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/evals/**/*.eval.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
  },
});
