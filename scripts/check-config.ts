import { economy } from '../src/config/economy'
import {
  EconomyConfigError,
  validateEconomyConfig,
} from '../src/shared/config-validation'

try {
  const config = validateEconomyConfig(economy)
  const merchantCount = Object.keys(config.merchants).length
  const itemCount = Object.keys(config.items).length
  const recipeCount = Object.keys(config.recipes).length
  const resourceCount = Object.keys(config.resources.nodes).length
  console.log(
    `Economy config valid: ${itemCount} items, ${merchantCount} merchants, ` +
      `${recipeCount} recipes, ${resourceCount} resources (schema v${config.meta.schemaVersion}).`,
  )
} catch (error) {
  if (error instanceof EconomyConfigError) {
    console.error(error.message)
  } else {
    console.error(error)
  }
  process.exitCode = 1
}
