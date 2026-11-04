import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load local production settings without printing them. `.env` is gitignored;
// CI should inject the same values through the environment.
const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const { startProductionServer } = await import(
  "../dist/server/production.js"
).catch((error) => {
  console.error(
    '[ironblock] Could not load the production server. Run "npm run build" first.',
  );
  throw error;
});

let server;
try {
  server = await startProductionServer();
  console.log(`[ironblock] production server listening at ${server.url}`);
  console.log(
    "[ironblock] health: /health and /api/auth/health; NEAR Auth callback must use this origin on port 3000.",
  );
} catch (error) {
  console.error(
    "[ironblock] production server failed to start:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}

if (server) {
  const shutdown = async (signal) => {
    console.log(`[ironblock] shutting down (${signal})`);
    await server.close().catch((error) => {
      console.error(
        "[ironblock] shutdown failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
