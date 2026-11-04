import assert from 'node:assert/strict'
import test from 'node:test'
import { economy } from '../src/config/economy'
import { EconomyEngine } from '../src/shared/economy'
import type {
  EconomySnapshotResponse,
  EconomyTradeResponse,
} from '../src/shared/economy/api'
import type { TradeActionData } from '../src/shared/economy'
import { HttpEconomyClient } from '../src/client/economy/http'

const playerId = 'auth0_0123456789abcdef0123456789abcdef'
const token = 'test-game-session-token-that-is-long-enough-1234567890'

function snapshotFor(engine: EconomyEngine): EconomySnapshotResponse {
  const state = engine.snapshot()
  return {
    state,
    player: state.players[playerId] ?? null,
    merchants: Object.values(state.merchants),
    events: engine.eventsSince(0).slice(-25),
    sequence: state.sequence,
    firstRetainedSequence: engine.firstRetainedSequence,
    configHash: state.configHash,
    configVersion: state.configVersion,
  }
}

test('HTTP economy client maps the authoritative snapshot and actions', async () => {
  const engine = new EconomyEngine(economy)
  const created = engine.createPlayer(playerId, 'HTTP Tester')
  assert.equal(created.success, true)
  const authorization: string[] = []
  const requested: string[] = []

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    requested.push(url.pathname + url.search)
    authorization.push(
      new Headers(init?.headers).get('authorization') ?? '',
    )

    if (url.pathname.endsWith('/snapshot')) {
      return json(snapshotFor(engine))
    }

    if (url.pathname.endsWith('/quote')) {
      const quote = engine.preview(
        playerId,
        url.searchParams.get('merchantId') ?? '',
        url.searchParams.get('itemId') ?? '',
        (url.searchParams.get('side') as 'buy' | 'sell') ?? 'buy',
        Number(url.searchParams.get('quantity') ?? '1'),
      )
      return quote ? json(quote) : json({ error: { code: 'INVALID_QUOTE' } }, 400)
    }

    if (url.pathname.endsWith('/trade')) {
      const body = JSON.parse(String(init?.body)) as {
        merchantId: string
        itemId: string
        side: 'buy' | 'sell'
        quantity: number
      }
      const result =
        body.side === 'buy'
          ? engine.buy(playerId, body.merchantId, body.itemId, body.quantity)
          : engine.sell(playerId, body.merchantId, body.itemId, body.quantity)
      if (!result.success || !result.data) {
        return json(
          { error: { code: result.error?.code ?? 'ACTION_FAILED', message: result.error?.message ?? 'rejected' } },
          400,
        )
      }
      const data = result.data as TradeActionData
      const response: EconomyTradeResponse = {
        ok: true,
        message: `Filled ${data.filled}`,
        quote: data.quote,
        fillQuantity: data.filled,
        total: data.total,
        events: result.events,
        sequence: result.sequence,
      }
      return json(response)
    }

    return json({ error: { code: 'NOT_FOUND' } }, 404)
  }) as typeof fetch

  const client = new HttpEconomyClient({
    config: economy,
    apiBase: '/api/economy',
    tokenProvider: () => token,
    fetchImpl,
  })

  let notifications = 0
  const unsubscribe = client.subscribe(() => {
    notifications += 1
  })

  const snapshot = await client.getSnapshot()
  assert.equal(snapshot.player.cash, economy.player.startingCash)
  assert.equal(snapshot.player.inventory.length, 1)
  assert.equal(snapshot.player.inventory[0]?.itemId, 'bread')
  assert.equal(snapshot.merchants.length, Object.keys(economy.merchants).length)
  assert.match(snapshot.clock, /^Day 1 · /)
  assert.equal(snapshot.orderBoardSupported, true)

  const quote = await client.getQuote('ferro', 'iron_ore', 'buy', 1)
  assert.equal(quote.merchantId, 'ferro')
  assert.ok(quote.unitPrice > 0)

  const merchant = await client.getMerchant('ferro')
  assert.ok(merchant)
  assert.ok(merchant.sells.includes('iron_ore'))
  assert.ok(merchant.buys.includes('iron_ore'))

  const trade = await client.buy({ merchantId: 'ferro', itemId: 'iron_ore', quantity: 1 })
  assert.equal(trade.ok, true)
  assert.equal(trade.fillQuantity, 1)
  assert.equal(notifications, 1)

  const after = await client.getSnapshot()
  assert.ok(after.player.cash < snapshot.player.cash)
  assert.equal(
    after.player.inventory.find((line) => line.itemId === 'iron_ore')?.quantity,
    1,
  )

  assert.ok(requested.some((path) => path.startsWith('/api/economy/quote?')))
  assert.ok(requested.some((path) => path === '/api/economy/trade'))
  assert.ok(authorization.every((header) => header === `Bearer ${token}`))

  unsubscribe()
  await client.getSnapshot()
  assert.equal(notifications, 1)
})
