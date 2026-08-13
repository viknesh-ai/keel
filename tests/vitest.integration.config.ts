import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    // Each file provisions its own database, so files may run in parallel, but
    // tests inside a file share that database and must not.
    fileParallelism: true,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
