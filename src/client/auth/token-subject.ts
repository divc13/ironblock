/**
 * Read the `sub` claim from a JWT for a client-side consistency check.
 *
 * This is NOT signature verification. The server independently verifies the
 * access token before trusting its subject. This check only ensures the SDK's
 * ID-token identity and the access-token identity are the same, because the
 * MPC derivation path uses the former while the server uses the latter.
 */
export function readJwtSubject(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;

    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub.length > 0
      ? payload.sub
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fail clearly before calling the game server if Auth0 returned different
 * identities. The error deliberately contains no token material.
 */
export function assertMatchingTokenSubjects(
  idTokenSubject: string,
  accessToken: string,
): void {
  const accessTokenSubject = readJwtSubject(accessToken);
  if (!accessTokenSubject) {
    throw new Error(
      "Auth0 returned an unreadable access token; sign out and try again",
    );
  }
  if (accessTokenSubject !== idTokenSubject) {
    throw new Error(
      "Auth0 returned inconsistent identities; sign out and try again",
    );
  }
}
