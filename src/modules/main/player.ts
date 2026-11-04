import { RpgPlayer, type RpgPlayerHooks } from '@rpgjs/server'
import type { GameAuthData } from '../../server/auth/game-auth'

declare module '@rpgjs/server' {
    interface RpgPlayer {
        /** MPC-derived NEAR public key verified by the server. */
        nearPublicKey?: string
        /** NEAR implicit account id derived from the public key. */
        nearAccountId?: string
        /** Public short hash of the Auth0 subject. */
        auth0SubjectHash?: string
    }
}

export const player: RpgPlayerHooks<GameAuthData> = {
    onAuthSuccess(player: RpgPlayer, auth) {
        player.nearPublicKey = auth.data?.nearPublicKey
        player.nearAccountId = auth.data?.nearAccountId
        player.auth0SubjectHash = auth.data?.auth0SubjectHash
        if (auth.data?.displayName) {
            player.name = auth.data.displayName
        }
    },
    onConnected(player: RpgPlayer) {
        player.changeMap('simplemap', {
            x: 300,
            y: 300
        })
        if (!player.name) {
            player.name = player.nearAccountId?.slice(0, 10) ?? 'Player'
        }
        player.setGraphic('hero')
    },
    onInput(player: RpgPlayer, { action }) {
        if (action == 'escape') {
            player.callMainMenu()
        }
    }
}
