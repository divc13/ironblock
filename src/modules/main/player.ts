import { RpgPlayer, type RpgPlayerHooks } from '@rpgjs/server'
import { world } from '../../config/world'

export const player: RpgPlayerHooks = {
    onConnected(player: RpgPlayer) {
        player.changeMap(world.mapId, {
            x: world.spawn.x,
            y: world.spawn.y
        })
        player.name = 'Wanderer'
        player.setGraphic('hero')
    },
    onInput(player: RpgPlayer, { action }) {
        if (action == 'escape') {
            player.callMainMenu()
        }
    }
}
