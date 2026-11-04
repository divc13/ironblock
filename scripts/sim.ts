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
const events = engine.eventsSince(0)
const openMerchants = Object.values(final.merchants).filter(merchant => merchant.open)
const closedMerchants = Object.values(final.merchants).filter(merchant => !merchant.open)

console.log(`Ironblock economy simulation — ${result.days} days (${config.scenario.id})`)
console.log(`Seed: ${config.meta.seed}`)
console.log(`Simulated ${result.steps.toLocaleString()} steps in ${wallMs} ms (${result.eventCount.toLocaleString()} events emitted)`)
console.log(`World day ${result.startDay} -> ${result.endDay}, sequence ${result.finalSequence}`)
console.log('')
console.log('Day  Trades(units)  Trade value  Merchant cash  Player cash  Bankrupt  Investments  Orders(units)  Caravan  Sinks')
for (const summary of result.summaries) {
  console.log(
    [
      String(summary.day).padStart(3),
      String(summary.trades.volume).padStart(15),
      money(summary.trades.value).padStart(12),
      money(summary.totalMerchantCash).padStart(14),
      money(summary.totalPlayerCash).padStart(12),
      String(summary.bankruptcies.length).padStart(9),
      String(summary.investments.count).padStart(12),
      String(summary.orders.units).padStart(14),
      String(summary.caravan.arrivals).padStart(8),
      money(summary.sinks.total).padStart(10),
    ].join('  '),
  )
}

console.log('')
console.log(
  `Final: ${final.stats.totalBuys + final.stats.totalSells} player units traded, ` +
    `${final.stats.botTrades} bot trades, ${final.stats.caravanArrivals} caravan arrivals.`,
)
console.log(
  `Bankruptcies: ${final.stats.bankruptcies}  Investments: ${final.stats.investments} ` +
    `(${money(final.stats.investmentAmount)})  Investment profit paid: ${money(final.stats.investmentDistributions)}.`,
)
console.log(
  `Orders: ${final.stats.ordersCreated} created, ${final.stats.ordersFulfilled} deliveries, ` +
    `${final.stats.orderUnits} units delivered for ${money(final.stats.orderPayouts)}.`,
)
console.log(
  `Caravan impact: sold ${final.stats.caravanUnitsSold} units into town for ${money(final.stats.caravanCashIn)}, ` +
    `bought ${final.stats.caravanUnitsBought} units for ${money(final.stats.caravanCashOut)}.`,
)
console.log(
  `Merchants: ${openMerchants.map(merchant => `${merchant.displayName} ${money(merchant.cash)}`).join(', ')}`,
)
if (closedMerchants.length > 0) {
  console.log(`Closed at end: ${closedMerchants.map(merchant => merchant.displayName).join(', ')}`)
}
console.log(
  `Sinks: rent ${money(final.stats.sinks.rent)}, tax ${money(final.stats.sinks.salesTax)}, repairs ${money(final.stats.sinks.repairs)}, scenario shocks ${money(final.stats.sinks.shocks)}.`,
)

const moverSummaries = result.summaries.filter(summary => summary.day > result.startDay)
const moverDays = moverSummaries.length > 0 ? moverSummaries : result.summaries
const allMovers = moverDays
  .flatMap(summary =>
    summary.topMovers.map(mover => ({ ...mover, day: summary.day })),
  )
  .sort((left, right) => {
    const difference = Math.abs(right.changePct) - Math.abs(left.changePct)
    if (difference !== 0) return difference
    return left.day - right.day
  })
  .slice(0, config.reporting.topMovers)
if (allMovers.length > 0) {
  console.log('')
  console.log('Top movers after day-one stock normalisation:')
  for (const mover of allMovers) {
    const merchant = final.merchants[mover.merchantId]?.displayName ?? mover.merchantId
    const item = config.items[mover.itemId]?.displayName ?? mover.itemId
    console.log(
      `  day ${mover.day} ${merchant} ${item}: ${money(mover.open)} -> ${money(mover.close)} (${mover.changePct.toFixed(1)}%)`,
    )
  }
}

const storyTypes = new Set([
  'system.shock',
  'merchant.bankrupt',
  'merchant.investment',
  'merchant.reopen',
  'merchant.distribution',
])
const story = events.filter(event => storyTypes.has(event.type))
if (story.length > 0) {
  console.log('')
  console.log('Cause, bankruptcy and investment feed:')
  for (const event of story) {
    console.log(`  #${event.sequence} d${Math.floor(event.time / 86400) + 1} ${event.type}: ${event.message}`)
  }
}

const orderEvents = events.filter(event => event.type === 'order.fulfilled')
if (orderEvents.length > 0) {
  const first = orderEvents[0]
  const last = orderEvents[orderEvents.length - 1]
  console.log('')
  console.log(`Order deliveries: ${orderEvents.length} events, ${final.stats.orderUnits} units.`)
  console.log(`  first #${first.sequence} d${Math.floor(first.time / 86400) + 1}: ${first.message}`)
  console.log(`  last  #${last.sequence} d${Math.floor(last.time / 86400) + 1}: ${last.message}`)
}

console.log('')
console.log('Sample events:')
for (const event of result.events.slice(-6)) {
  console.log(`  #${event.sequence} d${Math.floor(event.time / 86400) + 1} ${event.type}: ${event.message}`)
}
