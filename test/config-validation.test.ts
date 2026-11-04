import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import {
  checkEconomyConfig,
  EconomyConfigError,
  validateEconomyConfig,
} from '../src/shared/config-validation'
import type { EconomyConfig } from '../src/shared/types'

const cloneEconomy = (): EconomyConfig => structuredClone(economy)

const hasIssue = (error: unknown, pattern: RegExp): boolean => {
  assert.ok(error instanceof EconomyConfigError, 'expected EconomyConfigError')
  return error.issues.some(issue => pattern.test(`${issue.path}: ${issue.message}`))
}

test('the checked-in economy config is valid', () => {
  const config = validateEconomyConfig(economy)
  assert.equal(config.meta.name, 'Ironblock')
  assert.ok(Object.keys(config.merchants).length >= 6)
  assert.equal(checkEconomyConfig(economy).ok, true)
})

test('config validation rejects duplicate item IDs', () => {
  const invalid = cloneEconomy()
  invalid.items.iron_ore_copy = {
    ...invalid.items.iron_ore,
    id: 'iron_ore',
  }

  assert.throws(
    () => validateEconomyConfig(invalid),
    error => hasIssue(error, /duplicate item id/),
  )
})

test('config validation rejects invalid item references', () => {
  const invalid = cloneEconomy()
  invalid.merchants.ferro.buys.push('unobtainium')

  assert.throws(
    () => validateEconomyConfig(invalid),
    error => hasIssue(error, /unknown item id "unobtainium"/),
  )
})

test('config validation rejects invalid recipe references', () => {
  const invalid = cloneEconomy()
  invalid.recipes.mill_flour.outputs.unobtainium = 1

  assert.throws(
    () => validateEconomyConfig(invalid),
    error => hasIssue(error, /recipes\.mill_flour\.outputs\.unobtainium.*unknown item id/),
  )
})

test('config validation rejects duplicate stall assignments', () => {
  const invalid = cloneEconomy()
  invalid.merchants.wheatley.stallSlot = invalid.merchants.ferro.stallSlot

  assert.throws(
    () => validateEconomyConfig(invalid),
    error => hasIssue(error, /stall .* already assigned/),
  )
})

test('config validation rejects merchants starting at or below reserve', () => {
  const invalid = cloneEconomy()
  invalid.merchants.ferro.cash = invalid.merchants.ferro.reserve

  assert.throws(
    () => validateEconomyConfig(invalid),
    error => hasIssue(error, /merchant must start above its reserve/),
  )
})

test('config validation rejects unsafe fast-forward settings', () => {
  const invalid = cloneEconomy()
  invalid.fastForward.stepSeconds = 1
  invalid.fastForward.maxSteps = 100

  assert.throws(
    () => validateEconomyConfig(invalid),
    error => hasIssue(error, /above maxSteps/),
  )
})

test('config validation checks maxDays against maxSteps, not just the demo days', () => {
  const invalid = cloneEconomy()
  invalid.fastForward.maxDays = 31
  invalid.fastForward.maxSteps = 25000

  assert.throws(
    () => validateEconomyConfig(invalid),
    error =>
      hasIssue(
        error,
        /fastForward\.maxDays.*requires 89280 steps.*above maxSteps 25000/,
      ),
  )
})

test('config validation requires currency precision to cover price precision', () => {
  const invalid = cloneEconomy()
  invalid.currency.decimals = 1
  invalid.pricing.rounding.decimals = 2

  assert.throws(
    () => validateEconomyConfig(invalid),
    error =>
      hasIssue(
        error,
        /currency\.decimals.*at least pricing\.rounding\.decimals/,
      ),
  )
})

test('config validation uses the effective bankruptcy threshold', () => {
  const invalid = cloneEconomy()
  invalid.pricing.cash.bankruptcyRatio = 2
  invalid.merchants.ferro.cash = invalid.merchants.ferro.reserve * 1.5

  assert.throws(
    () => validateEconomyConfig(invalid),
    error =>
      hasIssue(
        error,
        /merchants\.ferro\.cash.*effective bankruptcy threshold 160/,
      ),
  )
})

test('config validation rejects items without a buyer', () => {
  const invalid = cloneEconomy()
  for (const merchant of Object.values(invalid.merchants)) {
    merchant.buys = merchant.buys.filter(itemId => itemId !== 'cloak')
  }

  assert.throws(
    () => validateEconomyConfig(invalid),
    error => hasIssue(error, /items\.cloak: item has no merchant buyer/),
  )
})

test('config validation checks scenario merchant and item references', () => {
  const invalid = cloneEconomy()
  invalid.scenario.shocks[0].merchantId = 'missing-stall'

  assert.throws(
    () => validateEconomyConfig(invalid),
    error =>
      hasIssue(
        error,
        /scenario\.shocks\[0\]\.merchantId.*unknown merchant id "missing-stall"/,
      ),
  )
})

test('config validation requires scheduled rescues to be funded by the scenario investor', () => {
  const invalid = cloneEconomy()
  assert.ok(invalid.scenario.investor)
  invalid.scenario.investor.cash = 50

  assert.throws(
    () => validateEconomyConfig(invalid),
    error =>
      hasIssue(
        error,
        /scenario\.investor\.cash.*cannot fund scheduled rescues/,
      ),
  )
})

test('checkEconomyConfig reports issues without throwing', () => {
  const invalid = cloneEconomy()
  invalid.personalities.balanced.stockSensitivity = -1

  const result = checkEconomyConfig(invalid)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.issues.length > 0)
    assert.ok(result.issues.some(issue => issue.path.includes('stockSensitivity')))
  }
})
