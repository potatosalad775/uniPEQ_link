# peq_link_server

Signaling for the modernGraphTool ↔ uniPEQ link: a Cloudflare Worker with one Durable Object per
link session. It introduces the two apps, and from then on they talk directly over a WebRTC
DataChannel (or through a TURN relay when the networks don't allow a direct path).

Currently in **Phase 0**: platform checks on real phones. See [docs/phase-0.md](docs/phase-0.md).

```sh
npm install
npm run dev          # http://localhost:8787 — the probe page
npm run test:smoke   # in another terminal
npm run deploy       # phones need the deployed https origin
```
