import { createServer,  provideServerModules, LocalStorageSaveStorageStrategy } from "@rpgjs/server";
import { provideMain } from "./modules/main";
import { provideSaveStorage } from "@rpgjs/server";
import { provideTiledMap } from "@rpgjs/tiledmap/server";
import { economyConfigProvider } from "./config/config.server";

export default createServer({
    providers: [
      economyConfigProvider,
      provideMain(),
      provideSaveStorage(new LocalStorageSaveStorageStrategy({ key: "save" })),
      provideServerModules([]),
      provideTiledMap()
    ]
  });