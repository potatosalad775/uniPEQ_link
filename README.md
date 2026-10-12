# peq_link_server

Signaling for the modernGraphTool ↔ uniPEQ link: a Cloudflare Worker with one Durable Object per
link session. It introduces the two apps, and from then on they talk directly over a WebRTC
DataChannel (or through a TURN relay when the networks don't allow a direct path).

It also holds the link's protocol as a reference client (`client/`), which both apps install as
a git dependency. Phase 0's platform checks are in [docs/phase-0.md](docs/phase-0.md), the design
in [docs/design.md](docs/design.md).

```sh
npm install
npm run dev          # http://localhost:8787 (the Phase 0 probe is at /probe/)
npm test             # client/ unit tests
npm run test:smoke   # in another terminal
npm run deploy       # phones need the deployed https origin
```
