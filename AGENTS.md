# uniPEQ_link — agent notes

Signaling server, and later the wire protocol, for linking **modernGraphTool** (mGT, a static web
app: `../modernGraphTool`) with **uniPEQ** (Capacitor app, web and Android: `../uniPEQ`). The two apps talk over one
WebRTC DataChannel; this repo's Cloudflare Worker only introduces them. The link is a one-time
session, like a call: when it ends, both sides forget it.

**Status (2026-10-12): building.** This repo's part (`client/`, landing page, assetlinks) is in;
next are uniPEQ's native service and app glue (design §9). The platform checks on a real phone,
their answers and the design rules they lead to are in [docs/phase-0.md](docs/phase-0.md). Pairing,
the wire protocol, uniPEQ's link service and mGT's side are in [docs/design.md](docs/design.md).

## Layout

```
client/              The reference client both apps install (`peq-link/client`): protocol, session,
                     sync, liveness, host (mGT), joiner (uniPEQ). TypeScript source, no deps
test/                Unit tests for client/ (`npm test`)
src/worker.ts        Routes /api/rooms/<code>?peer=<uuid> (WebSocket) to the room's Durable Object,
                     and /l/<code> to the landing page
src/landing.ts       The landing page: QR target and the intent link's fallback
src/room.ts          Room: ≤ 2 peers, relays `signal` messages, attests Origin, issues ICE servers
public/              Static assets, served before the Worker runs
  .well-known/assetlinks.json   App Link verification for both uniPEQ packages
  probe/             Phase 0 probe page at /probe/
    probe.js         The probe itself. Plain JS, no imports: also injected into uniPEQ's WebView
android-debug/       uniPEQ debug-only overlay: foreground service, unipeq://link deep link,
                     LinkProbeVisibility (keeps the WebView "visible" for the freeze experiment)
scripts/
  smoke.mjs          Signaling rules, static routes, a real DataChannel, and the protocol run:
                     the client as mGT and as uniPEQ with a fake device, in headless Chromium
  smoke-page.js      The in-page harness for the protocol run
  android-link-probe.mjs   adb + DevTools driver for uniPEQ's side (like uniPEQ's hid-spike)
  freeze-matrix.mjs  Q4b: every freeze experiment back to back, results from logcat
  unipeq-debug-overlay.mjs apply|remove the overlay into ../uniPEQ/android/app/src/debug
docs/phase-0.md      Phase 0: answers, design consequences, findings, how to rerun
docs/design.md       The link: pairing, wire protocol, uniPEQ link service, mGT side
results/             Probe logs, local only (gitignored): docs/phase-0.md is the record
```

## Commands

`npm run dev` (wrangler on :8787) · `npm test` (unit) · `npm run test:smoke` (needs `dev` running, or `-- --server
<url>`) · `npm run check` (tsc + syntax checks) · `npm run format` / `npm run lint` · `npm run
deploy`. Relay credentials: `npx wrangler secret put TURN_KEY_ID` / `TURN_KEY_API_TOKEN`
(Cloudflare Realtime TURN). Without them rooms offer STUN only.

## Rules

- **The server carries connection setup, nothing else.** Only `{ type: 'signal', data }` is
  relayed, and `data` is never read. EQ traffic goes over the DataChannel. Nothing is stored: a room
  exists while a peer is connected.
- **The peer id is stable per tab or app session**, so a signaling reconnect replaces the old
  socket (close 4002) without a `peer-left` / `peer-joined`: the DataChannel may still be up.
  If the old socket died first (a phone browser loses its network ~5 s after going to the
  background), the room does announce `peer-left`, then `peer-joined` with the **same** id. That
  is a rejoin: nothing is rebuilt, and the rejoining side sends `fresh` only if its own end is dead.
  `peer-joined` with a new id means a fresh session, which is why it triggers a new offer.
- **The attested origin is the WebSocket upgrade's `Origin` header.** Browsers can't fake it; other
  native apps can, so it is a label for the approval dialog, not authentication on its own.
- **A close before the WebSocket handshake completes is dropped** (seen in workerd), so a full room
  is answered with `{ type: 'error', code: 'room-full' }` on a plain, non-hibernating socket, and
  the client closes. Sockets without a peer attachment never count as peers (`Room.sockets()`).
- **The room code alphabet lives in three places**: `client/protocol.ts` (which the Worker and
  the smoke test import), `ROOM_ALPHABET` in `public/probe/probe.js` and the join regex in
  `public/probe/index.html`.
- **`client/` compiles under both apps' settings**: strict, DOM lib, no Node types, `.ts`
  imports, erasable syntax only (no enums, no constructor parameter properties), checked by
  `tsconfig.client.json`. It ships as source, so no build step and no dependencies.
- **A change to `client/` gets a version bump and a `vX.Y.Z` tag**; a wire change also bumps
  `PROTO` (major when an existing message changes meaning).
- **`android-debug/` is never committed to uniPEQ.** It goes into uniPEQ's debug source set only
  through `npm run overlay:apply`, which marks the directory so `overlay:remove` can't delete
  anything else.
- Free plan: the Durable Object is SQLite-backed (`new_sqlite_classes`), which is what the free
  plan offers, and uses the hibernation API with a `ping` → `pong` auto-response, so idle rooms
  cost nothing.

## Style

Same as modernGraphTool and uniPEQ: tabs, single quotes, no trailing commas, 100 columns
(`.prettierrc`). Comments state the rule and its reason in place.
