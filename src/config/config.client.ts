import { provideClientGlobalConfig, provideClientModules, Presets } from "@rpgjs/client";
import mainClient from "../modules/main/client";
import { provideTiledMap } from "@rpgjs/tiledmap/client";

export default {
  providers: [
    provideTiledMap({
      basePath: "map",
    }),
    provideClientGlobalConfig(),
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
