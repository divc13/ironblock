/**
 * NEAR account-id validation shared by the browser and the server.
 *
 * This only checks syntax. A player-supplied payout account is deliberately
 * not treated as a verified NEAR identity: Ironblock never asks for that
 * account's private key and never signs with it.
 */

const ACCOUNT_ID_RE = /^[a-z0-9._-]{2,64}$/;
const HEX_IMPL_RE = /^[0-9a-f]{64}$/;

/** True for the 64-hex implicit accounts used by MPC-derived identities. */
export function isImplicitAccountId(accountId: string): boolean {
  return HEX_IMPL_RE.test(accountId);
}

/** True for a syntactically valid named or implicit NEAR account id. */
export function isValidNearAccountId(accountId: string): boolean {
  if (HEX_IMPL_RE.test(accountId)) return true;
  return ACCOUNT_ID_RE.test(accountId) && !accountId.includes("..");
}
