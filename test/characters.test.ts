import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  botIdForIndex,
  characterForBotId,
  characterForBotIndex,
  characters,
  charactersWithMap,
} from '../src/config/characters'
import { economy } from '../src/config/economy'
import {
  townsfolkEventName,
  world,
} from '../src/config/world'
import { worldSpritesheetIds } from '../src/client/world-sprites'
import { buildWorldEvents } from '../src/modules/main/world'
import { EconomyEngine } from '../src/shared/economy'

test('townsfolk roster is complete, unique and aligned with the bot config', () => {
  assert.equal(characters.length, economy.bots.count)
  assert.ok(characters.length >= 8)

  const ids = new Set<string>()
  const names = new Set<string>()

  characters.forEach((character, index) => {
    assert.equal(character.id, botIdForIndex(index))
    assert.match(character.id, /^bot-\d{2}$/)
    assert.equal(ids.has(character.id), false, `duplicate character id ${character.id}`)
    assert.equal(
      names.has(character.displayName),
      false,
      `duplicate character name ${character.displayName}`,
    )
    ids.add(character.id)
    names.add(character.displayName)

    assert.ok(character.displayName.trim().length > 0)
    assert.ok(character.archetype.trim().length > 0)
    assert.ok(character.line.trim().length > 0)
    assert.doesNotMatch(character.displayName, /^bot \d+$/i)

    assert.equal(characterForBotIndex(index), character)
    assert.equal(characterForBotId(character.id), character)
    assert.equal(characterForBotId(botIdForIndex(index)), character)
  })

  // Deterministic fallbacks for legacy/custom numeric ids and unknown ids.
  assert.equal(characterForBotId('bot-3'), characters[2])
  assert.equal(characterForBotId('merchant-ferro'), undefined)
  assert.equal(characterForBotIndex(0), characterForBotIndex(0))
  assert.equal(characterForBotIndex(characters.length), characters[0])
})

test('all eight named economy bots are visible, distinct and in bounds', () => {
  const placed = charactersWithMap()
  assert.equal(placed.length, characters.length)
  assert.equal(placed.length, 8)

  const coordinates = new Set<string>()
  for (const character of placed) {
    assert.ok(character.map, `${character.displayName} has a map placement`)
    const { x, y } = character.map!
    assert.ok(x > 0 && y > 0)
    assert.ok(x < world.map.widthPx && y < world.map.heightPx)
    assert.ok(
      y >= 700,
      `${character.displayName} starts below the fixed HUD so the sprite and nameplate are visible`,
    )
    coordinates.add(`${x},${y}`)
  }
  assert.equal(coordinates.size, placed.length, 'economy bots do not share a tile')

  const events = buildWorldEvents()
  for (const character of placed) {
    const person = events.find(event => event.id === townsfolkEventName(character.id))
    assert.ok(person, `${character.displayName} has a map event`)
    assert.equal(person.x, character.map!.x)
    assert.equal(person.y, character.map!.y)
    assert.equal(person.event.name, townsfolkEventName(character.id))
    assert.equal(typeof person.event.onAction, 'function')

    assert.equal(
      events.some(event => event.id === `sign:townsfolk:${character.id}`),
      false,
      `${character.displayName} has no separate name sign`,
    )
  }

  const townsfolkSigns = events.filter(event => event.id.startsWith('sign:townsfolk:'))
  assert.equal(townsfolkSigns.length, 0, 'nameplates travel on the bot sprites')

  const spriteIds = new Set(worldSpritesheetIds())
  for (const character of placed) {
    assert.ok(spriteIds.has(`ironblock:townsfolk:${character.id}`))
    assert.equal(
      spriteIds.has(`ironblock:sign:townsfolk:${character.id}`),
      false,
      `${character.displayName} has no name-sign sprite`,
    )
  }
  assert.ok(spriteIds.has('ironblock:sign:board:orders'), 'Guild Orders sign has a sprite')
})

test('economy bots map to roster names by id and index, including restored saves', () => {
  const config = structuredClone(economy)
  const engine = new EconomyEngine(config)
  const created = engine.snapshot().bots

  assert.equal(created.length, characters.length)
  created.forEach((bot, index) => {
    assert.equal(bot.id, characters[index].id)
    assert.equal(bot.displayName, characters[index].displayName)
  })

  const state = engine.snapshot()
  const economyFingerprint = state.bots.map(bot => ({
    id: bot.id,
    cash: bot.cash,
    inventory: bot.inventory,
    stamina: bot.stamina,
    nextActionAt: bot.nextActionAt,
    trades: bot.trades,
  }))
  state.bots = state.bots.map((bot, index) => ({
    ...bot,
    displayName: `Bot ${index + 1}`,
  }))

  const restored = new EconomyEngine(config, { state }).snapshot().bots
  assert.deepEqual(
    restored.map(bot => bot.displayName),
    characters.map(character => character.displayName),
  )
  assert.deepEqual(
    restored.map(bot => ({
      id: bot.id,
      cash: bot.cash,
      inventory: bot.inventory,
      stamina: bot.stamina,
      nextActionAt: bot.nextActionAt,
      trades: bot.trades,
    })),
    economyFingerprint,
    'renaming must not change bot economy state',
  )
})

test('bot market events carry roster names, not Bot N labels', () => {
  const config = structuredClone(economy)
  config.bots.behavior.cadenceSeconds = 10
  config.bots.behavior.jitterSeconds = 0
  config.caravan.intervalSeconds = 300
  const engine = new EconomyEngine(config)
  const tick = engine.tick(900)

  assert.equal(tick.success, true)
  const botEvents = tick.events.filter(event => event.actor.type === 'bot')
  assert.ok(botEvents.length > 0, 'the tick should produce bot activity')

  for (const event of botEvents) {
    const character = characterForBotId(event.actor.id)
    assert.ok(character, `event actor ${event.actor.id} belongs to the roster`)
    assert.equal(event.actor.displayName, character.displayName)
    assert.match(event.message, new RegExp(character.displayName))
    assert.doesNotMatch(event.actor.displayName, /^bot \d+$/i)
  }
})
