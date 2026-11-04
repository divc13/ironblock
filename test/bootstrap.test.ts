import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bootstrapEconomyConfig,
  ECONOMY_CONFIG_TOKEN,
  economyConfigProvider,
  validatedEconomy,
} from '../src/config/config.server'
import { economy } from '../src/config/economy'
import { EconomyConfigError } from '../src/shared/config-validation'
import type { EconomyConfig } from '../src/shared/types'

test('server bootstrap exposes the validated economy config through DI', () => {
  assert.equal(validatedEconomy.meta.name, 'Ironblock')
  assert.equal(economyConfigProvider.provide, ECONOMY_CONFIG_TOKEN)
  assert.equal(economyConfigProvider.useValue, validatedEconomy)
  assert.equal(validatedEconomy.fastForward.maxDays, 8)
  assert.ok(
    (validatedEconomy.fastForward.maxDays * 86400) /
      validatedEconomy.fastForward.stepSeconds <=
      validatedEconomy.fastForward.maxSteps,
  )
})

test('invalid config prevents server bootstrap', () => {
  const invalid: EconomyConfig = structuredClone(economy)
  invalid.merchants.ferro.cash = invalid.merchants.ferro.reserve

  assert.throws(
    () => bootstrapEconomyConfig(invalid),
    error => error instanceof EconomyConfigError,
  )
})
