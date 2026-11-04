import { MockEconomyClient } from './mock'
import type { EconomyClient, EconomyMode } from './types'

export * from './types'
export { MockEconomyClient, MockFastForwardClient, blockedMessage, requiredInvestmentFor } from './mock'

export interface EconomyClientFactoryOptions {
  /** Overrides `import.meta.env` in tests and host integrations. */
  env?: Record<string, string | undefined>
  /**
   * The real server-backed client. When `VITE_ECONOMY_CLIENT=server` and this is
   * provided, the factory returns it unchanged. When it is missing, the factory
   * falls back to the mock and reports the fallback instead of pretending the
   * real economy is connected.
   */
  serverClient?: EconomyClient
}

export interface EconomyClientRuntime {
  client: EconomyClient
  mode: EconomyMode
  /** True when `server` was requested but no real client was supplied. */
  fellBackToMock: boolean
  /** Human-readable explanation for the HUD banner. */
  note: string
}

export const resolveEconomyMode = (
  env: Record<string, string | undefined> | undefined,
): EconomyMode => (env?.VITE_ECONOMY_CLIENT === 'server' ? 'server' : 'mock')

/**
 * Reads a Vite flag and builds the client boundary.
 *
 * Default: mock (fully playable town, deterministic events).
 * Integration: set `VITE_ECONOMY_CLIENT=server` and pass the real adapter via
 * `createEconomyRuntime({ serverClient })` (or register it in this file).
 */
export function createEconomyRuntime(
  options: EconomyClientFactoryOptions = {},
): EconomyClientRuntime {
  const env =
    options.env ??
    (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ??
    {}
  const mode = resolveEconomyMode(env)

  if (mode === 'server') {
    if (options.serverClient) {
      return {
        client: options.serverClient,
        mode: 'server',
        fellBackToMock: false,
        note: 'Connected to the real economy service.',
      }
    }
    const note =
      'VITE_ECONOMY_CLIENT=server but no server adapter was supplied. Running the mock economy so the town stays playable.'
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
