import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ObservabilityContext,
  ObservabilityRequest,
  ObservabilityResult,
  ObservabilityStreamSender,
} from './types'
import { handleObservabilityRequest } from './handlers'
import { createObservabilityContext, ObservabilityContextOptions } from './context'

/** Connect/Express-compatible middleware. */
export type ConnectMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void

export interface MiddlewareOptions extends ObservabilityContextOptions {
  /** Requests not matching this prefix fall through to `next()`. Default `/api/market`. */
  apiPath?: string
}

const BASE_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

const readBody = (request: IncomingMessage, limit: number): Promise<{
  body: Uint8Array | null
  tooLarge: boolean
}> =>
  new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    const onEnd = () => resolve({ body: tooLarge ? null : Buffer.concat(chunks), tooLarge })
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > limit) {
        tooLarge = true
        chunks.length = 0
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', onEnd)
    request.on('error', onEnd)
  })

const stripApiPath = (rawUrl: string, apiPath: string): { path: string; query: URLSearchParams } | null => {
  const url = new URL(rawUrl, 'http://localhost')
  let pathname = url.pathname
  const normalizedApi = apiPath.replace(/\/+$/, '')
  if (pathname === normalizedApi) {
    pathname = '/'
  } else if (pathname.startsWith(`${normalizedApi}/`)) {
    pathname = pathname.slice(normalizedApi.length)
  } else {
    return null
  }
  return { path: pathname, query: url.searchParams }
}

const sseEscapingWrite = (response: ServerResponse, sender: ObservabilityStreamSender): void => {
  sender.event = (name, data) => {
    if (response.writableEnded) return
    response.write(`event: ${name}\n`)
    for (const line of data.split('\n')) {
      response.write(`data: ${line}\n`)
    }
    response.write('\n')
  }
  sender.comment = text => {
    if (response.writableEnded) return
    response.write(`: ${text}\n\n`)
  }
  sender.retry = milliseconds => {
    if (response.writableEnded) return
    response.write(`retry: ${milliseconds}\n\n`)
  }
}

/**
 * Mounts the observability API on any Node HTTP server:
 *
 *   http.createServer(createObservabilityMiddleware({ getService }))
 *   express().use(createObservabilityMiddleware({ getService }))
 *   viteServer.middlewares.use(createObservabilityMiddleware({ getService }))
 *
 * Non-matching paths call `next()`, so the game and auth routes are untouched.
 */
export function createObservabilityMiddleware(options: MiddlewareOptions): ConnectMiddleware {
  const context = createObservabilityContext(options)
  const apiPath = context.apiPath

  return async (request, response, next) => {
    const rawUrl = request.url ?? '/'
    const match = stripApiPath(rawUrl, apiPath)
    if (!match) {
      next()
      return
    }

    for (const [key, value] of Object.entries(BASE_HEADERS)) {
      response.setHeader(key, value)
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const observabilityRequest: ObservabilityRequest = {
      method: request.method ?? 'GET',
      path: match.path,
      query: match.query,
      rawBody: null,
    }

    if (observabilityRequest.method === 'POST') {
      const { body, tooLarge } = await readBody(request, context.bodyLimit)
      if (tooLarge) {
        response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(
          JSON.stringify({
            error: 'body_too_large',
            message: `Body exceeds ${context.bodyLimit} bytes`,
          }),
        )
        return
      }
      observabilityRequest.rawBody = body
    }

    let result: ObservabilityResult
    try {
      result = await handleObservabilityRequest(context, observabilityRequest, {
        clientKey: request.socket?.remoteAddress ?? 'local',
      })
    } catch (cause) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          error: 'internal_error',
          message: (cause as Error)?.message ?? 'unknown error',
        }),
      )
      return
    }

    if (result.kind === 'sse') {
      response.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const sender: ObservabilityStreamSender = {
        event: (_name: string, _data: string) => undefined,
        comment: (_text: string) => undefined,
        retry: (_milliseconds: number) => undefined,
      }
      sseEscapingWrite(response, sender)
      const dispose = result.stream.start(sender)
      response.on('close', () => dispose())
      return
    }

    const status = result.status
    const headers = 'headers' in result && result.headers ? result.headers : {}
    if (result.kind === 'json') {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
      response.end(JSON.stringify(result.body ?? { ok: true }))
      return
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
    response.end(JSON.stringify(result.body))
  }
}
