import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "core/**/*.test.ts", "cli/**/*.test.ts"],
    // Checks that need the real embedding model are excluded here and run through
    // `npm run test:live`. AGENTS.md puts a real external model in an opt-in test so the
    // default suite stays offline, fast, and independent of a 133 MB download.
    exclude: ["**/node_modules/**", "**/dist*/**", "**/*.live.test.ts"],
  },
});
