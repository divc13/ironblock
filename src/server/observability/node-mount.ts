import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { createObservabilityMiddleware, type ConnectMiddleware, type MiddlewareOptions } from './http'
import { DEFAULT_SPECTATOR_PATH } from './vite-plugin'

/**
 * Production mount for the observability API + spectator dashboard.
 *
 * Wraps `createObservabilityMiddleware()` with static serving of the *built*
 * spectator page. Designed for the production host:
 *
 *   import { createObservabilityNodeHandler } from './server/observability/node-mount'
 *   http.createServer(createObservabilityNodeHandler({ getService }))
 *
 * The economy service is never started here: `getService` is supplied by the
 * caller, so mounting stays passive until the host boots the world.
 */
export interface ObservabilityNodeMountOptions extends MiddlewareOptions {
  /** URL where the spectator dashboard is served. Default `/spectator`. */
  spectatorPath?: string
  /** Explicit path to the built page; wins over `rootDir` candidates. */
  spectatorFile?: string
  /** Project root used to locate `dist/` artifacts. Default `process.cwd()`. */
  rootDir?: string
}

/** Normalizes a mount path to a leading-slash, trailing-slash-free form. */
const normalizePathSegment = (value: string): string =>
  `/${value.replace(/^\/+|\/+$/g, '')}`

const builtPageCandidates = (rootDir: string): string[] => [
  resolve(rootDir, 'dist/spectator.html'),
  resolve(rootDir, 'dist/client/spectator.html'),
]

/**
 * Locates the built spectator page: `dist/spectator.html` first, then the
 * `dist/client/spectator.html` fallback used by the current RPGJS/Vite client
 * output. Returns `null` when neither exists (e.g. the host mounted before
 * `npm run build` finished).
 */
export async function resolveSpectatorFile(rootDir: string = process.cwd()): Promise<string | null> {
  for (const candidate of builtPageCandidates(rootDir)) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Keep looking through the fallback chain.
    }
  }
  return null
}

/** First candidate that can be read, or `null` when the page was never built. */
const readFirstBuiltPage = async (candidates: string[]): Promise<Buffer | null> => {
  for (const candidate of candidates) {
    try {
      return await readFile(candidate)
    } catch {
      // Missing or unreadable: try the next candidate, then report 404.
    }
  }
  return null
}

/**
 * 200 + the built HTML (`Content-Type: text/html; charset=utf-8`), or a short
 * 404 message when the page was never built. `headOnly` answers with the same
 * headers and no body.
 */
const answerWithBuiltPage = async (
  candidates: string[],
  headOnly: boolean,
  response: ServerResponse,
): Promise<void> => {
  const page = await readFirstBuiltPage(candidates)
  if (page === null) {
    const message =
      `Spectator dashboard not found. Expected one of: ${candidates.join(', ')}. ` +
      'Run "npm run build" first.'
    response.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(message)),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    response.end(headOnly ? undefined : message)
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(page.byteLength),
    'X-Content-Type-Options': 'nosniff',
  })
  // HEAD answered with headers only.
  response.end(headOnly ? undefined : page)
}

/**
 * Connect-style `(req, res, next) => void` handler for `http.createServer`,
 * Express apps and other Connect-compatible hosts.
 *
 * - `<spectatorPath>`, `<spectatorPath>/` and `<spectatorPath>.html`
 *   (GET/HEAD only): serves the built spectator HTML (200) or a short 404
 *   message when the page is missing; HEAD sends the same headers, no body.
 * - `<apiPath>/*`: answered by the existing observability middleware.
 * - everything else: `next()` keeps the game and auth routes untouched.
 */
export function createObservabilityNodeHandler(
  options: ObservabilityNodeMountOptions,
): ConnectMiddleware {
  const { spectatorFile, rootDir, ...apiOptions } = options
  const spectatorPath = normalizePathSegment(options.spectatorPath ?? DEFAULT_SPECTATOR_PATH)
  const spectatorHtmlPath = `${spectatorPath}.html`
  const candidates = spectatorFile
    ? [resolve(rootDir ?? process.cwd(), spectatorFile)]
    : builtPageCandidates(rootDir ?? process.cwd())
  const apiMiddleware = createObservabilityMiddleware(apiOptions)

  return (request, response, next) => {
    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      pathname = '/'
    }

    const matchesSpectator =
      pathname === spectatorPath ||
      pathname === `${spectatorPath}/` ||
      pathname === spectatorHtmlPath
    const servesPage = matchesSpectator && (request.method === 'GET' || request.method === 'HEAD')
    if (!servesPage) {
      apiMiddleware(request, response, next)
      return
    }

    void answerWithBuiltPage(candidates, request.method === 'HEAD', response).catch(() => {
      // Client disconnected (or the file vanished mid-read): nothing left to
      // answer; dropping is safer than throwing into the host handler.
      if (!response.writableEnded) response.destroy()
    })
  }
}
