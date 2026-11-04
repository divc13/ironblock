import type { EconomyConfig } from '../../shared/types'
import type { ProofPayload, ProofToken } from './types'

/**
 * Static NEP-245 testnet deployment record.
 *
 * The proof endpoint is intentionally offline: it never calls NEAR RPC and
 * never signs anything. It reports the *recorded* deployment so judges can
 * verify accounts on the explorer, and it states plainly that in-game
 * balances are off-chain claims backed by treasury inventory.
 */

export interface DeploymentRecord {
  network: 'testnet'
  contractId: string
  treasuryId: string
  /** Genesis units minted across all token types at deployment. */
  genesisSupplyUnits: number
  recordedLabel: string
}

export const DEFAULT_DEPLOYMENT: DeploymentRecord = {
  network: 'testnet',
  contractId: 'v2.ironblock-items.testnet',
  treasuryId: 'v2.ironblock-treasury.testnet',
  genesisSupplyUnits: 533_000,
  recordedLabel: 'v2.ironblock-items.testnet',
}

const EXPLORER_BASE = 'https://explorer.testnet.near.org/accounts/'

export const explorerUrlFor = (accountId: string): string => `${EXPLORER_BASE}${accountId}`

/** Contract/treasury ids can be overridden via env without code changes. */
export function resolveDeployment(env: NodeJS.ProcessEnv = process.env): DeploymentRecord {
  const contractId = env.IRONBLOCK_NEP245_CONTRACT_ID?.trim() || DEFAULT_DEPLOYMENT.contractId
  const treasuryId = env.IRONBLOCK_TREASURY_ACCOUNT_ID?.trim() || DEFAULT_DEPLOYMENT.treasuryId
  const parsedSupply = Number.parseInt(env.IRONBLOCK_GENESIS_SUPPLY ?? '', 10)
  return {
    network: 'testnet',
    contractId,
    treasuryId,
    genesisSupplyUnits:
      Number.isFinite(parsedSupply) && parsedSupply > 0
        ? parsedSupply
        : DEFAULT_DEPLOYMENT.genesisSupplyUnits,
    recordedLabel: DEFAULT_DEPLOYMENT.recordedLabel,
  }
}

export const buildProofPayload = (config: EconomyConfig, env: NodeJS.ProcessEnv = process.env): ProofPayload => {
  const deployment = resolveDeployment(env)
  const tokens: ProofToken[] = Object.values(config.items)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(item => ({
      itemId: item.id,
      tokenId: item.token.tokenId,
      symbol: item.token.symbol,
      standard: 'nep-245',
      decimals: item.token.decimals,
    }))
  return {
    network: 'testnet',
    contractId: deployment.contractId,
    treasuryId: deployment.treasuryId,
    explorerUrls: {
      contract: explorerUrlFor(deployment.contractId),
      treasury: explorerUrlFor(deployment.treasuryId),
    },
    tokenCount: tokens.length,
    tokens,
    genesisSupply: {
      units: deployment.genesisSupplyUnits,
      note: `Genesis supply minted at deployment across ${tokens.length} NEP-245 token types.`,
    },
    note:
      'In-game balances are off-chain claims backed by treasury inventory on NEAR testnet. Trading settles inside the deterministic economy engine; no chain transaction is required to play, and no real funds are custodied.',
    testnet: true,
  }
}
