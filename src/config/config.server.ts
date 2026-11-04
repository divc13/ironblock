import type { RpgValueProvider } from '@rpgjs/common'
import { validateEconomyConfig } from '../shared/config-validation'
import type { EconomyConfig } from '../shared/types'
import { economy } from './economy'

/** DI token server modules use to resolve the validated economy config. */
export const ECONOMY_CONFIG_TOKEN = 'IRONBLOCK_ECONOMY_CONFIG'

export interface ServerEconomyBootstrap {
  config: EconomyConfig
  provider: RpgValueProvider<EconomyConfig>
}

/**
 * Validates a config before it can become part of the server runtime. Importing
 * this module bootstraps the checked-in config, so invalid config fails fast
 * instead of reaching game code.
 */
export function bootstrapEconomyConfig(input: unknown): ServerEconomyBootstrap {
  const config = validateEconomyConfig(input)
  return {
    config,
    provider: {
      provide: ECONOMY_CONFIG_TOKEN,
      useValue: config,
    },
  }
}

const bootstrapped = bootstrapEconomyConfig(economy)

/** The validated config that server code must use instead of the raw data. */
export const validatedEconomy = bootstrapped.config
export const economyConfigProvider = bootstrapped.provider

export default validatedEconomy
