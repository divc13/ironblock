import { NEAR_AUTH_TESTNET_DEFAULTS, NEAR_AUTH_SESSION_STORAGE_KEY } from "../../shared/auth/defaults";
import { loginApiPathForBase } from "./api-path";

/**
 * Public NEAR Auth testnet configuration for the browser.
 *
 * These values are public by design. The shared Auth0 client id comes from
 * https://docs.auth.near.org/resources/testnet and is for testnet only.
 */
export interface ClientNearAuthConfig {
  network: "testnet";
  clientId: string;
  domain: string;
  audience: string;
  rpcUrl: string;
  fastAuthContractId: string;
  mpcContractId: string;
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

export const clientNearAuthConfig: ClientNearAuthConfig = {
  network: testnetNetwork(),
  clientId:
    import.meta.env.VITE_NEAR_AUTH_CLIENT_ID || SHARED_TESTNET_CLIENT_ID,
  domain:
    import.meta.env.VITE_NEAR_AUTH_DOMAIN ?? NEAR_AUTH_TESTNET_DEFAULTS.domain,
  audience:
    import.meta.env.VITE_NEAR_AUTH_AUDIENCE ??
    NEAR_AUTH_TESTNET_DEFAULTS.audience,
  rpcUrl:
    import.meta.env.VITE_NEAR_RPC_URL ?? NEAR_AUTH_TESTNET_DEFAULTS.rpcUrl,
  fastAuthContractId:
    import.meta.env.VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID ??
    NEAR_AUTH_TESTNET_DEFAULTS.fastAuthContractId,
  mpcContractId:
    import.meta.env.VITE_NEAR_AUTH_MPC_CONTRACT_ID ??
    NEAR_AUTH_TESTNET_DEFAULTS.mpcContractId,
  loginApiPath: loginApiPathForBase(import.meta.env.BASE_URL),
  sessionStorageKey: NEAR_AUTH_SESSION_STORAGE_KEY,
};
