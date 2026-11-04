import { defineConfig, loadEnv } from 'vite';
import { rpgjs, tiledMapFolderPlugin } from '@rpgjs/vite';
import { randomBytes } from 'node:crypto';
import startServer from './src/server';
import { nearAuthApiPlugin } from './src/server/auth/vite-plugin';
import { economyApiPlugin } from './src/server/economy/vite-plugin';
import {
  loadServerAuthConfig,
  validateClientServerAuthConsistency,
} from './src/server/auth/config';

// This project uses the authoritative Node server for NEAR Auth. Standalone
// mode remains available for asset smoke tests with RPG_TYPE=rpg.
process.env.RPG_TYPE ??= 'mmorpg';

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
