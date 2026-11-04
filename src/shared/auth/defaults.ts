/**
 * Public testnet defaults shared by the browser, server and build-time
 * consistency checks.
 *
 * These values are not secrets. Never add an Auth0 client secret, private key
 * or session secret here: shared modules are bundled into browser code.
 */
export const NEAR_AUTH_TESTNET_DEFAULTS = {
  network: "testnet",
  domain: "login.testnet.fast-auth.com",
  issuer: "https://login.testnet.fast-auth.com/",
  audience: "auth0.jwt.fast-auth.testnet",
  rpcUrl: "https://rpc.testnet.near.org",
  fastAuthContractId: "fast-auth.testnet",
  mpcContractId: "v1.signer-prod.testnet",
} as const;

/** Per-tab `sessionStorage` key for the server-issued game session only. */
export const NEAR_AUTH_SESSION_STORAGE_KEY = "ironblock.near-auth.session.v1";
