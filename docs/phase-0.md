# Phase 0 — platform checks

The link between modernGraphTool (mGT, a web page) and uniPEQ (a Capacitor app) runs over one
WebRTC DataChannel, set up through this repo's signaling Worker. Before any protocol or UI work,
these questions needed answers on a real phone, because each one could change the design.

**Status: done (2026-10-12).** Everything below was measured on one phone: Galaxy S25+ (SM-S936N),
Android 17, Chrome 153, Android System WebView 153, with a Windows desktop running Chrome 153. The
raw probe logs stay local (`results/` is gitignored); this document is the record.

## Answers

| #   | Question                                                                          | Answer                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Does a DataChannel connect between Chrome and uniPEQ's WebView on the same phone? | **Yes**, directly, in under 0.5 s, on Wi-Fi and on mobile data alone. Relay-only works too.                                                                                                                           |
| Q2  | Does it connect between desktop Chrome and the phone?                             | **Yes** on the same Wi-Fi. Across networks (phone on mobile data) wasn't run.                                                                                                                                         |
| Q3  | Does Chrome's Local Network Access prompt or block WebRTC to a local peer?        | **No**, on Android or desktop.                                                                                                                                                                                        |
| Q4  | Does uniPEQ's WebView keep working in the background?                             | **Only with help.** Chromium freezes the hidden page 60 s after it's hidden, foreground service or not. A foreground service plus "keep-visible" keeps it running, screen off and in deep Doze. Timers drift in Doze. |
| Q5  | What happens to the DataChannel when mGT's Chrome tab goes to the background?     | Phone Chrome **loses its network 5 s after leaving the screen**. A link to another device dies within about 20 s; a link to uniPEQ on the same phone keeps working.                                                   |
| Q6  | Does an "Open uniPEQ" intent link open uniPEQ and hand it the room?               | **Yes**, warm (channel open 1.5 s after the tap) and cold (the room is in the launch URL).                                                                                                                            |
| Q7  | What `Origin` does the Worker see?                                                | Chrome: the page's own origin. uniPEQ's WebView: `https://localhost`.                                                                                                                                                 |

## Design consequences

1. **While linked, uniPEQ runs a foreground service (`connectedDevice`) and keeps its WebView
   "visible"** (`MainActivity` keeps reporting the window as visible). Both only while linked. The
   service keeps the process alive and keep-visible keeps the page running; each covers a
   different freeze.
2. **uniPEQ's link code is event-driven.** A device write runs in the handler of the message that
   asked for it, never behind a uniPEQ `setTimeout` or debounce. In deep Doze, incoming messages are
   handled on time but uniPEQ's timers can be seconds late.
3. **mGT checks that the link is alive, with its own timeout.** WebRTC's connection state stays
   `connected` while the far page is frozen, because the browser's network thread keeps answering
   ICE checks. Timeouts must allow answers that are several seconds late.
4. **Connect first, approve over the channel.** Phone Chrome loses its network 5 s after the user
   switches to uniPEQ, and approving takes longer than that. So uniPEQ joins and opens the channel
   as soon as the link arrives, then asks the user. The answer goes over the DataChannel, which
   keeps working between two apps on the same phone while Chrome is hidden. uniPEQ ignores EQ
   commands until approved. If a cold start misses the 5 s window, the handshake finishes when the
   user returns to mGT.
5. **Returning to mGT is a normal recovery path.** mGT reconnects signaling as soon as its page is
   visible again (and on `online`), not on a backoff timer. A peer that rejoins signaling with the
   same peer id keeps a live channel; only a dead one is rebuilt (through `fresh`). A session with
   mGT on a phone and uniPEQ on another device goes through this on every trip to the background.
6. **No permission step in mGT** for local networks, and the relay is a fallback, not the normal
   path: same-phone links are direct even on mobile data.
7. **uniPEQ reports when it was paused anyway.** Other brands, the Restricted battery setting and
   long sessions weren't covered (see "Not tested"); a self-check in the real build tells the user
   instead of failing silently.

## Findings

### Q1–Q3: connectivity

Host = the probe page that created the room; joiner = the other side. Times and RTT are the host's.

| Run | Host           | Joiner              | Network          | Relay only | Connected? | Time to open | Pair (local/remote)                     | RTT p50 | LNA prompt? |
| --- | -------------- | ------------------- | ---------------- | ---------- | ---------- | ------------ | --------------------------------------- | ------- | ----------- |
| 1a  | Phone Chrome   | uniPEQ (same phone) | Wi-Fi            | no         | yes        | 0.43 s       | host/host, UDP                          | 4 ms    | no          |
| 1b  | Phone Chrome   | uniPEQ (same phone) | Mobile data only | no         | yes        | 0.39 s       | host/prflx, UDP                         | 4 ms    | no          |
| 1c  | Phone Chrome   | uniPEQ (same phone) | Wi-Fi            | yes        | yes        | 0.49 s       | relay/relay, UDP                        | 18 ms   | no          |
| 2a  | Desktop Chrome | uniPEQ              | Same Wi-Fi       | no         | yes        | 0.98 s       | relay/relay, then host/prflx after 10 s | 10 ms   | no          |

- On mobile data the same-phone pair is still direct: Chrome hides local IPs behind mDNS names,
  but the WebView's checks arrive anyway and show up as a peer-reflexive (`prflx`) candidate.
- In 2a, ICE picked a relay pair first and moved to the direct pair 10 s later. The relay costs a
  little at the start of a session even when it isn't needed.
- An earlier 1a run hosted in Samsung Internet 30 behaved the same (host/host, 0.7 s, RTT 5 ms).

### Q4: uniPEQ in the background

Host = desktop Chrome, so the side measuring never goes to the background. uniPEQ joins, then goes
to the background.

**What freezes it:**

- **Without a foreground service**, Android's app freezer stops uniPEQ's process; nothing in it
  runs until it comes back to the front.
- **With a foreground service** (`connectedDevice`, ongoing notification) the process stays alive,
  but **Chromium inside the WebView freezes the hidden page 60 s after it goes hidden**, every time.
  It fires the Page Lifecycle `freeze` event, and nothing runs after it (no timers, no message
  handlers). Android's event log shows no `am_freeze` during this; it's Chromium, not Android.
- **The other side doesn't notice.** For the whole freeze the host's connection stayed
  `connected` and the channel `open`, because WebRTC's network thread kept answering ICE checks.

**What prevents the freeze** (each with the foreground service on; 150 s runs, desktop host):

| Variant      | What it does                                                          | Froze?         | Heartbeats | Pings lost | uniPEQ reports | Shippable?                                          |
| ------------ | --------------------------------------------------------------------- | -------------- | ---------- | ---------- | -------------- | --------------------------------------------------- |
| baseline     | service only                                                          | yes, at 60 s   | 61/151     | 16         | hidden         | —                                                   |
| lock         | the page holds a Web Lock                                             | yes, at 60 s   | 31/151     | 15         | hidden         | —                                                   |
| audio-silent | an AudioContext playing zeros                                         | yes, at 60 s   | 61/151     | 15         | hidden         | —                                                   |
| audio-quiet  | a 20 Hz tone at -60 dBFS (Chromium spares pages it considers audible) | no             | 151/151    | 0          | hidden         | no: plays into the user's DAC, holds the audio path |
| keep-visible | the native side keeps telling the WebView its window is visible       | **no**, 3 of 3 | 151/151    | 0          | **visible**    | **yes**: a small `MainActivity` change              |

Keep-visible also thaws a page that's already frozen.

**Screen off and Doze** (keep-visible unless noted):

| Run                                       | Doze state            | Froze?       | Heartbeats on time | Pings answered | Max heartbeat gap |
| ----------------------------------------- | --------------------- | ------------ | ------------------ | -------------- | ----------------- |
| baseline, screen off, 150 s               | not dozing (charger)  | yes, at 60 s | 61/153             | 12 (16 lost)   | 1.4 s             |
| screen off, 150 s                         | not dozing (charger)  | no           | 153/153            | 30 of 30       | 1.0 s             |
| screen off, 30 min                        | not dozing (charger)  | no           | 1804/1803          | 360 of 360     | 1.1 s             |
| baseline, forced deep Doze, 150 s         | deep idle (forced)    | yes, at 60 s | 61/154             | 12 (17 lost)   | 1.8 s             |
| forced deep Doze, 150 s                   | deep idle (forced)    | no           | 155/154            | 31 of 31       | 1.0 s             |
| **on battery, still, screen off, 75 min** | **reached deep idle** | **no**       | **2217/4501**      | **900 of 900** | **5.8 s**         |

- Turning the screen off changes nothing about the freeze: still 60 s without keep-visible, none
  with it.
- Forced Doze changes nothing either: the foreground service keeps network access.
- **Natural deep Doze delays timers, not messages.** Half of uniPEQ's 1 s heartbeats came late, but
  every ping was answered, and the longest gap (5.8 s) matches the host's 5 s ping interval. The
  likely explanation: in deep Doze the CPU sleeps, a JS timer can't wake it, and an incoming packet
  does. Not proven; when the gaps started wasn't recorded.

### Q5: mGT's tab in the background

Phone Chrome hosted, desktop Chrome joined, then the phone switched to another app for about 2 min.
Timings are from the moment the phone page went `hidden`:

| After  | What happened                                                                         |
| ------ | ------------------------------------------------------------------------------------- |
| 5 s    | The signaling WebSocket closed (1006). The desktop got `peer-left`.                   |
| 12 s   | ICE `disconnected` on both sides.                                                     |
| 22 s   | ICE `failed`. The phone page, still running, tried ICE restarts that couldn't signal. |
| 60 s   | Chromium froze the page (`freeze`), the same delay as uniPEQ's WebView.               |
| return | The page resumed (`resume`) without a reload.                                         |

- **Phone Chrome loses its network 5 s after leaving the screen.** Every hidden run showed the
  signaling socket closing at 5.0 s (Samsung Internet did the same). Reconnect attempts while hidden
  failed within a second each.
- **Traffic to an app on the same phone isn't cut.** In the Q6 warm run, Chrome stayed hidden for
  41 s with its signaling down, and uniPEQ's heartbeats and status reports kept arriving the whole
  time. That traffic never leaves the device. Hidden for longer than Chromium's 60 s freeze wasn't
  tested.
- Whether the cross-device channel recovers on return wasn't captured. The probe's recovery rules
  have changed since (see "Rejoining signaling" below), and the smoke test covers them.

### Q6: the "Open uniPEQ" link

`intent://link?server=…&room=…#Intent;scheme=unipeq;package=kr.potatosalad775.unipeq;S.browser_fallback_url=…;end`

| Run | uniPEQ state        | App opened? | Room received?                                                               | Back to Chrome                 |
| --- | ------------------- | ----------- | ---------------------------------------------------------------------------- | ------------------------------ |
| 6a  | running, background | yes         | yes, through `appUrlOpen`: joined 0.5 s after the tap, channel open at 1.5 s | the page was intact, no reload |
| 6b  | not running         | yes         | yes, in `App.getLaunchUrl()`                                                 | —                              |

In 6a the whole handshake finished while Chrome was already hidden, inside the 5 s before Chrome
lost its network. Whether Chrome showed a prompt before opening uniPEQ wasn't noted. The
not-installed fallback (6c) wasn't run.

### Q7: origins

The Worker attests the WebSocket upgrade's `Origin`: the probe page in Chrome shows the Worker's own
origin, and uniPEQ's WebView shows `https://localhost`. A native app could send any origin, so
it's a label for the approval dialog, not proof of identity.

### Rejoining signaling (a probe bug the Q6 run found)

After the user returned to Chrome in 6a, Chrome's signaling only came back 30 s later: the
reconnect backoff had grown to 30 s while it was hidden. Because the old socket had closed in
between, the room announced the return as `peer-joined`. uniPEQ treated that as a fresh session,
rebuilt its connection and broke a channel that was still working.

Fixed in `public/probe.js`: a `peer-joined` with the peer id already known is a rejoin
(`peer-rejoined`, nothing is rebuilt; the rejoining side sends `fresh` only if its own end is dead),
and signaling retries at once when the page becomes visible or comes back online.
`npm run test:smoke` cuts one side's signaling while the channel is up and checks the channel
survives; it fails without the fix.

## Not tested

Each of these is either covered by a design rule above or measured by the real build's self-check.

- **Q2 across networks** (2b, 2c) and desktop-to-desktop (2d). TURN is configured; the relay works
  (1c).
- **USB device I/O in the background.** No DAC was connected in any run, so the background
  `DeviceIo` calls only crossed the Capacitor bridge (2–10 ms) and listed zero devices. Whether a
  real write completes in deep Doze, before the CPU sleeps again, is open. If it doesn't, uniPEQ
  holds a short wake lock while it handles each message.
- **RTT under deep Doze**: pings were all answered, but their RTT wasn't recorded.
- **The Restricted battery setting, and other brands** (Xiaomi and others known to kill
  background apps).
- **mGT's tab hidden for 5 or 15 min, or with the screen off** (5b–5d), and a same-phone link with
  Chrome hidden past 60 s. Recovery on return covers both.
- **The "Open uniPEQ" fallback** when uniPEQ isn't installed (6c).

## Measurement pitfalls

- **`Dozing` isn't Doze.** `dumpsys power` reports `mWakefulness=Dozing` when the screen is off and
  the always-on display is drawing. Doze is `dumpsys deviceidle get deep`.
- **A phone on a charger never dozes**, wired or not. Natural deep Doze took about an hour
  unplugged, still and screen-off (`inactive_to` 30 min + `idle_after_inactive_to` 30 min on this
  phone). `dumpsys battery unplug` + `dumpsys deviceidle force-idle deep` forces it.
- **A faked unplug wakes a Samsung screen**, so unplug first, then turn the screen off.
- **A frozen page queues injected scripts.** Running the next experiment into a page an earlier one
  froze makes it silently do nothing. Bring uniPEQ to the front before each run. Early freeze times
  of 18–58 s came from runs like that; every clean run measured 60 s.
- **An attached DevTools session changes how a hidden page is throttled.** The driver detaches
  once the probe is running.
- **Wireless adb dies with Wi-Fi.** Mobile-data runs need USB.

## Tooling (to rerun any of this)

**Setup:**

1. `npm install`, `npx wrangler login`, `npm run deploy`. Phones need the public HTTPS origin, not
   `wrangler dev`.
2. Relay: Cloudflare dashboard → Realtime → TURN, create a key, then `npx wrangler secret put
TURN_KEY_ID` and `TURN_KEY_API_TOKEN`. Without them rooms offer STUN only. The probe's first
   `welcome` event says `turn: true` when the relay is configured.
3. uniPEQ debug overlay: `npm run overlay:apply`, then `npm run android` in `../uniPEQ`.
   `npm run overlay:remove` when done; it must never be committed to uniPEQ.

**The probe page** (the Worker's `/`) creates or joins a room and shows a live summary. Each side
sends a heartbeat every 1 s from a timer (gaps show throttled timers) and a ping every 5 s that the
other side answers from its message handler (shows whether incoming events still run). In uniPEQ,
every 10th heartbeat also times a `DeviceIo.list()` round trip. The page logs the ICE pair every
10 s, lifecycle events and connection states; **Download log** saves it as JSON.

**uniPEQ's side** (`scripts/android-link-probe.mjs`, over adb and DevTools):

```sh
npm run probe:android -- --server <origin> --room <CODE> --fgs --keep-visible  # join a room
npm run probe:android -- --server <origin> --arm --fgs --keep-visible           # wait for the deep link
npm run probe:android -- --dump results/<name>.json                             # save uniPEQ's log
npm run probe:android -- --stop --stop-fgs                                      # end the run
```

Same-phone runs need `--fgs`: without it Android freezes uniPEQ while you look at the browser, and
the injection waits until uniPEQ comes back (the driver gives up after 10 s). Each `--room`
replaces the probe already running in uniPEQ. Add `--relay` for relay-only.

**Freeze and Doze experiments** (`scripts/freeze-matrix.mjs`) run variants back to back with a
headless desktop host and read uniPEQ's events from logcat:

```sh
npm run probe:freeze-matrix -- --server <origin> [--only baseline,keep-visible] [--seconds 150]
  [--screen-off | --doze]
```

`--doze` fakes an unplugged charger and forces deep Doze for each run, then resets both. Each
result records the screen and Doze state, heartbeat gaps and ping RTT. With the screen off the
phone stays locked between runs, so put keep-visible last.

Read Android and WebView versions from adb (the user agent always says `Android 10; K`):
`adb shell getprop ro.build.version.release`,
`adb shell dumpsys package com.google.android.webview | grep versionName`.
