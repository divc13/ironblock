import { resolve } from 'node:path'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { createObservabilityMiddleware } from './http'
import {
  apiPathFromEnv,
  DEFAULT_API_PATH,
  normalizeApiPath,
  type ObservabilityContextOptions,
} from './context'
import { startEconomyService, ensureLiveEconomy, type StartEconomyOptions } from '../economy/runtime'
import { stopLiveEconomy } from '../economy/live'
import type { EconomyService } from '../economy/service'
import { asObservabilitySource } from './source'

export interface ObservabilityPluginOptions
  extends Omit<ObservabilityContextOptions, 'getService' | 'apiPath'> {
  /** Overrides for the lazily started economy service (save path, autoSave). */
  economy?: StartEconomyOptions
  /** URL where the spectator dashboard is served. Default `/spectator`. */
  spectatorPath?: string
  /** Full mount path for the API (env `IRONBLOCK_OBSERVABILITY_API_PATH` wins over the default). */
  apiPath?: string
}

export const DEFAULT_SPECTATOR_PATH = '/spectator'

const normalizeSegment = (value: string): string =>
  `/${value.replace(/^\/+|\/+$/g, '')}`.replace(/\/+$/, '') || ''

const joinBase = (base: string, path: string): string => {
  const baseSegment = base === '/' || base === '' ? '' : normalizeSegment(base)
  return `${baseSegment}${normalizeSegment(path) || ''}` || '/'
}

/**
 * Rewrites `<base>/spectator` to `<base>/spectator.html` so the dashboard is
 * reachable at a clean URL in dev and preview without touching the game's SPA
 * fallback.
 */
function spectatorRewriteMiddleware(spectatorPath: string, base: string) {
  const target = normalizeSegment(spectatorPath)
  return (req: { url?: string }, _res: unknown, next: () => void) => {
    const url = req.url ?? '/'
    const [rawPath, search = ''] = url.split('?')
    let pathname = rawPath
    const baseSegment = base === '/' || base === '' ? '' : normalizeSegment(base)
    if (baseSegment && pathname.startsWith(`${baseSegment}/`)) {
      pathname = pathname.slice(baseSegment.length)
    } else if (baseSegment && pathname === baseSegment) {
      pathname = '/'
    }
    const searchSuffix = search ? `?${search}` : ''
    if (pathname === target || pathname === `${target}/`) {
      req.url = `${joinBase(base, '/spectator.html')}${searchSuffix}`
    }
    next()
  }
}

/**
 * Vite plugin that mounts the read-only observability API and the spectator
 * dashboard without colliding with RPGJS or auth routes.
 *
 * - dev + preview: `createObservabilityMiddleware()` serves
 *   `<base>${apiPath}/*` (default `<base>/api/market/*`) and rewrites
 *   `<base>/spectator` to the dashboard HTML.
 * - build: adds `spectator.html` as a second HTML entry so the dashboard is
 *   emitted to `dist/spectator.html` next to the game entry.
 *
 * The economy service starts lazily on the first API request; the live NPC
 * loop starts with the Vite host (unless this is a test runner), sharing the
 * process-wide singleton with the economy plugin and the game server.
 */
export function observabilityApiPlugin(options: ObservabilityPluginOptions = {}): Plugin {
  const spectatorPath = options.spectatorPath ?? DEFAULT_SPECTATOR_PATH
  let servicePromise: Promise<EconomyService> | null = null
  let resolvedRoot = process.cwd()
  let resolvedBase = '/'

  const ensureService = (): Promise<EconomyService> => {
    if (!servicePromise) {
      servicePromise = startEconomyService(options.economy ?? {})
    }
    return servicePromise
  }

  const apiPathFor = (base: string): string => {
    // Explicit option wins; then the verbatim env switch; otherwise the API
    // sits under the deployment base path (subpath support).
    if (options.apiPath) return normalizeApiPath(options.apiPath)
    const fromEnv = apiPathFromEnv()
    if (fromEnv) return normalizeApiPath(fromEnv)
    const baseSegment = base === '/' || base === '' ? '' : normalizeSegment(base)
    return `${baseSegment}${DEFAULT_API_PATH}` || DEFAULT_API_PATH
  }

  const mount = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use(spectatorRewriteMiddleware(spectatorPath, resolvedBase))
    server.middlewares.use(
      createObservabilityMiddleware({
        ...options,
        apiPath: apiPathFor(resolvedBase),
        getService: () => ensureService().then(asObservabilitySource),
      }),
    )

    // The economy plugin calls the same idempotent starter. Whichever plugin
    // boots first creates the loop; the other shares it.
    void ensureLiveEconomy(options.economy ?? {}).catch(error => {
      console.warn(
        '[ironblock] live economy failed to start:',
        error instanceof Error ? error.message : String(error),
      )
    })

    server.httpServer?.once('close', () => {
      void stopLiveEconomy()
    })
  }

  return {
    name: 'ironblock:observability-api',
    config(_userConfig, env) {
      if (env.command !== 'build') return
      // Keep the game entry intact and add the spectator page next to it.
      return {
        build: {
          rollupOptions: {
            input: {
              index: resolve(resolvedRoot, 'index.html'),
              spectator: resolve(resolvedRoot, 'spectator.html'),
            },
          },
        },
      }
    },
    configResolved(resolved) {
      resolvedRoot = resolved.root
      resolvedBase = resolved.base
    },
    configureServer(server: ViteDevServer) {
      mount(server)
    },
    configurePreviewServer(server: PreviewServer) {
      mount(server)
    },
  }
}
