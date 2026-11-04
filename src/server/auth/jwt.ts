import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { ServerAuthConfig } from "./config";
import { AuthError } from "./errors";

/**
 * Auth0 access-token claims that this spike relies on. Auth0 may include many
 * more claims; they are deliberately not forwarded to the game client.
 */
export interface Auth0Claims {
  sub: string;
  email?: string;
  exp: number;
  iat?: number;
  iss: string;
  aud: string | string[];
}

const remoteJwksCache = new Map<string, JWTVerifyGetKey>();

/** Reuse one remote JWKS resolver per URL so key rotation is handled by jose. */
export function getRemoteJwks(jwksUri: string): JWTVerifyGetKey {
  const cached = remoteJwksCache.get(jwksUri);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: 10_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  remoteJwksCache.set(jwksUri, jwks);
  return jwks;
}

/**
 * Verify an Auth0 JWT before trusting any identity information.
 *
 * Signature, issuer, audience, expiry and subject are all checked. Only RS256
 * is accepted, matching the Auth0 guard used by NEAR Auth.
 */
export async function verifyAuth0Token(
  token: string,
  config: ServerAuthConfig,
  jwks: JWTVerifyGetKey = getRemoteJwks(config.jwksUri),
): Promise<Auth0Claims> {
  if (typeof token !== "string" || token.length < 20 || token.length > 16_384) {
    throw new AuthError("INVALID_TOKEN", 401, "Missing or malformed Auth0 token");
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: 5,
      requiredClaims: ["sub", "exp", "iss", "aud"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    throw translateJoseError(error);
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.trim().length === 0 || sub.length > 512) {
    throw new AuthError(
      "MISSING_SUBJECT",
      401,
      "Auth0 token has no stable subject",
    );
  }

  return {
    sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    exp: Number(payload.exp),
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
    iss: String(payload.iss),
    aud: payload.aud as string | string[],
  };
}

function translateJoseError(error: unknown): AuthError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  if (code === "ERR_JWT_EXPIRED") {
    return new AuthError("TOKEN_EXPIRED", 401, "Auth0 token has expired");
  }
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    const claim =
      typeof error === "object" && error !== null && "claim" in error
        ? String((error as { claim: unknown }).claim)
        : "";
    if (claim === "aud") {
      return new AuthError(
        "INVALID_AUDIENCE",
        401,
        "Auth0 token audience is not the NEAR Auth signing audience",
      );
    }
    if (claim === "iss") {
      return new AuthError(
        "INVALID_ISSUER",
        401,
        "Auth0 token issuer is not the configured testnet tenant",
      );
    }
  }
  return new AuthError(
    "INVALID_TOKEN",
    401,
    "Auth0 token signature or claims are invalid",
  );
}
