import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build, preview } from "vite";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configFile = join(projectRoot, "vite.config.ts");
const secret = "production-auth-smoke-secret-that-is-long-enough-1234567890";
const base = "/quest/";

process.env.NEAR_AUTH_SESSION_SECRET = secret;
process.env.RPG_TYPE = "mmorpg";

const closePreview = (server) =>
  new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });

async function assertAuthRoutes(origin, prefix) {
  const near = await fetch(`${origin}${prefix}/api/auth/near`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.ok(
    near.status === 400 || near.status === 401,
    `POST near must be 400/401, received ${near.status}`,
  );
  assert.notEqual(near.status, 404);

  const session = await fetch(`${origin}${prefix}/api/auth/session`);
  assert.equal(session.status, 401);
  assert.notEqual(session.status, 404);

  const health = await fetch(`${origin}${prefix}/api/auth/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "near-auth",
    network: "testnet",
  });

  const economy = await fetch(`${origin}${prefix}/api/economy/snapshot`);
  assert.equal(economy.status, 401);
  assert.notEqual(economy.status, 404);
  assert.match(
    economy.headers.get("content-type") ?? "",
    /application\/json/,
  );
  assert.deepEqual(await economy.json(), {
    error: {
      code: "UNAUTHORIZED",
      message: "Sign in with NEAR Auth to use the market economy",
    },
  });
}

test("built app exposes auth routes in preview and the production host", async () => {
  await build({
    root: projectRoot,
    configFile,
    base,
    logLevel: "warn",
  });

  const previewServer = await preview({
    root: projectRoot,
    configFile,
    base,
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
    },
  });

  try {
    const address = previewServer.httpServer.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    await assertAuthRoutes(origin, base);
  } finally {
    await closePreview(previewServer);
  }

  const { startProductionServer } = await import(
    "../dist/server/production.js"
  );
  const host = await startProductionServer({
    host: "127.0.0.1",
    port: 0,
    basePath: base,
    clientDir: join(projectRoot, "dist/client"),
  });

  try {
    const origin = new URL(host.url).origin;
    const index = await fetch(`${origin}${base}`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /\/quest\/assets\//);

    await assertAuthRoutes(origin, base);

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      service: "ironblock",
    });
    const csp = health.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'/);
    assert.match(csp, /connect-src 'self' data: blob:/);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await host.close();
  }

  // Leave dist usable for a root-path `npm start`; the subpath build above is
  // only needed for this probe.
  await build({
    root: projectRoot,
    configFile,
    base: "/",
    logLevel: "warn",
  });
});
