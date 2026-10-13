import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    // DB tests share one database and reset the `bot` and `indexer` schemas per file.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
