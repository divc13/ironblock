import { connect, type Near } from "near-api-js";
import { FastAuthClient } from "@fast-auth-near/browser-sdk";
import {
  JavascriptProvider,
  type JavascriptProviderOptions,
} from "@fast-auth-near/javascript-provider";
import type { Auth0Client } from "@auth0/auth0-spa-js";
import type {
  NearAuthSessionInfo,
  NearAuthSessionResponse,
} from "../../shared/auth/types";
import { clientNearAuthConfig } from "./config";

/**
 * Auth0's SPA client is private inside the official provider, but the provider
 * does not expose the access token that our backend must verify. This subclass
 * keeps one Auth0 session while adding a narrow token accessor.
 *
 * SPIKE NOTE: if the SDK adds a public token API, replace this subclass.
 */
class IronblockJavascriptProvider extends JavascriptProvider {
  constructor(
    private readonly providerOptions: JavascriptProviderOptions = {
      network: "testnet",
      clientId: clientNearAuthConfig.clientId,
      domain: clientNearAuthConfig.domain,
      signingAudience: clientNearAuthConfig.audience,
    },
  ) {
    super(providerOptions);
  }

  private get auth0(): Auth0Client {
    const client = (this as unknown as { client?: Auth0Client }).client;
    if (!client) throw new NearAuthFlowError("Auth0 client is not initialized");
    return client;
  }

  /**
   * Open Auth0's popup. `connection` is only set for the explicit Google
   * button; the email button leaves it undefined so the shared tenant decides
   * which email/password or passwordless connections it supports.
   */
  async loginWithConnection(connection?: string): Promise<void> {
    await this.auth0.loginWithPopup({
      authorizationParams: {
        ...(connection ? { connection } : {}),
        audience: clientNearAuthConfig.audience,
        scope: "openid profile email",
      },
    } as never);

    const claims = await this.auth0.getIdTokenClaims();
    if (!claims?.sub) {
      throw new NearAuthFlowError("Auth0 did not return a stable user identity");
    }
  }

  /** Auth0 access token for the NEAR Auth signing audience. */
  async getSigningToken(): Promise<string> {
    const token = await this.auth0.getTokenSilently({
      authorizationParams: {
        audience: clientNearAuthConfig.audience,
        scope: "openid profile email",
      },
    });
    if (!token) {
      throw new NearAuthFlowError("Auth0 did not return an access token");
    }
    return token;
  }
}

export class NearAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearAuthFlowError";
  }
}

let provider: IronblockJavascriptProvider | undefined;
let client: FastAuthClient<IronblockJavascriptProvider> | undefined;
let connectionPromise: Promise<Near> | undefined;

async function getAuth(): Promise<{
  provider: IronblockJavascriptProvider;
  client: FastAuthClient<IronblockJavascriptProvider>;
}> {
  if (!provider) {
    provider = new IronblockJavascriptProvider();
  }
  if (!client) {
    connectionPromise ??= connect({
      networkId: "testnet",
      nodeUrl: clientNearAuthConfig.rpcUrl,
    });
    const near = await connectionPromise;
    client = new FastAuthClient(provider, near.connection, {
      fastAuthContractId: clientNearAuthConfig.fastAuthContractId,
      mpcContractId: clientNearAuthConfig.mpcContractId,
    });
  }
  return { provider, client };
}

/**
 * Authenticate with Auth0, derive the player's MPC public key, then exchange
 * the Auth0 token for a server-verified Ironblock game session.
 *
 * The Auth0 popup is the only popup in this flow. No wallet extension is used.
 */
export async function loginWithNearAuth(
  method: "google" | "email",
): Promise<NearAuthSessionResponse> {
  const auth = await getAuth();

  try {
    await auth.provider.loginWithConnection(
      method === "google" ? "google-oauth2" : undefined,
    );
  } catch (error) {
    throw new NearAuthFlowError(readableAuth0Error(error));
  }

  let accessToken: string;
  let nearPublicKey: string;
  try {
    const signer = await auth.client.getSigner();
    nearPublicKey = String(await signer.getPublicKey("ed25519"));
    accessToken = await auth.provider.getSigningToken();
  } catch (error) {
    throw new NearAuthFlowError(
      error instanceof NearAuthFlowError
        ? error.message
        : "Signed in, but the NEAR identity could not be derived",
    );
  }

  const response = await fetch(`${clientNearAuthConfig.loginApiPath}/near`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ accessToken, nearPublicKey }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = (await response.json().catch(() => undefined)) as
    | NearAuthSessionResponse
    | { error?: { message?: string } }
    | undefined;

  if (!response.ok) {
    throw new NearAuthFlowError(
      body && "error" in body && body.error?.message
        ? body.error.message
        : "The game server rejected the login",
    );
  }

  if (!isSessionResponse(body)) {
    throw new NearAuthFlowError("The game server returned an invalid session");
  }

  saveNearAuthSession(body);
  return body;
}

/**
 * Restore a game session after reload. The Auth0 token is not persisted; only
 * the server-issued game session is stored in sessionStorage.
 */
export async function restoreNearAuthSession(): Promise<NearAuthSessionResponse | null> {
  const stored = readNearAuthSession();
  if (!stored) return null;

  try {
    const response = await fetch(
      `${clientNearAuthConfig.loginApiPath}/session`,
      {
        headers: { authorization: `Bearer ${stored.sessionToken}` },
        credentials: "same-origin",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      clearNearAuthSession();
      return null;
    }
    const info = (await response.json()) as NearAuthSessionInfo;
    if (!info?.player?.id || !info.expiresAt) {
      clearNearAuthSession();
      return null;
    }
    const restored: NearAuthSessionResponse = {
      sessionToken: stored.sessionToken,
      expiresAt: info.expiresAt,
      player: info.player,
    };
    saveNearAuthSession(restored);
    return restored;
  } catch {
    clearNearAuthSession();
    return null;
  }
}

export function saveNearAuthSession(session: NearAuthSessionResponse): void {
  try {
    window.sessionStorage.setItem(
      clientNearAuthConfig.sessionStorageKey,
      JSON.stringify(session),
    );
  } catch {
    // Storage can be unavailable in private mode; the in-memory flow still works.
  }
}

export function readNearAuthSession(): NearAuthSessionResponse | null {
  try {
    const raw = window.sessionStorage.getItem(
      clientNearAuthConfig.sessionStorageKey,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NearAuthSessionResponse;
    if (!isSessionResponse(parsed)) return null;
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearNearAuthSession(): void {
  try {
    window.sessionStorage.removeItem(clientNearAuthConfig.sessionStorageKey);
  } catch {
    // Ignore unavailable storage.
  }
}

function isSessionResponse(
  value: unknown,
): value is NearAuthSessionResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NearAuthSessionResponse>;
  return (
    typeof candidate.sessionToken === "string" &&
    candidate.sessionToken.length > 40 &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt)) &&
    typeof candidate.player?.id === "string" &&
    typeof candidate.player?.nearPublicKey === "string" &&
    typeof candidate.player?.nearAccountId === "string"
  );
}

function readableAuth0Error(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/popup|window|closed/i.test(message)) {
    return "The sign-in popup was closed or blocked. Allow popups and try again.";
  }
  if (/callback|redirect/i.test(message)) {
    return "Auth0 rejected the callback URL. Check the allowed callback URLs for this origin.";
  }
  return "Sign-in could not be completed. Please try again.";
}
