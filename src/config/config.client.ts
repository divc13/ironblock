import { provideClientGlobalConfig, provideClientModules, Presets } from "@rpgjs/client";
import mainClient from "../modules/main/client";
import { provideTiledMap } from "@rpgjs/tiledmap/client";

export default {
  providers: [
    provideTiledMap({
      basePath: "map",
    }),
    provideClientGlobalConfig(),
    // The server main module (maps and auth hooks) stays server-only; the
    // client main module mounts the economy HUD/overlay bridge and reacts to
    // the authoritative server's map data after login.
    provideClientModules([
      mainClient,
      {
        spritesheets: [
          {
            id: 'hero',
            image: 'spritesheets/hero.png',
            ...Presets.RMSpritesheet(3, 4)
          },
          {
            id: 'female',
            image: 'spritesheets/female.png',
             ...Presets.RMSpritesheet(3, 4)
          }
        ]
      }
    ])
  ],
};
