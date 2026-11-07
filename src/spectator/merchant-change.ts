/** Cash-change basis for a merchant card, kept pure for regression tests. */
export type MerchantCashBasis =
  | { mode: 'live'; start: number }
  | { mode: 'preview'; start: number | null }

export function merchantCashChange(
  cash: number,
  basis: MerchantCashBasis,
): { delta: number; label: 'today' | 'over preview' } {
  const base = basis.mode === 'preview' ? (basis.start ?? cash) : basis.start
  return {
    delta: cash - base,
    label: basis.mode === 'preview' ? 'over preview' : 'today',
  }
}
