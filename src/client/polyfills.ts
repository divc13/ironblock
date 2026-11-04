import { Buffer } from "buffer";

/**
 * Some near-api-js/MPC dependencies still reference Node globals in browser
 * bundles. Define them before the auth SDK is evaluated.
 */
const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

if (!globalScope.Buffer) {
  globalScope.Buffer = Buffer;
}

if (!globalScope.global) {
  globalScope.global = globalThis;
}
