import { economy } from '../src/config/economy'
import { validateEconomyConfig } from '../src/shared/config-validation'
import { EconomyEngine } from '../src/shared/economy'

const config = validateEconomyConfig(economy)
const engine = new EconomyEngine(config)

const join = engine.createPlayer('demo-player', 'Demo Player')
if (!join.success) {
  console.error(`Could not create demo player: ${join.error?.message}`)
  process.exit(1)
}

const started = Date.now()
const result = engine.fastForward(config.fastForward.days)
const wallMs = Date.now() - started

if (!result.success) {
  console.error(`Simulation failed: ${result.error?.message}`)
  process.exit(1)
}

const money = (value: number): string => `${config.currency.symbol}${value.toFixed(config.currency.decimals)}`
const final = engine.snapshot()
const openMerchants = Object.values(final.merchants).filter(merchant => merchant.open)
const closedMerchants = Object.values(final.merchants).filter(merchant => !merchant.open)

console.log(`Ironblock economy simulation — ${result.days} days`)
console.log(`Seed: ${config.meta.seed}`)
console.log(`Simulated ${result.steps.toLocaleString()} steps in ${wallMs} ms (${result.eventCount.toLocaleString()} events emitted)`)
console.log(`World day ${result.startDay} -> ${result.endDay}, sequence ${result.finalSequence}`)
console.log('')
console.log('Day  Trades(units)  Trade value  Merchant cash  Player cash  Bankrupt  Caravan  Sinks')
for (const summary of result.summaries) {
  console.log(
    [
      String(summary.day).padStart(3),
      String(summary.trades.volume).padStart(15),
      money(summary.trades.value).padStart(12),
      money(summary.totalMerchantCash).padStart(14),
      money(summary.totalPlayerCash).padStart(12),
      String(summary.bankruptcies.length).padStart(9),
      String(summary.caravan.arrivals).padStart(8),
      money(summary.sinks.total).padStart(10),
    ].join('  '),
  )
}

console.log('')
console.log(
  `Final: ${final.stats.totalBuys + final.stats.totalSells} player units traded, ` +
    `${final.stats.botTrades} bot trades, ${final.stats.caravanArrivals} caravan arrivals, ` +
    `${final.stats.bankruptcies} bankruptcies, ${final.stats.investments} investments, ` +
    `${final.stats.ordersFulfilled} order units delivered.`,
)
console.log(
  `Merchants: ${openMerchants.map(merchant => `${merchant.displayName} ${money(merchant.cash)}`).join(', ')}`,
)
if (closedMerchants.length > 0) {
  console.log(`Closed: ${closedMerchants.map(merchant => merchant.displayName).join(', ')}`)
}
console.log(
  `Sinks: rent ${money(final.stats.sinks.rent)}, tax ${money(final.stats.sinks.salesTax)}, repairs ${money(final.stats.sinks.repairs)}.`,
)

const interesting = result.events.filter(event =>
  [
    'system.fast-forward',
    'merchant.bankrupt',
    'merchant.investment',
    'merchant.distribution',
    'caravan.arrival',
    'order.fulfilled',
    'trade.buy',
    'trade.sell',
  ].includes(event.type),
)
console.log('')
console.log('Sample events:')
for (const event of interesting.slice(-6)) {
  console.log(`  #${event.sequence} d${Math.floor(event.time / 86400) + 1} ${event.type}: ${event.message}`)
}
