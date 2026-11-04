import { randomBytes } from "node:crypto";

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
  /** Audience of the JWT the NEAR Auth guard verifies. */
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

const TESTNET_DEFAULTS = {
  domain: "login.testnet.fast-auth.com",
  audience: "auth0.jwt.fast-auth.testnet",
  rpcUrl: "https://rpc.testnet.near.org",
  fastAuthContractId: "fast-auth.testnet",
  mpcContractId: "v1.signer-prod.testnet",
} as const;

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
  const domain = env.NEAR_AUTH_DOMAIN ?? TESTNET_DEFAULTS.domain;
  const issuer = normalizeIssuer(env.NEAR_AUTH_ISSUER, domain);
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

  const ttl = Number(env.NEAR_AUTH_SESSION_TTL_SECONDS ?? "3600");
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) {
    throw new Error("NEAR_AUTH_SESSION_TTL_SECONDS must be between 60 and 86400");
  }

  return {
    domain,
    issuer,
    audience: env.NEAR_AUTH_AUDIENCE ?? TESTNET_DEFAULTS.audience,
    jwksUri:
      env.NEAR_AUTH_JWKS_URL ??
      `https://${domain}/.well-known/jwks.json`,
    rpcUrl: env.NEAR_AUTH_RPC_URL ?? TESTNET_DEFAULTS.rpcUrl,
    fastAuthContractId:
      env.NEAR_AUTH_FAST_AUTH_CONTRACT_ID ??
      TESTNET_DEFAULTS.fastAuthContractId,
    mpcContractId:
      env.NEAR_AUTH_MPC_CONTRACT_ID ?? TESTNET_DEFAULTS.mpcContractId,
    sessionSecret: secret,
    sessionTtlSeconds: Math.floor(ttl),
  };
}

/**
 * Create a development-only secret when no configured value exists.
 * The value lives in this process only and is never written to disk.
 */
export function createEphemeralSessionSecret(): string {
  return randomBytes(48).toString("base64url");
}

function normalizeIssuer(configured: string | undefined, domain: string): string {
  if (!configured) return `https://${domain}/`;
  return configured.endsWith("/") ? configured : `${configured}/`;
}

function isMainnetDomain(domain: string): boolean {
  const normalized = domain.toLowerCase();
  return (
    normalized === "login.auth.near.org" ||
    normalized.endsWith(".auth.near.org")
  );
}
