import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build, preview } from "vite";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configFile = join(projectRoot, "vite.config.ts");

process.env.NEAR_AUTH_SESSION_SECRET = "production-settlement-smoke-secret-that-is-long-enough-1234567890";
process.env.RPG_TYPE = "mmorpg";

const closePreview = (server) =>
  new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });

async function assertSettlementRoutes(origin, prefix) {
  const health = await fetch(`${origin}${prefix}/api/settlement/health`);
  assert.equal(health.status, 200);
  assert.notEqual(health.status, 404);
  const body = await health.json();
  assert.equal(body.service, "settlement");
  assert.equal(body.network, "testnet");
  assert.equal(body.contractId, "v2.ironblock-items.testnet");

  const withdraw = await fetch(`${origin}${prefix}/api/settlement/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(withdraw.status, 401);
  assert.notEqual(withdraw.status, 404);

  const list = await fetch(`${origin}${prefix}/api/settlement/withdrawals`);
  assert.equal(list.status, 401);
  assert.notEqual(list.status, 404);

  const explicitAccount = "ab".repeat(32);
  const onchain = await fetch(origin + prefix + "/api/settlement/onchain/" + explicitAccount);
  assert.equal(onchain.status, 401);

  const unknownRoute = await fetch(`${origin}${prefix}/api/settlement/unknown`);
  assert.equal(unknownRoute.status, 404);
}

test("built app exposes settlement routes in preview and the production host", async () => {
  await build({
    root: projectRoot,
    configFile,
    base: "/quest/",
    logLevel: "warn",
  });

  const previewServer = await preview({
    root: projectRoot,
    configFile,
    base: "/quest/",
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });

  try {
    const address = previewServer.httpServer.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    await assertSettlementRoutes(origin, "/quest/");
  } finally {
    await closePreview(previewServer);
  }

  const { startProductionServer } = await import("../dist/server/production.js");
  const host = await startProductionServer({
    host: "127.0.0.1",
    port: 0,
    basePath: "/quest/",
    clientDir: join(projectRoot, "dist/client"),
  });

  try {
    const origin = new URL(host.url).origin;
    await assertSettlementRoutes(origin, "/quest/");
  } finally {
    await host.close();
  }

  // Restore a root-path build for `npm start`.
  await build({
    root: projectRoot,
    configFile,
    base: "/",
    logLevel: "warn",
  });
});
