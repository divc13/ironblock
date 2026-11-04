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

export const clientNearAuthConfig: ClientNearAuthConfig = {
  network: "testnet",
  clientId:
    import.meta.env.VITE_NEAR_AUTH_CLIENT_ID || SHARED_TESTNET_CLIENT_ID,
  domain:
    import.meta.env.VITE_NEAR_AUTH_DOMAIN || "login.testnet.fast-auth.com",
  audience:
    import.meta.env.VITE_NEAR_AUTH_AUDIENCE || "auth0.jwt.fast-auth.testnet",
  rpcUrl:
    import.meta.env.VITE_NEAR_RPC_URL || "https://rpc.testnet.near.org",
  fastAuthContractId:
    import.meta.env.VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID || "fast-auth.testnet",
  mpcContractId:
    import.meta.env.VITE_NEAR_AUTH_MPC_CONTRACT_ID || "v1.signer-prod.testnet",
  loginApiPath: "/api/auth",
  sessionStorageKey: "ironblock.near-auth.session.v1",
};
