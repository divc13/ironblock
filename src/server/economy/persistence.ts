import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  EconomyStore,
  PersistedEconomyEnvelope,
} from '../../shared/economy'

export class EconomyPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EconomyPersistenceError'
  }
}

/** Default on-disk save location. The `data/` folder is gitignored. */
export function defaultEconomySavePath(): string {
  return process.env.IRONBLOCK_ECONOMY_SAVE
    ? resolve(process.env.IRONBLOCK_ECONOMY_SAVE)
    : resolve(process.cwd(), 'data', 'economy-world.json')
}

/**
 * JSON save adapter with atomic replace.
 *
 * The service serializes writes, so all writes happen at most one at a time.
 * The temporary file lives beside the target so `rename` stays within one
 * filesystem and is atomic on POSIX hosts.
 */
export class JsonEconomyStore implements EconomyStore {
  readonly filePath: string

  constructor(filePath: string = defaultEconomySavePath()) {
    this.filePath = filePath
  }

  location(): string {
    return this.filePath
  }

  async load(): Promise<PersistedEconomyEnvelope | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new EconomyPersistenceError(
        `Could not read economy save at ${this.filePath}`,
        { cause: error },
      )
    }

    try {
      const parsed = JSON.parse(raw) as PersistedEconomyEnvelope
      if (!parsed || typeof parsed !== 'object' || !parsed.state) {
        throw new Error('save file does not contain a world state')
      }
      return parsed
    } catch (error) {
      throw new EconomyPersistenceError(
        `Economy save at ${this.filePath} is not valid JSON`,
        { cause: error },
      )
    }
  }

  async save(envelope: PersistedEconomyEnvelope): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(envelope)}\n`, 'utf8')
      await rename(temporary, this.filePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new EconomyPersistenceError(
        `Could not write economy save at ${this.filePath}`,
        { cause: error },
      )
    }
  }

  async reset(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
