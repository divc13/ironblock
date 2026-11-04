# NEAR Auth login spike — manual test checklist

**Testnet only.** This flow uses the shared NEAR Auth testnet Auth0 application and
the testnet MPC signer. It does not create a wallet, request a seed phrase, or ask
for gas.

## Prerequisites

- `npm install`
- A Google account **or** an email/password account on the shared Auth0 tenant.
  New email accounts can be created from the Auth0 sign-up link. Email may be
  absent from a provider response; the game then uses a fallback display name.
- The dev server must run on **port 3000**. The shared Auth0 client only allows
  `http://localhost:3000` (and `http://localhost:3000/`) as a callback URL.
- For the built app, `NEAR_AUTH_SESSION_SECRET` must be set before `npm start`.

## Start

Development:

```bash
npm run dev
```

Open <http://localhost:3000>. Use `localhost`, not `127.0.0.1`; Auth0 matches the
callback URL exactly.

Built production host:

```bash
npm run build
NEAR_AUTH_SESSION_SECRET="$(openssl rand -base64 48)" npm start
```

`vite preview` serves built assets and the auth HTTP routes, but does not start
the RPGJS game WebSocket. Use `npm start` for a playable built server.

## Checklist

### Login screen

- [ ] The RPGJS canvas boots without connecting to the game server.
- [ ] The login overlay is visible above the canvas.
- [ ] “Continue with Google” and “Continue with email” are enabled.
- [ ] The page says testnet only and mentions no wallet/seed phrase/gas prompt.
- [ ] No wallet extension, seed phrase or transaction prompt appears.
- [ ] The browser receives an Auth0 access token only in memory during the
      exchange; it is not persisted in `localStorage`, `sessionStorage`, or a
      cookie by this app.

### Google popup

- [ ] Clicking “Continue with Google” opens one Auth0 popup.
- [ ] The popup reaches Google sign-in (`accounts.google.com`).
- [ ] Completing Google sign-in returns to the game and the overlay shows
      “Session verified. Entering the town…”.
- [ ] The overlay disappears and the WebSocket connects.
- [ ] The player name is derived from the email local-part, or from the public
      subject hash when email is absent.

### Email popup

- [ ] Clicking “Continue with email” opens the Auth0 universal login page.
- [ ] The Auth0 page offers email/password and “Sign up”.
- [ ] Completing email login returns to the game and the overlay disappears.
- [ ] An incorrect password shows a readable error without exposing tokens.

### Server verification

- [ ] `POST /api/auth/near` returns `sessionToken`, `expiresAt` and `player`.
- [ ] `GET /api/auth/session` with `Authorization: Bearer <sessionToken>` returns
      the same player.
- [ ] `POST /api/auth/logout` with the same bearer token returns `204`.
- [ ] After logout, `GET /api/auth/session` returns `401`.
- [ ] A WebSocket connection with a revoked token is rejected.
- [ ] An expired game session is rejected at `/api/auth/session` and at
      WebSocket connect time.
- [ ] Reloading after session expiry asks for login again.
- [ ] `GET /api/auth/health` returns `200` with `{"status":"ok",...}`.
- [ ] `GET /health` on the production host returns `200`.
- [ ] A malformed login request is rate-limited after the configured IP/subject
      threshold rather than reaching MPC indefinitely.

### Storage and tabs

- [ ] `sessionStorage` is per-tab: a newly opened tab normally asks for login
      instead of silently sharing the first tab's session.
- [ ] In a tab with storage disabled, the current page falls back to the
      in-memory session and can connect; reloading that page requires login.
- [ ] The browser never persists the Auth0 access token; only the server-issued
      game session is cached.

### Security checks

- [ ] No token, Auth0 `sub`, email, private key or `NEAR_AUTH_SESSION_SECRET`
      appears in server logs.
- [ ] A client-supplied NEAR account id is not trusted; the server derives the
      implicit account id from the verified MPC public key.
- [ ] `.env` is not committed and `NEAR_AUTH_SESSION_SECRET` is set in any
      non-development environment.
- [ ] `X-Forwarded-For` is not trusted by default; put a trusted proxy and limiter
      in front of a public deployment.
- [ ] The production host's CSP allows the Auth0 tenant and RPC but blocks
      unrelated script/frame origins.
- [ ] The game session is treated as a bearer token in the WebSocket query
      string; production uses TLS and a short TTL.

## Actual attempt record (2026-11-04)

Environment: headless Chrome 156, `npm run dev` on `http://localhost:3000`,
shared testnet Auth0 client `np8paqIpMWmNbzT4xAvOOapZBjsOpptl`.

- Login overlay rendered above the RPGJS canvas; no console exceptions.
- Google button opened one Auth0 popup and redirected to the Google account
  chooser (`accounts.google.com`).
- Email button opened the Auth0 universal login page at
  `/u/login/identifier`, which offers email/password, sign-up, passkey and
  Google.
- A callback URL mismatch was confirmed for `127.0.0.1:5173`; using
  `http://localhost:3000` is required.
- Full login could not be completed because no Google or email test credentials
  were available in this environment. This was **not** a code-path failure: the
  flow reached the external identity provider correctly. Do not record this as a
  successful real Auth0 login.
- Separately, a locally signed test session (not an Auth0 login) was used to
  exercise session restore and the RPGJS socket. The client restored the
  session, the WebSocket authenticated, and the server created the map room.
  This validates the game-session wiring without claiming a real Auth0 login.
- Headless Chrome emitted a Pixi `updateRenderable` warning and a black canvas;
  the same warning and black canvas occur on the untouched `main` scaffold, so
  it is an environment/renderer issue rather than an auth-flow regression.
- The production auth probe confirmed that built preview and `npm start` return
  `400`/`401` from `/api/auth/near` and `401` from `/api/auth/session`, not
  `404`, including under a `/quest/` subpath.

## Known limitations

- The auth store, revocation list and rate limiter are in memory; restarting the
  process clears them and multiple processes do not share limits.
- A signed session token remains valid across a process restart until its `exp`
  time unless a logout/revocation has marked the new process authoritative.
- The `/api/auth/*` routes are mounted by the Vite dev/preview server and the
  built production host only. A different deployment must mount the same handler.
- Auth0 access tokens are not persisted; reload restoration uses the
  server-issued game session in per-tab `sessionStorage`, with an in-memory
  fallback for the current page.
- The session token is a bearer token in the WebSocket query string. There is no
  cookie/subprotocol transport yet; use a short TTL and TLS.
- Expiry is checked at WebSocket connect. An already-connected socket is not
  forcibly disconnected when its token expires.
- `vite preview` does not run the RPGJS authoritative WebSocket transport.
- The CSP/security-header allowlist is implemented on the production host; it has
  not been exercised with a completed real Auth0 login because test credentials
  are unavailable.
