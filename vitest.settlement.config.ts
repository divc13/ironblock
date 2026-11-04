import { defineConfig } from "vitest/config";

/**
 * Settlement tests: server-side only, no RPGJS/Vite plugin stack, mocked chain.
 * The real-testnet smoke test lives in `scripts/settlement-smoke.mjs` (node),
 * not here, so credentials never gate the unit suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/settlement/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
