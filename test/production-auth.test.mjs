import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build, preview } from "vite";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configFile = join(projectRoot, "vite.config.ts");
const secret = "production-auth-smoke-secret-that-is-long-enough-1234567890";
const base = "/quest/";
const auth0Domain = "dev-y6d3ancokvaznjrh.us.auth0.com";
const auth0ClientId = "5yM76v1griNYFvF8jNz2i8YfIytTm8wF";

process.env.NEAR_AUTH_SESSION_SECRET = secret;
process.env.RPG_TYPE = "mmorpg";
process.env.AUTH_MODE = "auth0";
process.env.AUTH0_DOMAIN = auth0Domain;
process.env.AUTH0_CLIENT_ID = auth0ClientId;
process.env.AUTH0_AUDIENCE = auth0ClientId;
process.env.VITE_AUTH_MODE = "auth0";
process.env.VITE_AUTH0_DOMAIN = auth0Domain;
process.env.VITE_AUTH0_CLIENT_ID = auth0ClientId;
process.env.VITE_AUTH0_AUDIENCE = auth0ClientId;

const closePreview = (server) =>
  new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });

async function assertAuthRoutes(origin, prefix) {
  const auth0 = await fetch(`${origin}${prefix}/api/auth/auth0`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(auth0.status, 400);
  assert.notEqual(auth0.status, 404);

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
    service: "ironblock-auth",
    mode: "auth0",
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
      message: "Sign in to use the market economy",
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
    assert.match(csp, new RegExp(`https://${auth0Domain.replaceAll(".", "\\.")}`));
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
