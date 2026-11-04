import { defineConfig } from "vitest/config";

/**
 * Auth tests are server-side and must not boot the RPGJS/Vite plugin stack.
 * Keeping a separate config avoids loading the game build during `vitest`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/auth/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
