import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin, PreviewServer, ResolvedConfig, ViteDevServer } from 'vite'
import { createObservabilityMiddleware } from './http'
import {
  apiPathFromEnv,
  DEFAULT_API_PATH,
  normalizeApiPath,
  type ObservabilityContextOptions,
} from './context'
import { startEconomyService, type StartEconomyOptions } from '../economy/runtime'
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

/** Browser entry for the standalone dashboard (kept out of the game bundle). */
export const SPECTATOR_ENTRY = './src/spectator/main.ts'

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
 * The economy service starts lazily on the first API request; booting the game
 * never waits on it.
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
      server.middlewares.use(spectatorRewriteMiddleware(spectatorPath, resolvedBase))
      server.middlewares.use(
        createObservabilityMiddleware({
          ...options,
          apiPath: apiPathFor(resolvedBase),
          getService: () => ensureService().then(asObservabilitySource),
        }),
      )
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(spectatorRewriteMiddleware(spectatorPath, resolvedBase))
      server.middlewares.use(
        createObservabilityMiddleware({
          ...options,
          apiPath: apiPathFor(resolvedBase),
          getService: () => ensureService().then(asObservabilitySource),
        }),
      )
    },
  }
}

/**
 * Keeps `spectator.html` independent from the RPGJS game client.
 *
 * `@rpgjs/vite`'s entry-point plugin runs as an HTML `pre` transform and
 * rewrites *every* module script in *every* HTML entry to the game client. That
 * is correct for `index.html`, but makes the dashboard boot the canvas game.
 * Register this plugin after `rpgjs()` so its `pre` hook runs last and restores
 * the dashboard entry before Vite collects module scripts. The spectator then
 * gets its own JS chunk in the same build, with no separate build step.
 */
export function spectatorStandalonePlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | null = null

  return {
    name: 'ironblock:spectator-standalone',
    configResolved(config) {
      resolvedConfig = config
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const filename = context.filename.replace(/\\/g, '/')
        if (!filename.endsWith('/spectator.html')) return html
        return html.replace(
          /<script\s+type="module"\s+src="[^"]*"[^>]*><\/script>/gi,
          `<script type="module" src="${SPECTATOR_ENTRY}"></script>`,
        )
      },
    },
    async closeBundle() {
      if (!resolvedConfig || resolvedConfig.command !== 'build') return

      const builtPage = resolve(
        resolvedConfig.root,
        resolvedConfig.build.outDir,
        'spectator.html',
      )
      const html = await readFile(builtPage, 'utf8')
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)].map(
        match => match[1],
      )

      if (/(?:canvasengine|\/client-)/i.test(html)) {
        throw new Error(
          `[ironblock] ${builtPage} still loads the RPGJS game client; ` +
            'spectator.html must stay independent of the game bundle.',
        )
      }
      if (
        scripts.length === 0 ||
        !scripts.some(src => /\/assets\/spectator-[^/]+\.js$/i.test(src))
      ) {
        throw new Error(
          `[ironblock] ${builtPage} has no spectator bundle ` +
            `(scripts: ${scripts.join(', ') || 'none'}).`,
        )
      }
    },
  }
}
