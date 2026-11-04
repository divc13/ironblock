# NEAR Auth login spike — manual test checklist

**Testnet only.** This flow uses the shared NEAR Auth testnet Auth0 application and
the testnet MPC signer. It does not create a wallet, request a seed phrase, or ask
for gas.

## Prerequisites

- `npm install`
- A Google account **or** an email/password account on the shared Auth0 tenant.
  New email accounts can be created from the Auth0 sign-up link.
- The dev server must run on **port 3000**. The shared Auth0 client only allows
  `http://localhost:3000` (and `http://localhost:3000/`) as a callback URL.

## Start

```bash
npm run dev
```

Open <http://localhost:3000>. Use `localhost`, not `127.0.0.1`; Auth0 matches the
callback URL exactly.

## Checklist

### Login screen

- [ ] The RPGJS canvas boots without connecting to the game server.
- [ ] The login overlay is visible above the canvas.
- [ ] “Continue with Google” and “Continue with email” are enabled.
- [ ] The page says testnet only and mentions no wallet/seed phrase/gas prompt.
- [ ] No wallet extension, seed phrase or transaction prompt appears.

### Google popup

- [ ] Clicking “Continue with Google” opens one Auth0 popup.
- [ ] The popup reaches Google sign-in (`accounts.google.com`).
- [ ] Completing Google sign-in returns to the game and the overlay shows
      “Session verified. Entering the town…”.
- [ ] The overlay disappears and the WebSocket connects.
- [ ] The player name is derived from the email local-part.

### Email popup

- [ ] Clicking “Continue with email” opens the Auth0 universal login page.
- [ ] The Auth0 page offers email/password and “Sign up”.
- [ ] Completing email login returns to the game and the overlay disappears.
- [ ] An incorrect password shows a readable error without exposing tokens.

### Server verification

- [ ] `POST /api/auth/near` returns `sessionToken`, `expiresAt` and `player`.
- [ ] `GET /api/auth/session` with `Authorization: Bearer <sessionToken>` returns
      the same player.
- [ ] A second tab restores the session from `sessionStorage` without another
      Auth0 popup.
- [ ] Reloading after session expiry asks for login again.
- [ ] A tampered/expired session token is rejected on the WebSocket.

### Security checks

- [ ] The browser never receives an Auth0 access token after login.
- [ ] No token, Auth0 `sub`, email, private key or `NEAR_AUTH_SESSION_SECRET`
      appears in server logs.
- [ ] A client-supplied NEAR account id is not trusted; the server derives the
      implicit account id from the verified MPC public key.
- [ ] `.env` is not committed and `NEAR_AUTH_SESSION_SECRET` is set in any
      non-development environment.

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
  flow reached the external identity provider correctly.
- Separately, a locally signed test session (not an Auth0 login) was used to
  exercise session restore and the RPGJS socket. The client restored the
  session, the WebSocket authenticated, and the server created the map room.
  This validates the game-session wiring without claiming a real Auth0 login.
- Headless Chrome emitted a Pixi `updateRenderable` warning and a black canvas;
  the same warning and black canvas occur on the untouched `main` scaffold, so
  it is an environment/renderer issue rather than an auth-flow regression.

## Known limitations

- The auth store and session revocation list are in memory; restarting the dev
  server clears them.
- The `/api/auth/*` routes are mounted by the Vite dev server only. A deployed
  server must mount the same handler on its own HTTP host.
- Auth0 access tokens are not persisted; reload restoration uses the
  server-issued game session in `sessionStorage`.
- The session token is a bearer token in the WebSocket query string. Deployments
  should use a short TTL and TLS.
