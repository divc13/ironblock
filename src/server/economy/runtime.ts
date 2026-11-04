import { validatedEconomy } from '../../config/config.server'
import type { EconomyConfig } from '../../shared/types'
import { liveEconomyAutoStartAllowed, startLiveEconomy } from './live'
import { JsonEconomyStore } from './persistence'
import { EconomyService } from './service'

let activeService: EconomyService | null = null
let startingService: Promise<EconomyService> | null = null

export interface StartEconomyOptions {
  config?: EconomyConfig
  filePath?: string
  autoSave?: boolean
}

/**
 * Boot the single authoritative economy service. Safe to call more than once:
 * the first successful start wins and later calls return the same instance.
 */
export async function startEconomyService(
  options: StartEconomyOptions = {},
): Promise<EconomyService> {
  if (activeService) return activeService

  // Two rooms can start at the same time. Share one in-flight creation so they
  // cannot open two worlds against the same save file.
  let pending = startingService
  if (!pending) {
    pending = EconomyService.create({
      config: options.config ?? validatedEconomy,
      store: new JsonEconomyStore(options.filePath),
      autoSave: options.autoSave ?? true,
    })
    startingService = pending
  }

  try {
    const service = await pending
    activeService = service
    return service
  } finally {
    if (startingService === pending) startingService = null
  }
}

/**
 * Start the authoritative service plus its process-wide live loop.
 *
 * This is the host entry point for Vite dev/preview. It returns `null` inside
 * test runners so unit tests never create background timers or write a world.
 * Production starts the service explicitly and calls `startLiveEconomy()`
 * itself, sharing the same singleton loop.
 */
export async function ensureLiveEconomy(
  options: StartEconomyOptions = {},
): Promise<EconomyService | null> {
  if (!liveEconomyAutoStartAllowed()) return null

  const service = await startEconomyService(options)
  startLiveEconomy(service)
  return service
}

export function getEconomyServiceOrNull(): EconomyService | null {
  return activeService
}

export function getEconomyService(): EconomyService {
  if (!activeService) {
    throw new Error('Economy service has not been started')
  }
  return activeService
}

/** Test/integration hook for replacing the singleton explicitly. */
export function setEconomyService(service: EconomyService | null): void {
  activeService = service
}
