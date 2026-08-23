import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/**/*.live.test.ts", "cli/**/*.live.test.ts"],
    // A cold model download is minutes, not seconds.
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
