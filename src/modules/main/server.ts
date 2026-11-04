import { defineModule } from "@rpgjs/common";
import { RpgServer } from "@rpgjs/server";
import { player } from './player'
import { Npc } from "./event";
import { authenticateGameSocket } from "../../server/auth/game-auth";

export default defineModule<RpgServer>({
  player,
  engine: {
    auth(_server, socket) {
      return authenticateGameSocket(socket);
    },
    onAuthFailed(_server, error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[ironblock] game connection rejected:", message);
    },
  },
  maps: [
    {
      id: 'simplemap',
      events: [{
        id: 'npc',
        x: 300,
        y: 400,
        event: Npc()
      }]
    }
  ]
});
