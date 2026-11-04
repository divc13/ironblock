import { createHash } from "node:crypto";
import { PublicKey } from "near-api-js/lib/utils/index.js";
import type { ServerAuthConfig } from "./config";
import { AuthError } from "./errors";

/**
 * A NEAR identity that has been proven to belong to a verified Auth0 subject.
 *
 * The client-supplied account id is never trusted. The server recomputes the
 * MPC derivation path from the verified JWT subject and compares the MPC
 * `derived_public_key` result with the public key supplied by the client.
 */
export interface VerifiedNearIdentity {
  auth0Subject: string;
  auth0SubjectHash: string;
  playerId: string;
  nearPublicKey: string;
  nearAccountId: string;
  displayName: string;
  derivedKeyPath: string;
}

export type DerivedPublicKeyLookup = (
  path: string,
  config: ServerAuthConfig,
) => Promise<string>;

/** MPC derivation path used by the NEAR Auth JavaScript provider. */
export function derivedKeyPathForSubject(
  config: ServerAuthConfig,
  subject: string,
): string {
  return `jwt#${config.issuer}#${subject}`;
}

/** Stable, non-reversible player id from the Auth0 subject. */
export function playerIdForSubject(subject: string): string {
  const hash = createHash("sha256").update(subject, "utf8").digest("hex");
  return `auth0_${hash.slice(0, 32)}`;
}

/** Short public hash so the client can correlate sessions without seeing `sub`. */
export function subjectHashForSubject(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 16);
}

/**
 * Ask the MPC contract for the key derived from an Auth0 subject.
 *
 * This mirrors the browser SDK's `getPublicKey()` call:
 * `derived_public_key({ path, predecessor, domain_id })` with the NEAR Auth
 * contract as predecessor and domain id 1 for ed25519.
 */
export const lookupMpcDerivedPublicKey: DerivedPublicKeyLookup = async (
  path,
  config,
) => {
  const args = {
    path,
    predecessor: config.fastAuthContractId,
    domain_id: 1,
  };

  let response: Response;
  try {
    response = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ironblock-near-auth",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: config.mpcContractId,
          method_name: "derived_public_key",
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new AuthError(
      "NEAR_LOOKUP_FAILED",
      502,
      "Could not reach the NEAR MPC contract to verify the derived key",
    );
  }

  if (!response.ok) {
    throw new AuthError(
      "NEAR_LOOKUP_FAILED",
      502,
      "The NEAR RPC rejected the derived-key lookup",
    );
  }

  const body = (await response.json()) as {
    error?: unknown;
    result?: { result?: unknown };
  };
  if (body.error || !Array.isArray(body.result?.result)) {
    throw new AuthError(
      "NEAR_LOOKUP_FAILED",
      502,
      "The NEAR RPC returned an invalid derived-key response",
    );
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(body.result.result as number[]).toString("utf8"),
    );
    if (typeof decoded !== "string") throw new Error("not a key string");
    return decoded;
  } catch {
    throw new AuthError(
      "NEAR_LOOKUP_FAILED",
      502,
      "The MPC contract returned an invalid public key",
    );
  }
};

/**
 * Verify that `clientPublicKey` is the MPC-derived ed25519 key for `subject`.
 */
export async function verifyNearIdentityForSubject(
  input: {
    subject: string;
    email?: string;
    clientPublicKey: string;
  },
  config: ServerAuthConfig,
  lookup: DerivedPublicKeyLookup = lookupMpcDerivedPublicKey,
): Promise<VerifiedNearIdentity> {
  const path = derivedKeyPathForSubject(config, input.subject);
  const expectedRaw = await lookup(path, config);
  const expected = normalizeEd25519Key(expectedRaw, "MPC-derived");
  const claimed = normalizeEd25519Key(input.clientPublicKey, "client");

  if (expected.key !== claimed.key) {
    throw new AuthError(
      "NEAR_KEY_MISMATCH",
      401,
      "The supplied NEAR public key is not derived for this Auth0 identity",
    );
  }

  const subjectHash = subjectHashForSubject(input.subject);
  return {
    auth0Subject: input.subject,
    auth0SubjectHash: subjectHash,
    playerId: playerIdForSubject(input.subject),
    nearPublicKey: expected.key,
    nearAccountId: expected.implicitAccountId,
    displayName: displayName(input.email, subjectHash),
    derivedKeyPath: path,
  };
}

function normalizeEd25519Key(
  raw: string,
  source: "client" | "MPC-derived",
): { key: string; implicitAccountId: string } {
  if (typeof raw !== "string" || raw.length > 128) {
    throw new AuthError(
      "NEAR_KEY_MISMATCH",
      401,
      `The ${source} NEAR public key is missing or malformed`,
    );
  }

  const value = raw.trim();
  if (!value.startsWith("ed25519:")) {
    throw new AuthError(
      "NEAR_KEY_MISMATCH",
      401,
      `The ${source} NEAR public key must be ed25519`,
    );
  }

  try {
    const key = PublicKey.fromString(value);
    if (key.toString().slice(0, 8) !== "ed25519:") throw new Error("key type");
    return {
      key: key.toString(),
      implicitAccountId: Buffer.from(key.data).toString("hex"),
    };
  } catch {
    throw new AuthError(
      "NEAR_KEY_MISMATCH",
      401,
      `The ${source} NEAR public key is not a valid ed25519 key`,
    );
  }
}

function displayName(email: string | undefined, subjectHash: string): string {
  const localPart = email?.split("@")[0]?.replace(/[^\w.-]/g, "").slice(0, 24);
  return localPart || `Player ${subjectHash.slice(0, 4)}`;
}
