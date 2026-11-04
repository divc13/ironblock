import { MockEconomyClient } from './mock'
import type { EconomyClient, EconomyMode } from './types'

export * from './types'
export {
  MockEconomyClient,
  MockFastForwardClient,
  blockedMessage,
  requiredInvestmentFor,
} from './mock'
export { HttpEconomyClient, HttpFastForwardClient, EconomyApiError } from './http'

export interface EconomyClientFactoryOptions {
  /** Overrides `import.meta.env` in tests and host integrations. */
  env?: Record<string, string | undefined>
  /**
   * The real server-backed client. When supplied it always wins: the world
   * overlay is only allowed to show the mock when no authenticated client was
   * provided. When `VITE_ECONOMY_CLIENT=server` is requested without this
   * client, the factory falls back to the mock and reports the fallback instead
   * of pretending the real economy is connected.
   */
  serverClient?: EconomyClient
}

export interface EconomyClientRuntime {
  client: EconomyClient
  mode: EconomyMode
  /** True when the mock is shown instead of an available server client. */
  fellBackToMock: boolean
  /** Human-readable explanation for the HUD banner. */
  note: string
}

export const resolveEconomyMode = (
  env: Record<string, string | undefined> | undefined,
): EconomyMode => (env?.VITE_ECONOMY_CLIENT === 'server' ? 'server' : 'mock')

/**
 * Builds the client boundary.
 *
 * A supplied authenticated `serverClient` always wins, regardless of the env
 * flag. Without one, the deterministic mock keeps the town playable and the
 * runtime reports the fallback explicitly.
 */
export function createEconomyRuntime(
  options: EconomyClientFactoryOptions = {},
): EconomyClientRuntime {
  const env =
    options.env ??
    (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ??
    {}

  if (options.serverClient) {
    return {
      client: options.serverClient,
      mode: 'server',
      fellBackToMock: false,
      note: 'Connected to the authoritative Ironblock economy.',
    }
  }

  const mode = resolveEconomyMode(env)
  if (mode === 'server') {
    const note =
      'VITE_ECONOMY_CLIENT=server but no server adapter was supplied (no authenticated session). Running the local mock economy so the town stays playable.'
    console.warn(`[Ironblock] ${note}`)
    return {
      client: new MockEconomyClient(),
      mode: 'mock',
      fellBackToMock: true,
      note,
    }
  }

  return {
    client: new MockEconomyClient(),
    mode: 'mock',
    fellBackToMock: false,
    note: 'Mock economy — deterministic local market, safe to explore.',
  }
}

/** Convenience factory when the caller only needs the client. */
export function createEconomyClient(
  options: EconomyClientFactoryOptions = {},
): EconomyClient {
  return createEconomyRuntime(options).client
}
