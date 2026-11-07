import type { AuthMode } from "../../shared/auth/types";
import {
  NEAR_AUTH_TESTNET_DEFAULTS,
  NEAR_AUTH_SESSION_STORAGE_KEY,
} from "../../shared/auth/defaults";
import { loginApiPathForBase } from "./api-path";

/**
 * Public browser authentication configuration.
 *
 * Auth0 domain/client id/audience are public by design. No client secret is
 * ever placed in a VITE_* variable.
 */
export interface ClientNearAuthConfig {
  network: "testnet";
  clientId: string;
  domain: string;
  /** Auth0 API audience for the local NEAR Auth login access token. */
  audience: string;
  /** NEAR Auth guard audience, used only for transaction signatures. */
  signingAudience: string;
  rpcUrl: string;
  fastAuthContractId: string;
  mpcContractId: string;
  loginApiPath: string;
  sessionStorageKey: string;
}

export interface ClientAuth0Config {
  domain: string;
  clientId: string;
  /** Audience accepted by the server. For ID-token login this is clientId. */
  audience: string;
  googleConnection: string;
  loginApiPath: string;
  sessionStorageKey: string;
}

export interface ClientAuthConfig {
  mode: AuthMode;
  loginApiPath: string;
  sessionStorageKey: string;
}

const SHARED_TESTNET_CLIENT_ID = "np8paqIpMWmNbzT4xAvOOapZBjsOpptl";

function testnetNetwork(): "testnet" {
  const configured =
    import.meta.env.VITE_NEAR_AUTH_NETWORK ??
    NEAR_AUTH_TESTNET_DEFAULTS.network;
  if (configured !== "testnet") {
    throw new Error(
      "This authentication spike is testnet-only; set VITE_NEAR_AUTH_NETWORK=testnet",
    );
  }
  return configured;
}

function configuredAuthMode(): AuthMode {
  const raw = import.meta.env.VITE_AUTH_MODE?.trim().toLowerCase();
  if (raw === "auth0" || raw === "near") return raw;
  if (raw) {
    throw new Error("VITE_AUTH_MODE must be either near or auth0");
  }
  return import.meta.env.VITE_AUTH0_DOMAIN ? "auth0" : "near";
}

export const clientAuthMode: AuthMode = configuredAuthMode();

export const clientAuthConfig: ClientAuthConfig = {
  mode: clientAuthMode,
  loginApiPath: loginApiPathForBase(import.meta.env.BASE_URL),
  sessionStorageKey: NEAR_AUTH_SESSION_STORAGE_KEY,
};

export const clientAuth0Config: ClientAuth0Config = {
  domain: import.meta.env.VITE_AUTH0_DOMAIN ?? "",
  clientId: import.meta.env.VITE_AUTH0_CLIENT_ID ?? "",
  audience:
    import.meta.env.VITE_AUTH0_AUDIENCE ??
    import.meta.env.VITE_AUTH0_CLIENT_ID ??
    "",
  googleConnection:
    import.meta.env.VITE_AUTH0_GOOGLE_CONNECTION ?? "google-oauth2",
  loginApiPath: clientAuthConfig.loginApiPath,
  sessionStorageKey: clientAuthConfig.sessionStorageKey,
};

export const clientNearAuthConfig: ClientNearAuthConfig = {
  network: testnetNetwork(),
  clientId:
    import.meta.env.VITE_NEAR_AUTH_CLIENT_ID || SHARED_TESTNET_CLIENT_ID,
  domain:
    import.meta.env.VITE_NEAR_AUTH_DOMAIN ?? NEAR_AUTH_TESTNET_DEFAULTS.domain,
  audience:
    import.meta.env.VITE_NEAR_AUTH_AUDIENCE ??
    NEAR_AUTH_TESTNET_DEFAULTS.audience,
  signingAudience:
    import.meta.env.VITE_NEAR_AUTH_SIGNING_AUDIENCE ??
    NEAR_AUTH_TESTNET_DEFAULTS.signingAudience,
  rpcUrl:
    import.meta.env.VITE_NEAR_RPC_URL ?? NEAR_AUTH_TESTNET_DEFAULTS.rpcUrl,
  fastAuthContractId:
    import.meta.env.VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID ??
    NEAR_AUTH_TESTNET_DEFAULTS.fastAuthContractId,
  mpcContractId:
    import.meta.env.VITE_NEAR_AUTH_MPC_CONTRACT_ID ??
    NEAR_AUTH_TESTNET_DEFAULTS.mpcContractId,
  loginApiPath: clientAuthConfig.loginApiPath,
  sessionStorageKey: clientAuthConfig.sessionStorageKey,
};
