/**
 * Ironblock townsfolk roster.
 *
 * Data only: names, archetypes, one-liners and map home placements live here.
 * Every roster entry is also a visible economy bot; the server-side activity
 * director moves its map actor, while the economy engine remains authoritative
 * for what the bot actually gathers, trades or delivers.
 */

export interface CharacterMapPlacement {
  /** Pixel position in the market-square map. */
  x: number
  y: number
}

export interface CharacterConfig {
  /** Stable economy bot id, e.g. `bot-01`. */
  id: string
  displayName: string
  /** Movie-archetype role shown next to the name. */
  archetype: string
  /** Short, in-character line for the roster panel and map conversations. */
  line: string
  /** Map home position for the visible economy-bot actor. */
  map?: CharacterMapPlacement
}

export const characters: readonly CharacterConfig[] = [
  {
    id: 'bot-01',
    displayName: 'Marlowe Vane',
    archetype: 'The Fixer',
    line: 'Finds the quiet way through loud problems.',
    map: { x: 520, y: 760 },
  },
  {
    id: 'bot-02',
    displayName: 'Calla Morn',
    archetype: 'The Smuggler',
    line: 'Cargo moves faster when nobody logs it.',
    map: { x: 232, y: 800 },
  },
  {
    id: 'bot-03',
    displayName: 'Don Ottavio',
    archetype: 'The Patron',
    line: 'Funds the right debts and remembers the wrong ones.',
    map: { x: 800, y: 1080 },
  },
  {
    id: 'bot-04',
    displayName: 'Rhea Vance',
    archetype: 'The Gunslinger',
    line: 'Talks soft, shoots straight, rides at dawn.',
    map: { x: 400, y: 760 },
  },
  {
    id: 'bot-05',
    displayName: 'Yuri Blaine',
    archetype: 'The Night Broker',
    line: 'Every favour has a price after midnight.',
    map: { x: 640, y: 816 },
  },
  {
    id: 'bot-06',
    displayName: 'Trinity Vale',
    archetype: 'The Mechanic',
    line: 'If it runs, she can make it run quieter.',
    map: { x: 760, y: 760 },
  },
  {
    id: 'bot-07',
    displayName: 'Bram Sol',
    archetype: 'The Drifter',
    line: 'Never stays long enough to be missed.',
    map: { x: 400, y: 840 },
  },
  {
    id: 'bot-08',
    displayName: 'Ines Calder',
    archetype: 'The Courier',
    line: 'If it must arrive, it arrives on time.',
    map: { x: 760, y: 880 },
  },
]

const rosterById = new Map(characters.map(character => [character.id, character]))

const rosterIndex = (index: number): number =>
  Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0

/** Canonical bot id for a zero-based roster index. */
export function botIdForIndex(index: number): string {
  return `bot-${String(rosterIndex(index) + 1).padStart(2, '0')}`
}

/** Deterministic roster entry for a zero-based bot index; wraps for larger worlds. */
export function characterForBotIndex(index: number): CharacterConfig {
  if (characters.length === 0) {
    throw new Error('Townsfolk roster is empty')
  }
  return characters[rosterIndex(index) % characters.length]
}

/** Deterministic roster lookup by stable bot id, with a numeric-id fallback. */
export function characterForBotId(botId: string): CharacterConfig | undefined {
  const direct = rosterById.get(botId)
  if (direct) return direct
  const match = /^bot-(\d+)$/.exec(botId)
  if (!match) return undefined
  return characterForBotIndex(Number(match[1]) - 1)
}

/** Characters with a visible market-square placement, in roster order. */
export function charactersWithMap(): CharacterConfig[] {
  return characters.filter(character => Boolean(character.map))
}
