import { Auth0Client } from "@auth0/auth0-spa-js";
import type { AuthSessionResponse } from "../../shared/auth/types";
import { logAuth0LoginFailure, readableAuth0Error } from "./auth0-errors";
import { clientAuth0Config } from "./config";
import { saveAuthSession } from "./session";
import { isAuthSessionResponse } from "./session-cache";

export class Auth0LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Auth0LoginError";
  }
}

export interface Auth0LoginResult {
  /** Raw OIDC ID token; the server verifies its signature and audience. */
  idToken: string;
  sub: string;
  email?: string;
  name?: string;
}

let client: Auth0Client | undefined;

function getClient(): Auth0Client {
  if (!clientAuth0Config.domain || !clientAuth0Config.clientId) {
    throw new Auth0LoginError(
      "Auth0 is not configured for this build. Set VITE_AUTH0_DOMAIN and VITE_AUTH0_CLIENT_ID.",
    );
  }
  client ??= new Auth0Client({
    domain: clientAuth0Config.domain,
    clientId: clientAuth0Config.clientId,
    cacheLocation: "memory",
    useRefreshTokens: false,
    authorizationParams: {
      scope: "openid profile email",
    },
  });
  return client;
}

/**
 * Open the Auth0 popup and return the raw ID token.
 *
 * The ID token is used only for the one server exchange. It is never written to
 * sessionStorage and never used as the RPGJS WebSocket token.
 */
export async function loginWithAuth0(
  method: "google" | "email",
): Promise<Auth0LoginResult> {
  const auth0 = getClient();
  try {
    await auth0.loginWithPopup({
      authorizationParams: {
        ...(method === "google"
          ? { connection: clientAuth0Config.googleConnection }
          : {}),
        scope: "openid profile email",
      },
    });

    const claims = await auth0.getIdTokenClaims();
    if (!claims?.sub || !claims.__raw) {
      throw new Auth0LoginError("Auth0 did not return a stable user identity");
    }
    return {
      idToken: claims.__raw,
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      name: typeof claims.name === "string" ? claims.name : undefined,
    };
  } catch (error) {
    logAuth0LoginFailure(error);
    throw new Auth0LoginError(
      error instanceof Auth0LoginError
        ? error.message
        : readableAuth0Error(error),
    );
  }
}

/**
 * Exchange the verified Auth0 ID token for an Ironblock game session.
 * Login never collects a payout address; the withdrawal panel sets it later.
 */
export async function completeAuth0Login(
  login: Auth0LoginResult,
): Promise<AuthSessionResponse> {
  const response = await fetch(`${clientAuth0Config.loginApiPath}/auth0`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ idToken: login.idToken }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = (await response.json().catch(() => undefined)) as
    | AuthSessionResponse
    | { error?: { message?: string } }
    | undefined;

  if (!response.ok) {
    throw new Auth0LoginError(
      body && "error" in body && body.error?.message
        ? body.error.message
        : "The game server rejected the login",
    );
  }
  if (!isAuthSessionResponse(body) || body.authMode !== "auth0") {
    throw new Auth0LoginError("The game server returned an invalid session");
  }

  saveAuthSession(body);
  return body;
}
