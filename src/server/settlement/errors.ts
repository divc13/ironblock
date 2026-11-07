/**
 * Settlement failure codes and a safe error type.
 *
 * The HTTP layer exposes only these codes and messages to the browser; raw
 * NEAR/RPC errors and signer material never leave the server process.
 */
export type SettlementErrorCode =
  | "INVALID_REQUEST"
  | "UNKNOWN_TOKEN"
  | "INSUFFICIENT_BALANCE"
  | "RECEIVER_MISMATCH"
  | "NEAR_ACCOUNT_REQUIRED"
  | "CONFLICT"
  | "PENDING"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "UNAUTHENTICATED"
  | "UNAVAILABLE"
  | "INTERNAL";

export class SettlementError extends Error {
  readonly code: SettlementErrorCode;
  readonly status: number;
  /** Safe single-sentence message for the client. */
  readonly publicMessage: string;

  constructor(code: SettlementErrorCode, status: number, message: string, publicMessage?: string) {
    super(message);
    this.name = "SettlementError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage ?? message;
  }
}

/** Normalise any thrown value into a SettlementError with a safe message. */
export function toSettlementError(error: unknown): SettlementError {
  if (error instanceof SettlementError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new SettlementError(
    "INTERNAL",
    500,
    detail,
    "The withdrawal could not be processed. No token moved unless a transfer was confirmed.",
  );
}
