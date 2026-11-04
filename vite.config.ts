import { defineConfig } from 'vite';
import { rpgjs, tiledMapFolderPlugin } from '@rpgjs/vite';
import startServer from './src/server';
import { observabilityApiPlugin } from './src/server/observability';

export default defineConfig({
  optimizeDeps: {
    include: ['pixi.js > @xmldom/xmldom']
  },
  plugins: [
    tiledMapFolderPlugin({
      sourceFolder: './src/tiled',      // Folder containing your TMX files
      publicPath: '/map',               // Public URL path for maps
      buildOutputPath: 'map'            // Match the runtime Tiled URL prefix
    }),
    ...rpgjs({
      server: startServer
    }),
    // Read-only spectator API (`/api/market/*`) + `/spectator` dashboard.
    // Mount point is switchable via IRONBLOCK_OBSERVABILITY_API_PATH.
    observabilityApiPlugin(),
  ],
});
