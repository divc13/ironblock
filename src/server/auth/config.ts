import { randomBytes } from "node:crypto";
import { NEAR_AUTH_TESTNET_DEFAULTS } from "../../shared/auth/defaults";

/**
 * Server-only NEAR Auth configuration.
 *
 * SPIKE: testnet only. Never import this module from browser code.
 */
export interface ServerAuthConfig {
  /** Auth0 tenant domain, without a scheme. */
  domain: string;
  /** Auth0 issuer, with the trailing slash Auth0 uses. */
  issuer: string;
  /** Audience of the Auth0 API access token accepted for login. */
  audience: string;
  /** Auth0 JWKS endpoint. */
  jwksUri: string;
  /** NEAR RPC used for the MPC `derived_public_key` view call. */
  rpcUrl: string;
  /** NEAR Auth entry-point contract. */
  fastAuthContractId: string;
  /** MPC signer contract that owns `derived_public_key`. */
  mpcContractId: string;
  /** HMAC secret for Ironblock game-session tokens. */
  sessionSecret: string;
  /** Game-session lifetime in seconds. */
  sessionTtlSeconds: number;
}

export const SESSION_ISSUER = "ironblock-near-auth-spike";
export const SESSION_AUDIENCE = "ironblock-game";

/**
 * Resolve server auth configuration from environment variables.
 *
 * `NEAR_AUTH_SESSION_SECRET` must be at least 32 characters. When it is missing
 * a caller (the Vite config) is expected to inject an ephemeral development
 * secret before this function is used. In production we refuse to guess.
 */
export function loadServerAuthConfig(
  env: Record<string, string | undefined> = process.env,
): ServerAuthConfig {
  const domain = normalizeDomain(
    env.NEAR_AUTH_DOMAIN ?? NEAR_AUTH_TESTNET_DEFAULTS.domain,
  );
  const issuer = normalizeIssuer(env.NEAR_AUTH_ISSUER, domain);
  const audience = requireNonEmpty(
    env.NEAR_AUTH_AUDIENCE ?? NEAR_AUTH_TESTNET_DEFAULTS.audience,
    "NEAR_AUTH_AUDIENCE",
  );
  const jwksUri = requireNonEmpty(
    env.NEAR_AUTH_JWKS_URL ??
      `https://${domain}/.well-known/jwks.json`,
    "NEAR_AUTH_JWKS_URL",
  );
  const rpcUrl = requireNonEmpty(
    env.NEAR_AUTH_RPC_URL ?? NEAR_AUTH_TESTNET_DEFAULTS.rpcUrl,
    "NEAR_AUTH_RPC_URL",
  );
  const fastAuthContractId = requireNonEmpty(
    env.NEAR_AUTH_FAST_AUTH_CONTRACT_ID ??
      NEAR_AUTH_TESTNET_DEFAULTS.fastAuthContractId,
    "NEAR_AUTH_FAST_AUTH_CONTRACT_ID",
  );
  const mpcContractId = requireNonEmpty(
    env.NEAR_AUTH_MPC_CONTRACT_ID ?? NEAR_AUTH_TESTNET_DEFAULTS.mpcContractId,
    "NEAR_AUTH_MPC_CONTRACT_ID",
  );
  const secret = env.NEAR_AUTH_SESSION_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throw new Error(
      "NEAR_AUTH_SESSION_SECRET must be set to at least 32 characters",
    );
  }

  if (isMainnetDomain(domain)) {
    throw new Error(
      "This authentication spike is testnet-only; mainnet NEAR Auth is not configured",
    );
  }

  validateJwksUri(jwksUri, domain);

  const ttl = Number(env.NEAR_AUTH_SESSION_TTL_SECONDS ?? "3600");
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) {
    throw new Error("NEAR_AUTH_SESSION_TTL_SECONDS must be between 60 and 86400");
  }

  return {
    domain,
    issuer,
    audience,
    jwksUri,
    rpcUrl,
    fastAuthContractId,
    mpcContractId,
    sessionSecret: secret,
    sessionTtlSeconds: Math.floor(ttl),
  };
}

/**
 * Fail the build when the browser and server would use different Auth0/MPC
 * identities. A mismatch produces confusing "invalid audience" or key-mismatch
 * failures at login time, so catch it before bundling. The compared audience is
 * the login API audience; the NEAR Auth signing audience is client-only and is
 * requested solely for transaction signatures.
 */
export function validateClientServerAuthConsistency(
  server: ServerAuthConfig,
  env: Record<string, string | undefined>,
): void {
  const client = {
    network:
      env.VITE_NEAR_AUTH_NETWORK ?? NEAR_AUTH_TESTNET_DEFAULTS.network,
    domain: normalizeDomain(
      env.VITE_NEAR_AUTH_DOMAIN ?? NEAR_AUTH_TESTNET_DEFAULTS.domain,
    ),
    audience:
      env.VITE_NEAR_AUTH_AUDIENCE ?? NEAR_AUTH_TESTNET_DEFAULTS.audience,
    fastAuthContractId:
      env.VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID ??
      NEAR_AUTH_TESTNET_DEFAULTS.fastAuthContractId,
    mpcContractId:
      env.VITE_NEAR_AUTH_MPC_CONTRACT_ID ??
      NEAR_AUTH_TESTNET_DEFAULTS.mpcContractId,
  };

  const issues: string[] = [];
  if (client.network !== "testnet") {
    issues.push("VITE_NEAR_AUTH_NETWORK must be testnet");
  }
  if (client.domain !== server.domain) {
    issues.push(
      `VITE_NEAR_AUTH_DOMAIN=${client.domain} does not match NEAR_AUTH_DOMAIN=${server.domain}`,
    );
  }
  if (client.audience !== server.audience) {
    issues.push(
      `VITE_NEAR_AUTH_AUDIENCE=${client.audience} does not match NEAR_AUTH_AUDIENCE=${server.audience}`,
    );
  }
  if (client.fastAuthContractId !== server.fastAuthContractId) {
    issues.push(
      `VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID=${client.fastAuthContractId} does not match NEAR_AUTH_FAST_AUTH_CONTRACT_ID=${server.fastAuthContractId}`,
    );
  }
  if (client.mpcContractId !== server.mpcContractId) {
    issues.push(
      `VITE_NEAR_AUTH_MPC_CONTRACT_ID=${client.mpcContractId} does not match NEAR_AUTH_MPC_CONTRACT_ID=${server.mpcContractId}`,
    );
  }

  if (issues.length > 0) {
    throw new Error(
      `NEAR Auth client/server configuration mismatch:\n- ${issues.join("\n- ")}`,
    );
  }
}

/**
 * Create a development-only secret when no configured value exists.
 * The value lives in this process only and is never written to disk.
 */
export function createEphemeralSessionSecret(): string {
  return randomBytes(48).toString("base64url");
}

function normalizeDomain(raw: string): string {
  const value = raw.trim();
  if (!value || value.includes("://") || value.includes("/")) {
    throw new Error(
      "NEAR_AUTH_DOMAIN must be a hostname without a scheme or path",
    );
  }
  return value.toLowerCase();
}

function normalizeIssuer(
  configured: string | undefined,
  domain: string,
): string {
  const expected = `https://${domain}/`;
  if (!configured) return expected;

  const normalized = configured.endsWith("/") ? configured : `${configured}/`;
  if (normalized !== expected) {
    throw new Error(
      `NEAR_AUTH_ISSUER must match https://\${NEAR_AUTH_DOMAIN}/ (expected ${expected})`,
    );
  }
  return normalized;
}

function validateJwksUri(jwksUri: string, domain: string): void {
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new Error("NEAR_AUTH_JWKS_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.host !== domain) {
    throw new Error(
      "NEAR_AUTH_JWKS_URL must use HTTPS and the same host as NEAR_AUTH_DOMAIN",
    );
  }
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}

function isMainnetDomain(domain: string): boolean {
  const normalized = domain.toLowerCase();
  return (
    normalized === "login.auth.near.org" ||
    normalized.endsWith(".auth.near.org")
  );
}
