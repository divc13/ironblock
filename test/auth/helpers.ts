import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import { KeyPair } from "near-api-js";
import {
  loadServerAuthConfig,
  type ServerAuthConfig,
} from "../../src/server/auth/config";

export interface TestAuth {
  config: ServerAuthConfig;
  jwks: JWTVerifyGetKey;
  privateKey: KeyLike;
  kid: string;
}

/**
 * Build a test Auth0-compatible verifier with a local RS256 key. No network
 * calls are made by these tests.
 */
export async function createTestAuth(
  env: Record<string, string | undefined> = {},
): Promise<TestAuth> {
  const kid = "ironblock-test-key";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  };

  const config = loadServerAuthConfig({
    NEAR_AUTH_SESSION_SECRET: "test-session-secret-that-is-long-enough-1234567890",
    NEAR_AUTH_DOMAIN: "login.testnet.fast-auth.com",
    ...env,
  });

  return {
    config,
    jwks: createLocalJWKSet({ keys: [jwk] }),
    privateKey,
    kid,
  };
}

export interface TokenOptions {
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  issuedAt?: number;
  privateKey?: KeyLike;
  kid?: string;
}

/** Sign an Auth0-shaped access token for tests. */
export async function makeAuth0Token(
  auth: TestAuth,
  claims: Record<string, unknown> = {},
  options: TokenOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: "auth0|test-subject",
    email: "tester@example.com",
    ...claims,
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: options.kid ?? auth.kid,
    })
    .setIssuer(options.issuer ?? auth.config.issuer)
    .setAudience(options.audience ?? auth.config.audience)
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(options.privateKey ?? auth.privateKey);
}

/** A syntactically valid ed25519 key for NEAR identity tests. */
export function makeEd25519PublicKey(): string {
  return KeyPair.fromRandom("ed25519").getPublicKey().toString();
}

/** The implicit account id for an ed25519 public key. */
export function implicitAccountId(publicKey: string): string {
  const [, encoded] = publicKey.split(":");
  return Buffer.from(
    KeyPair.fromString(publicKey as `${string}:${string}`)
      .getPublicKey()
      .data,
  ).toString("hex");
}
