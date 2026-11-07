/** Error codes safe to expose to the browser. */
export type AuthErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "INVALID_AUDIENCE"
  | "INVALID_ISSUER"
  | "MISSING_SUBJECT"
  | "NEAR_KEY_MISMATCH"
  | "NEAR_LOOKUP_FAILED"
  | "INVALID_NEAR_ACCOUNT"
  | "ADDRESS_NOT_EDITABLE"
  | "SESSION_INVALID"
  | "RATE_LIMITED"
  | "CONFIGURATION";

/**
 * Authentication failure with a public message that never contains a JWT,
 * access token or key material.
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Convert any thrown value into a safe client-facing auth error. */
export function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  return new AuthError(
    "INVALID_TOKEN",
    401,
    "The authentication token could not be verified",
  );
}
