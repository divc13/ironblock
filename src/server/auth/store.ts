import type { NearPlayerIdentity } from "../../shared/auth/types";
import type { GameSessionClaims } from "./session";

/**
 * SPIKE ONLY: small in-memory identity/session store for Phase 1.
 *
 * There is intentionally no database, password store, wallet or private-key
 * custody here. Restarting the dev server clears these records; the signed
 * session token remains the source of truth for game authentication.
 */
export interface StoredPlayer extends NearPlayerIdentity {
  /** Raw Auth0 subject stays server-side and is never serialized to clients. */
  auth0Subject: string;
  email?: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface StoredSession {
  sessionId: string;
  playerId: string;
  issuedAt: string;
  expiresAt: string;
}

export class InMemoryAuthStore {
  private readonly players = new Map<string, StoredPlayer>();
  private readonly sessions = new Map<string, StoredSession>();
  private recordedSessions = false;

  upsertPlayer(input: {
    identity: NearPlayerIdentity;
    auth0Subject: string;
    email?: string;
  }): StoredPlayer {
    const now = new Date().toISOString();
    const existing = this.players.get(input.identity.id);
    const player: StoredPlayer = {
      ...input.identity,
      auth0Subject: input.auth0Subject,
      email: input.email,
      createdAt: existing?.createdAt ?? now,
      lastLoginAt: now,
    };
    this.players.set(player.id, player);
    return player;
  }

  getPlayer(playerId: string): StoredPlayer | undefined {
    return this.players.get(playerId);
  }

  createSession(claims: GameSessionClaims): StoredSession {
    this.recordedSessions = true;
    const session: StoredSession = {
      sessionId: claims.sessionId,
      playerId: claims.playerId,
      issuedAt: new Date(claims.issuedAt * 1000).toISOString(),
      expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  getSession(sessionId: string): StoredSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  revokeSession(sessionId: string): void {
    // Mark this process as authoritative even when the token came from an
    // earlier process and had no local record. A subsequent logout must not
    // fall back to "the signed token is enough".
    this.recordedSessions = true;
    this.sessions.delete(sessionId);
  }

  prune(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) this.sessions.delete(id);
    }
  }

  /**
   * True once this process has issued at least one session. Lets the service
   * distinguish a fresh process (signed token is enough) from a session that
   * was revoked or expired in a running process.
   */
  get hasRecordedSessions(): boolean {
    return this.recordedSessions;
  }

  /** Test/diagnostic helper; not exposed over HTTP. */
  get size(): { players: number; sessions: number } {
    return { players: this.players.size, sessions: this.sessions.size };
  }
}
