import { defineConfig, loadEnv } from 'vite';
import { rpgjs, tiledMapFolderPlugin } from '@rpgjs/vite';
import { randomBytes } from 'node:crypto';
import startServer from './src/server';
import { nearAuthApiPlugin } from './src/server/auth/vite-plugin';
import { economyApiPlugin } from './src/server/economy/vite-plugin';
import { observabilityApiPlugin } from './src/server/observability';
import { settlementApiPlugin } from './src/server/settlement/vite-plugin';
import { loadSettlementConfig } from './src/server/settlement/config';
import { createLazyEconomySettlementLedger } from './src/server/settlement/economy-ledger';
import { NearApiNep245Chain } from './src/server/settlement/near-chain';
import { defaultAuthStore, verifyActiveGameSession } from './src/server/auth/service';
import {
  loadServerAuthConfig,
  type ServerAuthConfig,
  validateClientServerAuthConsistency,
} from './src/server/auth/config';

// This project uses the authoritative Node server for NEAR Auth. Standalone
// mode remains available for asset smoke tests with RPG_TYPE=rpg.
process.env.RPG_TYPE ??= 'mmorpg';

/**
 * Settlement options for the Vite dev/preview plugin. Config creation is
 * synchronous, so the ledger lazily binds the shared economy singleton on its
 * first request (the same instance the economy API/game use).
 */
function settlementPluginOptions(authConfig: ServerAuthConfig) {
  try {
    const settlementConfig = loadSettlementConfig(process.env);
    return {
      authConfig,
      settlementConfig,
      chain: new NearApiNep245Chain(settlementConfig),
      ledger: createLazyEconomySettlementLedger(),
      verifySession: (token: string) =>
        verifyActiveGameSession(token, authConfig, defaultAuthStore),
    };
  } catch (error) {
    // Missing/invalid settlement env must not stop the game or auth routes.
    console.warn(
      '[ironblock] settlement is disabled:',
      error instanceof Error ? error.message : String(error),
    );
    return { authConfig };
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Vite exposes only VITE_* values to the browser automatically. Copy the
  // server-only NEAR Auth settings into process.env for the API middleware and
  // the RPGJS engine auth hook (both run in this Node process).
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NEAR_AUTH_') && !process.env[key]) {
      process.env[key] = value;
    }
  }

  // The live economy loop reads process.env directly, so mirror its `.env`
  // overrides for dev and preview the same way as the auth settings.
  for (const key of [
    'IRONBLOCK_LIVE_TICK_MS',
    'IRONBLOCK_LIVE_TICK_SECONDS',
    'IRONBLOCK_LIVE_SAVE_MS',
    'IRONBLOCK_ECONOMY_SAVE',
  ]) {
    const value = env[key];
    if (value !== undefined && value !== '' && !process.env[key]) {
      process.env[key] = value;
    }
  }

  if (!process.env.NEAR_AUTH_SESSION_SECRET) {
    process.env.NEAR_AUTH_SESSION_SECRET = randomBytes(48).toString('base64url');
    console.warn(
      '[ironblock] NEAR_AUTH_SESSION_SECRET is not set; using an ephemeral development secret. ' +
        'Sessions reset when the dev server restarts.',
    );
  }

  const serverAuthConfig = loadServerAuthConfig(process.env);
  validateClientServerAuthConsistency(serverAuthConfig, env);

  return {
    // The shared NEAR Auth testnet Auth0 application allows
    // http://localhost:3000 as a callback. Keep this port stable so popup login
    // works without changing the shared tenant's allowed callback URLs.
    server: {
      port: 3000,
      strictPort: true,
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
    },
    optimizeDeps: {
      include: ['pixi.js > @xmldom/xmldom']
    },
    plugins: [
      nearAuthApiPlugin(),
      economyApiPlugin(),
      settlementApiPlugin(settlementPluginOptions(serverAuthConfig)),
      // Read-only spectator API (`/api/market/*`) + `/spectator` dashboard.
      // Mount point is switchable via IRONBLOCK_OBSERVABILITY_API_PATH. Also
      // adds spectator.html as a second build entry (dist/spectator.html).
      observabilityApiPlugin(),
      tiledMapFolderPlugin({
        sourceFolder: './src/tiled',      // Folder containing your TMX files
        publicPath: '/map',               // Public URL path for maps
        buildOutputPath: 'map'            // Match the runtime Tiled URL prefix
      }),
      ...rpgjs({
        server: startServer,
        entryPoints: {
          mmorpg: {
            adapters: {
              production: './src/server/production.ts',
            },
          },
        },
      })
    ],
  };
});
