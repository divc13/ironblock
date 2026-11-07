import { connect, type Near } from "near-api-js";
import { FastAuthClient } from "@fast-auth-near/browser-sdk";
import {
  JavascriptProvider,
  type JavascriptProviderOptions,
} from "@fast-auth-near/javascript-provider";
import type { Auth0Client } from "@auth0/auth0-spa-js";
import type { AuthSessionResponse } from "../../shared/auth/types";
import {
  logAuth0LoginFailure,
  readableAuth0Error,
} from "./auth0-errors";
import { clientNearAuthConfig } from "./config";
import { saveAuthSession } from "./session";
import { isAuthSessionResponse } from "./session-cache";
import { assertMatchingTokenSubjects } from "./token-subject";

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
      signingAudience: clientNearAuthConfig.signingAudience,
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
   *
   * Request the login API audience here, not the NEAR Auth signing audience.
   * The shared tenant returns `access_denied` ("Signing audience requested
   * without transaction payload") if the signing audience is requested without
   * a `transaction`/`delegateAction` payload.
   */
  async loginWithConnection(connection?: string): Promise<string> {
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
    return claims.sub;
  }

  /** Auth0 access token for the login API audience verified by the server. */
  async getLoginToken(): Promise<string> {
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
    }).catch((error: unknown) => {
      // A transient RPC/startup failure must not poison every later login.
      connectionPromise = undefined;
      throw error;
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
): Promise<AuthSessionResponse> {
  const auth = await getAuth();

  let idTokenSubject: string;
  try {
    idTokenSubject = await auth.provider.loginWithConnection(
      method === "google" ? "google-oauth2" : undefined,
    );
  } catch (error) {
    logAuth0LoginFailure(error);
    throw new NearAuthFlowError(readableAuth0Error(error));
  }

  let accessToken: string;
  try {
    accessToken = await auth.provider.getLoginToken();
  } catch (error) {
    logAuth0LoginFailure(error);
    throw new NearAuthFlowError(
      error instanceof NearAuthFlowError
        ? error.message
        : readableAuth0Error(error),
    );
  }

  let nearPublicKey: string;
  try {
    assertMatchingTokenSubjects(idTokenSubject, accessToken);
    const signer = await auth.client.getSigner();
    nearPublicKey = String(await signer.getPublicKey("ed25519"));
  } catch (error) {
    throw new NearAuthFlowError(
      error instanceof NearAuthFlowError
        ? error.message
        : error instanceof Error && error.message.startsWith("Auth0 returned")
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
    | AuthSessionResponse
    | { error?: { message?: string } }
    | undefined;

  if (!response.ok) {
    throw new NearAuthFlowError(
      body && "error" in body && body.error?.message
        ? body.error.message
        : "The game server rejected the login",
    );
  }

  if (!isAuthSessionResponse(body) || body.authMode !== "near") {
    throw new NearAuthFlowError("The game server returned an invalid session");
  }

  saveAuthSession(body);
  return body;
}
