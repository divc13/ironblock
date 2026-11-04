/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NEAR_NETWORK?: string;
  readonly VITE_NEAR_RPC_URL?: string;
  readonly VITE_NEAR_AUTH_NETWORK?: string;
  readonly VITE_NEAR_AUTH_CLIENT_ID?: string;
  readonly VITE_NEAR_AUTH_DOMAIN?: string;
  readonly VITE_NEAR_AUTH_AUDIENCE?: string;
  readonly VITE_NEAR_AUTH_SIGNING_AUDIENCE?: string;
  readonly VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID?: string;
  readonly VITE_NEAR_AUTH_MPC_CONTRACT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
