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
  /**
   * Auth0 API audience for the access token used to authenticate the game
   * session. This is deliberately not the NEAR Auth signing audience: Auth0
   * rejects signing-audience requests that do not carry a transaction payload.
   */
  audience: "https://api.testnet.fast-auth.com",
  /**
   * NEAR Auth guard audience. Only requested for transaction/delegate-action
   * signatures, where the SDK includes the encoded payload in the JWT.
   */
  signingAudience: "auth0.jwt.fast-auth.testnet",
  rpcUrl: "https://rpc.testnet.near.org",
  fastAuthContractId: "fast-auth.testnet",
  mpcContractId: "v1.signer-prod.testnet",
} as const;

/** Per-tab `sessionStorage` key for the server-issued game session only. */
export const NEAR_AUTH_SESSION_STORAGE_KEY = "ironblock.near-auth.session.v1";
