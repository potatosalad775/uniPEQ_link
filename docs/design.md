# Link design

How modernGraphTool (mGT) and uniPEQ link: pairing, the wire protocol, uniPEQ's link service and
mGT's side. It builds on [phase-0.md](phase-0.md), whose seven design consequences are
requirements here.

**Status (2026-10-12):** this repo's part of step 1 (9) is built: `client/` with its tests, the
landing page, `assetlinks.json` (fingerprints still to fill in), the probe at `/probe/` and the
custom domain in `wrangler.jsonc`. Still open in step 1: the GitHub remote, the first tag and a
deploy.

## In short

- **mGT hosts, uniPEQ joins and approves.** mGT creates the room and shows its code. uniPEQ joins
  through the "Open uniPEQ" intent link (same phone), a QR code that opens uniPEQ as an App Link,
  or the typed code. It opens the DataChannel first and then asks the user "Link with
  `<origin>`?". Nothing the link sends touches the device until the user approves.
- **The band list is shared live, and uniPEQ owns it.** Both apps edit one list. uniPEQ holds the
  authoritative copy, numbers every change (`rev`), and is the only side that writes the device:
  auto-write, fit check and review all run in uniPEQ. mGT edits optimistically and adopts what
  uniPEQ echoes back. When both edit at once, the change uniPEQ applies last wins.
- **Edits are band patches, so concurrent edits rarely collide.** mGT sends `band`, `list` and
  `preamp` operations, sends `settle` when a gesture ends, and uniPEQ writes the device in that
  message's handler, never behind a timer (Phase 0: timers drift in Doze, messages don't).
- **While linked, uniPEQ runs a `connectedDevice` foreground service and keeps its WebView
  "visible".** Both start when the user approves and stop when the session ends. A self-check
  reports when Android paused uniPEQ anyway.
- **mGT watches liveness itself.** It pings every 5 s, shows "not answering" after 15 s of
  silence, reconnects signaling the moment its page is visible again, and resyncs from uniPEQ's
  snapshot.
- **A session ends** on Unlink from either side, on denial, or after 10 minutes of silence from
  mGT while uniPEQ is in the background (30 s if mGT's page was closed).
- **Messages are JSON over one ordered, reliable DataChannel**, versioned by a `[major, minor]`
  pair in `hello`. Every message from uniPEQ is a full snapshot (`device`, `status`, `eq`), so a
  resync is a resend.
- **The protocol code lives here** as a framework-free reference client (`client/`). Both apps
  install it as a git dependency pinned to a tag. Nothing is published to npm.

## Decisions

Made with the user on 2026-10-12, on top of the handover's fixed decisions: a DataChannel for
every case, a Cloudflare Worker and Durable Object with Realtime TURN, one-time sessions, the
protocol in this repo, every device kind counts, and mGT widening its filter types.

| Question                                 | Decision                                                              |
| ---------------------------------------- | --------------------------------------------------------------------- |
| uniPEQ's editor while linked             | Two-way live sync of the band list                                    |
| Who holds the list and writes the device | uniPEQ: authoritative copy, revisions, auto-write, fit, review        |
| Which list wins at link start            | mGT asks when they differ; an empty mGT list takes uniPEQ's silently  |
| mGT's per-band on/off and one-ear bands  | Unavailable while linked                                              |
| Undo                                     | Each side keeps its own history; a remote edit is one undo step       |
| Cross-device pairing                     | Typed code, plus a QR code that opens uniPEQ as a verified App Link   |
| Pairing secret                           | The room code is enough; uniPEQ's approval is the gate                |
| Grace period                             | 10 min of silence from mGT (while uniPEQ is in the background)        |
| mGT operators                            | On by default; a config key hides it or points to another Worker      |
| Protocol code                            | A git dependency on this repo, pinned to a tag; never published       |
| Production host                          | `link.unipeq.com` (the bare `unipeq.com` stays for uniPEQ on the web) |

## 1. Roles

| Piece  | Role                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker | Signaling only, as today: a 2-peer room per code, `signal` relay, attested `Origin`, ICE servers. Adds the `/l/<CODE>` landing page and `assetlinks.json`. |
| mGT    | Host. Creates the room, shows the code, QR and "Open uniPEQ" button, sends edits and commands, checks liveness, mirrors uniPEQ's device status.            |
| uniPEQ | Joiner and authority. Asks for approval, holds the shared list, writes the device, runs the link service while linked.                                     |

uniPEQ owns the list because it's the side that stays alive. On a phone, mGT's tab loses its
network 5 s after it's hidden and freezes after 60 s. uniPEQ, with the link service, keeps
running. If writes came from mGT, edits made in uniPEQ would wait for mGT to come back.

## 2. Pairing

The room code is eight Crockford base32 characters, shown as `XXXX-XXXX`. That's 40 random bits,
the room holds two peers, and it lives only while a peer is connected. There is no separate
secret. Guessing a code gets a stranger nothing: they could only pose as uniPEQ to an mGT tab and
see its EQ. They can't drive the user's device, because uniPEQ only joins a room the user picked
(a tapped link, a scanned QR or a typed code) and still asks for approval.

### 2.1 Same phone: the intent link

1. In mGT, **Link with uniPEQ** creates a room, connects signaling and shows the code plus
   **Open uniPEQ**. The button only appears on Android.
2. The button is
   `intent://link?server=<worker>&room=<CODE>#Intent;scheme=unipeq;package=kr.potatosalad775.unipeq;S.browser_fallback_url=<worker>/l/<CODE>;end`,
   where `<worker>` is `https://link.unipeq.com` unless the site configures another server (6.5).
   This is the Q6 link, which works warm (channel open 1.5 s after the tap) and cold (the room is
   in `App.getLaunchUrl()`).
3. uniPEQ joins straight away, without waiting for the user, so the channel opens inside the 5 s
   before Chrome loses its network.
4. uniPEQ shows the approval dialog as soon as signaling tells it mGT's origin (2.3).
5. **If a cold start misses the 5 s window**, uniPEQ shows "Go back to the browser to finish
   linking". mGT reconnects signaling when it's visible again, and the channel opens. If the user
   hadn't approved yet, mGT shows "Approve in uniPEQ" with **Open uniPEQ** again. That second trip
   is warm, so it fits in the window.

If uniPEQ isn't installed, Chrome opens the fallback URL: the landing page (7.1), which links to
Google Play and GitHub releases. That path wasn't tested in Phase 0 (6c).

### 2.2 Another device: QR or typed code

mGT shows the code, the QR code and, on Android, **Open uniPEQ**.

- **QR code:** it encodes `https://link.unipeq.com/l/<CODE>`. On a phone with uniPEQ, the camera app
  opens it as a verified Android App Link and uniPEQ joins. uniPEQ's manifest declares the
  host `link.unipeq.com` with `autoVerify`, and the Worker serves `/.well-known/assetlinks.json`
  for both builds. They are separate apps: the Play build `kr.potatosalad775.unipeq` (Play
  app-signing key) and the GitHub build `kr.potatosalad775.unipeq.sideload` (its own key), so
  the file has one statement per package. Without uniPEQ, or with a Worker that isn't verified (an operator's own), the
  URL opens the landing page, which shows the code and an **Open uniPEQ** intent link for that
  server.
- **Typed code:** uniPEQ's EQ menu has **Link with modernGraphTool**, which opens a sheet with one
  field. It accepts a code or a pasted link. Codes are normalized: uppercase, I and L read as 1, O
  as 0, spaces and dashes dropped. A typed code joins uniPEQ's default server. If an mGT site uses
  another server, it shows a hint next to the code to use the QR code or link. This also works in
  uniPEQ on the web, for example a second desktop browser.

mGT renders the QR code itself, through a small QR library behind a dynamic `import()`, so it
works under any site's content security policy and stays out of mGT's boot bundle.

### 2.3 Approval

- uniPEQ shows **Link with `<host>`?**, where `<host>` comes from mGT's attested `Origin` (the
  peer in `welcome` or `peer-joined`). It shows `squig.link`, not mGT's own claim of its name.
  The site title from mGT's `hello`, if any, appears below it as secondary text. If the server
  isn't uniPEQ's default, the dialog adds "via `<server host>`", because only the default server's
  attestation is trusted.
- The answer goes over the DataChannel (Phase 0 consequence 4). If the user answers before the
  channel opens, uniPEQ keeps the answer and sends it when the channel opens.
- **Approve** starts the link service (5.1) and sends `approval: approved`, then the full
  snapshot. **Don't link** sends `bye: denied`, and uniPEQ leaves the room.
- Until it approves, uniPEQ answers only `hello`, `ping` and `bye`. Everything else gets
  `approval: pending`.
- An approval lasts for the session, which is keyed by mGT's peer id. A rejoin with the same peer
  id, including an mGT reload (4.6), doesn't ask again. A new peer id is a new session.
- If uniPEQ is already linked and another link arrives, it asks "End the link with `<host A>` and
  link with `<host B>`?". Yes sends `bye: replaced` to the old peer.

## 3. Session lifecycle

```
mGT:    idle → waiting (code shown) → connecting → awaiting approval → linked ⇄ stalled → ended
uniPEQ: idle → joining → awaiting approval (dialog) → linked ⇄ waiting for mGT → ended
```

- **Start:** the first `eq` after approval starts the shared list. mGT asks which list wins if
  they differ (6.3).
- **Unlink** from either side sends `bye: unlink`, closes the peer connection and the WebSocket,
  and the room disappears. uniPEQ's notification has an **Unlink** action too.
- **mGT goes silent:** uniPEQ ends the session after **10 minutes** without any message from mGT,
  but only while uniPEQ itself isn't in front. While the user is in uniPEQ, mGT's silence costs
  nothing, so the clock doesn't run. A late end in Doze is harmless; it only leaves the
  notification up longer.
- **mGT's page closes:** mGT sends `away` on `pagehide`, best effort. uniPEQ then waits 30 s for a
  rejoin, which is long enough for a reload, and ends the session after that. `pagehide` can't
  tell a reload from a close, so mGT never sends `bye` from it.
- **uniPEQ goes away:** Unlink, denial, the grace period, or the task swiped away. The service's
  `onTaskRemoved` ends the session, because the WebView dies with the activity. mGT shows
  "stalled" after 15 s and "ended" after the same 10 minutes of silence, by which time uniPEQ has
  ended too.
- **Nothing is stored past the session**, as before. The one exception is uniPEQ's crash marker
  for the self-check (5.3), which holds no pairing.

## 4. Wire protocol

### 4.1 Channel and framing

- One DataChannel, `negotiated: true, id: 0`, label `peq-link`, ordered and reliable. The probe's
  setup carries over: neither side waits for `ondatachannel`.
- Every message is one JSON text frame `{ "t": "<type>", ... }`, under 64 KiB, the same limit as
  the signaling relay. The largest message is `device`, which carries an eqcaps profile of a few
  KB.
- Units are eqcaps': Hz, dB, RBJ Q, and type codes `PK LSC HSC LPQ HPQ BP NO AP`.
- **Unknown message types and unknown fields are ignored**, so minor versions can add both.

### 4.2 Versioning

Both `hello`s carry `proto: [major, minor]`, currently `[1, 0]`.

- **Different major:** both sides send `bye: version` with their own `proto` and close. The UI
  names the app to update: "uniPEQ is older than this site's link" or "Update modernGraphTool".
- **Same major:** features from a higher minor are used only when both minors have them
  (`min(minor)`). A command the other side doesn't know gets `re: { ok: false, code:
'unsupported' }`.
- The major goes up only when an existing message changes meaning. Additions bump the minor.

### 4.3 Messages

| Type       | Direction    | Body                                                                                           | When                                    |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| `hello`    | both         | `proto`, `app` (`mgt`/`unipeq`), `version`, mGT: `site?`, `lastRev`, `dirty`                   | First message on every channel open     |
| `approval` | uniPEQ → mGT | `state`: `pending` / `approved`                                                                | After `hello`; on approval              |
| `bye`      | both         | `reason`: `unlink` / `denied` / `version` / `timeout` / `replaced`                             | Session ends                            |
| `away`     | mGT → uniPEQ | —                                                                                              | `pagehide`                              |
| `ping`     | mGT → uniPEQ | `n`                                                                                            | Every 5 s                               |
| `pong`     | uniPEQ → mGT | `n`                                                                                            | From the `ping` handler                 |
| `edit`     | mGT → uniPEQ | `seq`, `ops[]`, `burst?`, `settle?`                                                            | mGT's edits, at most every 50 ms        |
| `eq`       | uniPEQ → mGT | `rev`, `eq`, `ack`, `by` (`mgt`/`unipeq`/`device`), `burst?`, `fresh?`                         | After every change, at most every 50 ms |
| `device`   | uniPEQ → mGT | `null`, or `name`, `kind`, `profile`, `profileSource`, `profileId`, `identity`, `capabilities` | On approval and on any device change    |
| `status`   | uniPEQ → mGT | see 4.5                                                                                        | On any change                           |
| `cmd`      | mGT → uniPEQ | `id`, `name`, `args?`                                                                          | Buttons in mGT                          |
| `re`       | uniPEQ → mGT | `id`, `ok`, `code?`                                                                            | When the command finishes               |
| `notice`   | uniPEQ → mGT | `kind: 'paused'`, `cause`, `ms`                                                                | Self-check (5.3)                        |

The shared list:

```ts
interface LinkEq {
	filters: Filter[]; // eqcaps Filter: { type, freq, q, gain }, in band (slot) order
	preamp: number; // the value in effect: derived while autoPreamp is on
	autoPreamp: boolean;
}

type EditOp =
	| { op: 'band'; i: number; filter: Filter } // replace band i
	| { op: 'list'; filters: Filter[] } // replace the whole list
	| { op: 'preamp'; db: number } // a fixed preamp; turns Auto off
	| { op: 'auto-preamp'; on: boolean };
```

Examples:

```json
{ "t": "edit", "seq": 41, "burst": "g17", "ops": [
	{ "op": "band", "i": 3, "filter": { "type": "PK", "freq": 2400, "q": 1.4, "gain": -3.5 } }
] }
{ "t": "edit", "seq": 42, "burst": "g17", "settle": true, "ops": [] }
{ "t": "eq", "rev": 108, "ack": 42, "by": "mgt", "burst": "g17",
	"eq": { "filters": [], "preamp": -3.2, "autoPreamp": true } }
{ "t": "cmd", "id": 7, "name": "switch", "args": { "value": "p2" } }
{ "t": "re", "id": 7, "ok": true }
```

### 4.4 Keeping the list in step

**uniPEQ** (authority):

1. Applies each `edit`'s ops in order to its current list, through `eqStore`. A `band` op is
   projected onto its slot (`editFilter`), exactly as a local edit is. A `band` op past the end
   of the list is dropped, because the list changed shape under it. Ops apply only while
   `editable` (4.5); otherwise uniPEQ just answers with `eq`, which puts mGT back.
2. Records them as one undo step per `burst` (coalesce key `link:<burst>`).
3. Bumps `rev` and broadcasts `eq` with `ack` = the last mGT `seq` applied. Broadcasts are
   throttled to one per 50 ms, always the latest state, and always one after the last change.
4. On `settle`: if auto-write is on, plans and writes **now, in this handler** (Phase 0
   consequence 2). A plan that needs review pauses as usual (4.5). Without a `settle` (mGT froze
   mid-gesture), uniPEQ's own auto-write delay still writes eventually.
5. Its own edits go out the same way, with `by: 'unipeq'` and their own `burst`. A read on connect
   or on a preset switch (`eqStore.open`) goes out with `by: 'device', fresh: true`.

**mGT** (optimistic):

1. Applies its own edits locally at once and sends them with `seq + 1`. Within a 50 ms window it
   merges `band` ops on the same index and keeps the latest. A `list` op replaces everything
   pending. Gestures (a drag, a slider, a held key) share a `burst` id and end with `settle`.
   AutoEQ, a loaded preset, add or remove, undo and redo send one `list` op with `settle`.
   Keyboard nudges settle after 700 ms idle, which is mGT's current auto-write delay.
2. On `eq` with `ack` below its last sent `seq`: an edit of its own is still in flight and will
   overwrite this, so mGT only records `rev`.
3. On `eq` with `ack` equal to its last `seq`: adopts `eq` if it differs from the local list. That
   covers uniPEQ's edits and uniPEQ's slot projection. A remote change is one undo step,
   coalesced by `burst`. A `fresh` one is an undo barrier in mGT too, since undoing past it would
   hand the device another device's or preset's bands (uniPEQ's rule 3).

This converges because uniPEQ always sends one `eq` after the last change it applied, and that
`eq` acknowledges mGT's last `seq`. Two people editing the same band at the same moment keep the
change uniPEQ applied last. Edits to different bands both survive. Whole-list ops overwrite, which
is what AutoEQ or loading a preset means.

### 4.5 Device status and commands

`device` describes uniPEQ's connected device, or `null` when there's none:

- `kind`: `hid`, `serial`, `ble` or `demo`.
- `profileSource`: `device`, `group`, `guess` or `demo`.
- `profile`: the full eqcaps profile, so mGT fits, flags and bounds AutoEQ with exactly
  uniPEQ's profile, whatever eqcaps versions the two apps ship.
- `capabilities`: mGT's `PeqCapabilities` subset, including `slots`.

Demo, guessed and experimental devices all link.

`status` carries what mGT's status line and controls need, as structured fields. Each app renders
its own sentences in its own languages:

```ts
interface LinkStatus {
	connected: boolean;
	knownDevice: string | null; // still named after a disconnect
	editable: boolean; // uniPEQ's canEdit: connected and not waiting to reconnect
	activeSlot: number | null;
	deviceSlot: number | null;
	eqEnabled: boolean | null;
	busy: 'read' | 'write' | 'switch' | 'connect' | null;
	inSync: boolean | null;
	unwritten: boolean;
	needsReconnect: boolean;
	auto: { on: boolean; pending: boolean; paused: boolean; stopped: boolean; clipRisk: boolean };
	failure: { op: string; code: string } | null; // eqcaps BridgeError code
	review: { rev: number; changes: PlanChange[]; clipRisk: boolean; infeasible: boolean } | null;
}
```

Commands (`cmd.name`):

| Command      | Args                           | uniPEQ does                                                                    |
| ------------ | ------------------------------ | ------------------------------------------------------------------------------ |
| `read`       | —                              | Reads the target preset into the list (an undo step), as its Read button does  |
| `write`      | —                              | Plans a write; writes it, or sets `status.review`                              |
| `review`     | `rev`, `accept`                | Answers the review. If `rev` moved since the plan, re-plans instead of writing |
| `switch`     | `value` (`p<id>`, `on`, `off`) | Device EQ, as `switchTo`, including its read of the new preset                 |
| `fit`        | —                              | `fitFilters` (an edit, so it syncs)                                            |
| `reconnect`  | —                              | Reconnects a `disconnectOnSave` device or a dropped one                        |
| `auto-write` | `on`                           | Sets uniPEQ's auto-write setting (one setting, kept in one place)              |

- A command that touches the device holds a short wake lock (5.2) and answers `re` when it's done.
  Its effects arrive as `eq`, `status` and `device`, not in `re`.
- A review shows on both sides, and either side's answer closes both dialogs. `PlanChange` has the
  same shape in both apps; uniPEQ's `push-plan.ts` is a copy of mGT's.

### 4.6 Resync

Every channel open, including the first, a rebuild after `fresh` and a reload, starts with
`hello`. After approval, uniPEQ answers with `device`, `status` and `eq`. Every message from
uniPEQ is a full snapshot, so nothing is replayed.

mGT keeps `lastRev`, the last `eq` it adopted, and `dirty`, meaning it has edits uniPEQ never
acknowledged. On the new `eq`:

- If `dirty` and `eq.rev == lastRev`, nothing changed in uniPEQ meanwhile, so mGT sends its
  current list as one `list` op with `settle`.
- Otherwise mGT adopts uniPEQ's list. If both changed while apart, uniPEQ's change wins.

**An mGT reload resumes the session.** mGT keeps `{ server, room, peerId }` in `sessionStorage`,
which survives a reload in the same tab. The page rejoins with the same peer id, so the Worker
replaces the old socket without `peer-left`. uniPEQ keeps the approval, and mGT, whose
`RTCPeerConnection` is gone, sends `fresh`, following the probe's rejoin rules. mGT's list after a
reload isn't `dirty`, so it adopts uniPEQ's.

### 4.7 Liveness and timing

mGT decides whether the link is alive. WebRTC's state stays `connected` while uniPEQ's page is
frozen, and uniPEQ's timers drift by seconds in Doze (Phase 0 consequence 3). **Any message from
uniPEQ counts as alive.**

| Constant     | Value      | Side   | Why                                                                                                                     |
| ------------ | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `PING_MS`    | 5 s        | mGT    | The Phase 0 interval. In 75 min of deep Doze every ping was answered (900 of 900)                                       |
| `STALL_MS`   | 15 s       | mGT    | Silence before "uniPEQ isn't answering": three pings, 2.5× the longest Doze gap measured (5.8 s)                        |
| `COMMAND_MS` | 20 s       | mGT    | A command's `re` may wait on USB round trips in Doze and on a device saving                                             |
| `END_MS`     | 10 min     | both   | Grace period (3)                                                                                                        |
| `AWAY_MS`    | 30 s       | uniPEQ | Time to rejoin after `away`: covers a reload                                                                            |
| `SEND_MS`    | 50 ms      | both   | At most 20 `edit` or `eq` messages per second during a drag, latest wins                                                |
| `SETTLE_MS`  | 700 ms     | mGT    | Keyboard nudges settle after this much idle time (mGT's auto-write delay)                                               |
| `GAP_MS`     | 30 s       | uniPEQ | Self-check: a timer gap this long isn't Doze drift (≤ 5.8 s measured), it's a pause                                     |
| `WAKE_MS`    | 10 s       | uniPEQ | Wake lock timeout per device command                                                                                    |
| keepalive    | 25 s       | both   | The signaling WebSocket's `ping`, as now                                                                                |
| backoff      | 1 s → 30 s | both   | Signaling reconnects, **reset and retried at once** on `visibilitychange` to visible, `pageshow`, `resume` and `online` |

- When mGT's own page comes back (`visible`, `resume`), it restarts its silence clock and pings at
  once. Time mGT spent hidden or frozen isn't uniPEQ's silence.
- "Stalled" is a status, not an end. mGT keeps applying edits locally (the list is `dirty`), keeps
  pinging, and resyncs on the first answer.

ICE and signaling follow the probe's rules as fixed in Phase 0:

- mGT is the offerer, because it sees `peer-joined`.
- On `failed`, the offerer restarts ICE and the answerer signals `restart`.
- A `peer-joined` with a known peer id is a rejoin and changes nothing. The rejoining side sends
  `fresh` only if its own end is dead.
- `peer-left` is advisory.
- The signaling WebSocket stays open for the whole session, so restarts and rebuilds can signal.
  A hibernating room costs nothing.

## 5. uniPEQ

### 5.1 The link service (Android)

A small Capacitor plugin in the app module, `Link`, separate from `native/device-io` because that
plugin stays protocol-free and link-free:

| Call / event                 | What it does                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `start({ host, device })`    | Starts `LinkService` (foreground, `connectedDevice`) and turns keep-visible on |
| `update({ host, device })`   | Updates the notification ("Linked with squig.link · FiiO KA17")                |
| `stop()`                     | Stops both                                                                     |
| `wake({ ms })` / `release()` | A partial wake lock with a timeout (5.2)                                       |
| `state()`                    | `{ backgroundRestricted }` (`ActivityManager.isBackgroundRestricted()`)        |
| `unlink` event               | The notification's Unlink action                                               |

- **Started at approval, which happens in the foreground**, so Android's limits on starting a
  foreground service from the background don't apply. It stops at session end and in
  `onTaskRemoved`. Pending, unapproved sessions don't keep uniPEQ alive (2.1 step 5).
- **Keep-visible is a `MainActivity` change.** While on, after `onStop`, it calls
  `dispatchWindowVisibilityChanged(View.VISIBLE)` on the bridge's WebView and repeats that every
  5 s, because the framework sends GONE again on later relayouts. Off restores the window's real
  visibility. It's the Phase 0 overlay's `LinkProbeVisibility`, moved into `MainActivity`.
- **Permissions:** `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`,
  `CHANGE_NETWORK_STATE` (Android 14+ requires one of a short list for `connectedDevice`, and
  this normal permission is enough), `POST_NOTIFICATIONS` (asked at the first approval; if it's
  refused, the service still runs) and `WAKE_LOCK`.
- **Play:** a `connectedDevice` foreground service needs a declaration and justification in the
  Play Console.
- **A consequence of keep-visible:** while linked, `document.visibilityState` stays `visible` in
  the background. uniPEQ code that asks "is the app in front" uses Capacitor's `appStateChange`
  instead. That includes USB auto-connect "while the app is in view", the release check on resume
  and the grace clock (3). Animations that would run in the background, such as the sync bar's
  countdown ring, stop when `appStateChange` says the app is in the background.

The debug overlay (`android-debug/`) is replaced by this. Remove it with `npm run overlay:remove`
once the service exists.

### 5.2 Handling messages

- **Event-driven.** Device work runs in the handler of the message that asked for it: `settle`,
  `cmd`. It never runs behind a uniPEQ `setTimeout` or debounce, because messages wake the CPU
  and timers don't.
- **A wake lock around each device command.** Whether a real USB write finishes in deep Doze
  before the CPU sleeps again is untested (no DAC in Phase 0). Holding a partial wake lock
  (`WAKE_MS`, released when the command ends) costs next to nothing, while a failure would be
  silent, so it's built in from the start rather than added after a failure. The first hardware
  run checks it (9).
- On the web there's no service. A desktop browser tab follows the same event-driven rules.

### 5.3 Self-check

uniPEQ reports a pause instead of failing silently (Phase 0 consequence 7):

| Signal                                                    | Means                                                   | `cause`   |
| --------------------------------------------------------- | ------------------------------------------------------- | --------- |
| `resume` after `freeze` while linked                      | Chromium froze the page; keep-visible didn't hold       | `frozen`  |
| `visibilitychange` to `hidden` while keep-visible is on   | Keep-visible lost (another brand, a WebView change)     | `hidden`  |
| A 1 s timer gap over `GAP_MS`                             | The whole process stopped (app freezer, battery limits) | `stopped` |
| On launch, a crash marker from a session that never ended | Android killed uniPEQ while linked                      | —         |
| `backgroundRestricted` at approval                        | The Restricted battery setting is on: pauses are likely | —         |

- A pause is sent as `notice: paused` with its duration. mGT shows "uniPEQ was paused for 42 s by
  Android" in its status line.
- uniPEQ shows a one-time banner with **Battery settings**, which opens the app's settings page
  (`ACTION_APPLICATION_DETAILS_SETTINGS`). uniPEQ doesn't use
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`,
  which Play restricts.
- The crash marker is `{ room, since }` in `localStorage`, written at approval and cleared at
  session end.
- The 1 s timer only measures. It never drives device work.

### 5.4 UI

- **EQ menu:** **Link with modernGraphTool** opens the code sheet (2.2). While linked, it's
  replaced by **Unlink**.
- **While linked:** a link row above the sync bar: "Linked with squig.link", plus "Waiting for
  modernGraphTool" during mGT's silence. The editor stays fully usable. Remote edits animate in
  like local ones.
- **Approval dialog** (2.3) and the "go back to the browser" hint (2.1).
- Strings in `messages/{en,ko}.json`.

### 5.5 Code

The link code goes in `src/lib/link/`:

- Glue around the installed reference client (7.2).
- `link-store.svelte.ts`: session state, peer, approval.
- `link-service.svelte.ts`: the handlers. It applies edits through `eqStore`, runs commands
  through `devicePeqService` and broadcasts on changes.

The protocol core stays framework-free, like `device-peq/`. Capacitor calls stay in
`src/lib/platform/link.ts` and are no-ops on the web.

## 6. mGT

### 6.1 The "Link with uniPEQ" accordion

The accordion sits in the EQ tab and has these states:

- **Start:** **Link with uniPEQ**.
- **Waiting:** the code, the QR code, **Open uniPEQ** (Android only) and Cancel.
- **Approve in uniPEQ:** with **Open uniPEQ** again on Android.
- **Linked:** host app, device and Unlink.
- **Stalled:** "uniPEQ isn't answering. Open it on your phone".
- **Ended:** the reason (unlinked, denied, version, timed out), with **Link again**.

The link state lives in a store and a service installed once from `AppShell.onMount`, not in the
panel, because panels unmount on every switch.

### 6.2 The link as a PeqDevice connection

- Linking adds a `DeviceConnection` with `connectionType: 'link'`. Its `name`, `profile`,
  `profileSource` and `identity` come from uniPEQ's `device` message, so the Hardware EQ panel,
  the constraint swap, the Device EQ dropdown and the device popover work as they do for USB.
- mGT's `ProfileSource` gains `demo` and `ConnectionType` gains `link`.
- With no device in uniPEQ, there's no connection. The accordion says "Linked. No device in
  uniPEQ".
- `device-peq/link.ts`, next to `network.ts`, provides `LinkDevice implements PeqDevice`:
  - `pull` sends the `read` command.
  - `setEnabled` sends `switch`.
  - `currentSlot` comes from `status`.
  - `close` unlinks.
  - `push` isn't used, because uniPEQ writes from the shared list.
- `devicePeqService` branches on `connectionType === 'link'`:
  - Write sends `cmd: write`.
  - Mirrored `status.review` opens `DevicePeqPushDialog` from uniPEQ's plan, and its answer sends
    `cmd: review`.
  - mGT's own auto-write is off for a link. Its switch shows uniPEQ's setting and changes it
    with the `auto-write` command.
  - `devicePeqStore`'s flags (`isWriting`, `autoPaused`, `needsReconnect`, …) are set from
    `status`, so `panelStatus` picks the line as usual.
  - Errors use the same `describeDeviceError` codes.

### 6.3 Editing while linked

- **Prerequisite (mGT work):** `EQFilter.type` widens to eqcaps' types, and the graph draws every
  type. AutoEQ optimizes only the bands it can make and keeps the others in place, counting their
  response as fixed. A linked list may hold `HPQ` or `LPQ` bands from the device, and AutoEQ must
  not drop them.
- **The shared list is the list.** While linked:
  - mGT's channel scope is fixed to both ears, and per-band on/off is hidden.
  - Editing follows `status.editable`.
  - AutoEQ's band budget is the profile's band count minus the bands it keeps.
- **Link start, when the lists differ:** if mGT's list is empty, it takes uniPEQ's silently.
  Otherwise mGT asks once: **Use uniPEQ's EQ** or **Send this EQ to uniPEQ**.
  - Sending turns disabled bands into 0 dB bands and drops one-ear bands. The dialog says how many
    of each.
  - The choice is one undo step on both sides.
  - While the dialog is open, mGT doesn't join the shared list. It keeps only the latest `eq`.
  - The same question comes back if a device first connects in uniPEQ during a link.

### 6.4 Reconnecting and liveness

These rules are in the reference client, so mGT gets them by installing it (4.7):

- Signaling retries at once on `visible`, `pageshow`, `resume` and `online`.
- The silence clock restarts when mGT's own page resumes.
- "Stalled" after 15 s, "ended" after 10 min.
- `away` on `pagehide`, and `sessionStorage` resume after a reload.

### 6.5 Config

`GRAPHTOOL_CONFIG` gets `UNIPEQ_LINK: { ENABLE: true, SERVER: 'https://link.unipeq.com' }`.

- Unset means on, with `link.unipeq.com`.
- `ENABLE: false` hides the accordion.
- An operator's own Worker works for the typed code (with the hint in 2.2), the intent link and
  the landing page. It doesn't work for App Links, which are verified only for `link.unipeq.com`.
- Per mGT's rules, the key is documented in `customize-page.mdx` and the config generator, and
  appears in `defaults/config.js` only as a commented stub.

## 7. This repo

### 7.1 Worker changes

- **`GET /l/<CODE>`:** the landing page. It shows the code, **Open uniPEQ** (the intent link for
  this server) and install links (Google Play, GitHub releases). It's the App Link target and the
  intent link's fallback.
- **`/.well-known/assetlinks.json`:** one statement per package (2.2), each with its signing
  certificate's SHA-256. Served as a static asset.
- **The room code alphabet** lives in `client/protocol.ts`, which the Worker and the smoke test
  import, and in the Phase 0 probe (`public/probe/probe.js`, `public/probe/index.html`), which
  stays import-free.
- **The custom domain:** `wrangler.jsonc` gets
  `"routes": [{ "pattern": "link.unipeq.com", "custom_domain": true }]`. The `unipeq.com` zone
  is already on Cloudflare, so Wrangler creates the DNS record and certificate on deploy.
- The probe page stays as Phase 0 tooling and moves off `/` to `/probe/`.

### 7.2 The reference client

```
client/          Framework-free TypeScript, no dependencies: installed by mGT and uniPEQ
  protocol.ts    Message types and guards, PROTO, ROOM_ALPHABET, code normalization, links,
                 timings. No DOM: the Worker imports it too
  session.ts     Signaling + RTCPeerConnection + DataChannel: the probe's rejoin, fresh and
                 reconnect-on-visible rules, as a typed event emitter
  sync.ts        The shared-list rules: seq/ack/rev, op merging and throttling, resync (4.4, 4.6)
  liveness.ts    mGT's ping and silence clock (4.7), uniPEQ's grace clock (3)
  host.ts        mGT's side: startHost / resumeHost, hello and version, edits, commands, away
  joiner.ts      uniPEQ's side: startJoiner, approval gating, the handlers that touch the device
```

`host.ts` and `joiner.ts` hold the rules both apps must get identical (the handshake, version
check, approval gating, `bye`, `away`, command timeouts), so the apps' glue only binds stores and
UI to their events and handlers.

**Both apps install it as a git dependency**, the npm counterpart of a pub git dependency:
`"peq-link": "github:<owner>/peq_link_server#semver:^1.0.0"`. npm resolves the range against
this repo's tags, and the lockfile pins the exact commit. Nothing goes to the npm registry,
because the client isn't meant for other projects.

- **The package is this repo's root `package.json`.** npm can't install a subfolder of a git repo,
  so the root package becomes `peq-link`, stays `private: true` (a git dependency doesn't need
  publishing), and gets `"exports": { "./client": "./client/index.ts" }` and
  `"files": ["client"]`, so an install carries only `client/`.
- **No `prepare` script, so it ships TypeScript source.** With a `prepare` script, npm would
  install this repo's dev dependencies (Wrangler, Playwright) to build it inside every app's
  install. Both apps build with Vite, which compiles the source, and their type checks cover it.
  So `client/` must compile under both apps' settings: strict, DOM lib, no Node types.
- **Releases are tags.** `package.json`'s `version` and a `vX.Y.Z` tag go up together when
  `client/` changes. The package version tracks the code, and `PROTO` tracks the wire (4.2). A
  wire-breaking change bumps both majors.
- **The repo has to be on GitHub, readable by both apps' CI** (public, or a token). It's local
  only for now.
- **Across repos during development**, `npm install ../peq_link_server` or `npm link` is fine
  locally but never committed, for the same reason uniPEQ never commits a `file:` link to eqcaps:
  CI has no sibling checkout.
- The apps keep their own glue in `src/lib/link/`: stores, Capacitor and UI.
- A protocol change lands here first, gets a tag, then both apps bump. A deployed site that lags
  behind shows up in the `hello` version check, not as silent misbehaviour.
- **Tests:**
  - `npm run test:smoke` grows a protocol run. Two headless Chromium pages run the client as mGT
    and as uniPEQ with a fake device, through the real Worker. It covers handshake, approval
    gating, concurrent edits converging, `settle` triggering a write, resync after `fresh` and
    after an mGT reload, a major-version mismatch, and grace expiry with a shortened clock.
  - `sync.ts`, `liveness.ts` and `protocol.ts` have unit tests in `test/` (`node:test`, run
    directly by Node's type stripping).

## 8. Phase 0's open items

| Open item                                     | How the design covers it                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| USB write in deep Doze                        | A wake lock around each device command from the start (5.2); checked on the first hardware run |
| Restricted battery setting, other brands      | `backgroundRestricted` warning at approval, and the self-check's pause reports (5.3)           |
| Cross-device across networks                  | TURN is configured and relay works (1c); measured in step 6 of the build order (9)             |
| mGT hidden for minutes; same phone past 60 s  | Resync on return (4.6); uniPEQ keeps writing meanwhile, since it owns the list                 |
| "Open uniPEQ" fallback without uniPEQ (6c)    | The landing page (7.1); tested in step 6                                                       |
| Battery cost of keep-visible (not measured)   | Animations stop in the background (5.1); measured in step 6                                    |
| "Open uniPEQ" for the GitHub (sideload) build | Open: the intent link names the Play package, so a sideload-only phone gets the landing page   |

## 9. Build order

1. **This repo:** `client/` with unit tests and the smoke protocol run, the package fields and the
   first tag, the GitHub remote. Worker landing page, `assetlinks.json`, the probe moved to
   `/probe/`, and the `link.unipeq.com` custom domain.
2. **uniPEQ native:** `LinkService`, keep-visible in `MainActivity`, the `Link` plugin, the
   manifest (permissions, App Link filter, `unipeq://link`). Then remove the debug overlay.
3. **uniPEQ app:** link store and service, approval, pairing sheet, link row, self-check, the
   switch to `appStateChange`.
4. **mGT prerequisite:** widen filter types, and make AutoEQ keep the bands it can't make.
5. **mGT link:** `device-peq/link.ts`, the service branch, the accordion, the start dialog,
   config and docs.
6. **On a real phone, with a DAC:**
   - a write in natural deep Doze;
   - cross-network (2b, 2c) and desktop to desktop (2d);
   - Restricted battery;
   - the 6c fallback;
   - an mGT tab hidden for 5 and 15 minutes;
   - keep-visible's battery cost over an hour.

   Record the results in a `docs/phase-1.md`, as Phase 0 did.
