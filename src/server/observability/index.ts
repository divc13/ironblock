/**
 * Ironblock observability layer — public integration surface.
 *
 * Read-only spectator API + fast-forward demo + spectator dashboard mount.
 * This module never mutates economy rules, auth, world UI or contracts.
 *
 * Typical host integration:
 *
 *   import { startObservability } from './server/observability'
 *   const observability = await startObservability()
 *   httpServer / express / viteServer.middlewares.use(observability.middleware)
 *
 * Or, inside a Vite config:
 *
 *   plugins: [ ..., observabilityApiPlugin() ]
 */

export { startMarketStream, type MarketStreamOptions } from './sse'
export { asObservabilitySource } from './source'
export {
  createObservabilityMiddleware,
  type ConnectMiddleware,
  type MiddlewareOptions,
} from './http'
export {
  createObservabilityContext,
  resolveApiPath,
  apiPathFromEnv,
  DEFAULT_API_PATH,
  DEFAULT_BODY_LIMIT,
  DEFAULT_RATE_LIMIT,
  DEFAULT_STREAM,
  SlidingWindowLimiter,
  type ObservabilityContextOptions,
} from './context'
export { handleObservabilityRequest, ROUTES } from './handlers'
export { runFastForwardClone, buildAnnotations, type FastForwardCloneOptions } from './fastforward'
export { buildRecap } from './recap'
export { buildProofPayload, resolveDeployment, explorerUrlFor, DEFAULT_DEPLOYMENT } from './proof'
export {
  sanitizeSpectatorSnapshot,
  sanitizeSummary,
  sanitizeDaily,
  publicizeEvent,
  publicizeEvents,
  buildTape,
  buildPlayerAliases,
} from './sanitize'
export {
  observabilityApiPlugin,
  DEFAULT_SPECTATOR_PATH,
  type ObservabilityPluginOptions,
} from './vite-plugin'
export type * from './types'
export type { SequencedMarketEvent } from '../../shared/economy'
export type {
  ObservabilityContext,
  ObservabilityRequest,
  ObservabilityResult,
  ObservabilitySource,
  PublicSnapshot,
  PublicTrade,
  PublicSummary,
  PublicDaily,
  PublicMerchant,
  PublicOrder,
  PublicInvestment,
  Recap,
  RecapMerchantStanding,
  ProofPayload,
  ProofToken,
  FastForwardClonePayload,
  FastForwardAnnotation,
  FastForwardTiming,
  RateLimitOptions,
} from './types'

import type { EconomyService } from '../economy/service'
import type { ObservabilitySource } from './types'
import { createObservabilityMiddleware, type ConnectMiddleware, type MiddlewareOptions } from './http'
import { createObservabilityContext } from './context'
import { observabilityApiPlugin } from './vite-plugin'
import { getEconomyServiceOrNull, startEconomyService, type StartEconomyOptions } from '../economy/runtime'
import { asObservabilitySource } from './source'

export interface StartObservabilityOptions extends Omit<MiddlewareOptions, 'getService'> {
  /** Overrides for the lazily started economy service (save path, autoSave). */
  economy?: StartEconomyOptions
}

export interface ObservabilityHandle {
  /** Normalized API mount path (env/config switch aware). */
  apiPath: string
  /** Connect/Express/http.createServer compatible middleware. */
  middleware: ConnectMiddleware
  /** Vite plugin equivalent (dev + preview + build entry for spectator.html). */
  plugin: ReturnType<typeof observabilityApiPlugin>
  /** Lazily starts (once) and returns the live economy service. */
  getService(): Promise<EconomyService>
  /** Current live service or null when not started yet. */
  getServiceOrNull(): ObservabilitySource | null
}

/**
 * Production host integration point.
 *
 * Starts (lazily) the single authoritative economy service and returns the
 * middleware/plugin the host must mount. Mount points:
 *
 *   - Vite:        plugins: [observabilityApiPlugin()]
 *   - Node http:   http.createServer(handle.middleware)
 *   - Express:     app.use(handle.middleware)
 *
 * See docs/observability.md for the exact contract expected from the host.
 */
export async function startObservability(
  options: StartObservabilityOptions = {},
): Promise<ObservabilityHandle> {
  let pending: Promise<EconomyService> | null = null
  const ensureService = (): Promise<EconomyService> => {
    if (!pending) pending = startEconomyService(options.economy ?? {})
    return pending
  }

  const middleware = createObservabilityMiddleware({
    ...options,
    getService: () => ensureService().then(asObservabilitySource),
  })
  const context = createObservabilityContext({
    ...options,
    getService: () => ensureService().then(asObservabilitySource),
  })

  return {
    apiPath: context.apiPath,
    middleware,
    plugin: observabilityApiPlugin(options),
    getService: ensureService,
    getServiceOrNull: () => getEconomyServiceOrNull(),
  }
}
