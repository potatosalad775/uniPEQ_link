#!/usr/bin/env node
// Smoke test against a running Worker (`npm run dev`, or a deployed one with --server):
//   1. signaling rules, with plain WebSocket clients;
//   2. a real DataChannel between two headless Chromium pages running public/probe.js.
//
//   node scripts/smoke.mjs [--server http://localhost:8787]

import { chromium } from 'playwright';

const i = process.argv.indexOf('--server');
const server = (i >= 0 ? process.argv[i + 1] : 'http://localhost:8787').replace(/\/+$/, '');
const wsBase = server.replace(/^http/, 'ws');

const room = () =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(8)),
		(b) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[b % 32]
	).join('');

let failures = 0;
function check(name, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

/** A signaling client that records every message and its close. */
function client(code, peer = crypto.randomUUID()) {
	const ws = new WebSocket(`${wsBase}/api/rooms/${code}?peer=${peer}`);
	const messages = [];
	const c = { ws, peer, messages, closed: null };
	ws.onmessage = ({ data }) => messages.push(JSON.parse(data));
	ws.onclose = ({ code: closeCode, reason }) => (c.closed = { code: closeCode, reason });
	return c;
}

async function until(predicate, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

// ── 1. Signaling ─────────────────────────────────────────────────────────────────────────────

{
	const notFound = await fetch(`${server}/api/rooms/lowercase`);
	check('bad room code is a 404', notFound.status === 404);
	const plain = await fetch(`${server}/api/rooms/${room()}?peer=${crypto.randomUUID()}`);
	check('plain GET is refused', plain.status === 426);

	const code = room();
	const a = client(code);
	await until(() => a.messages.length);
	check(
		'first peer gets a welcome with no peers',
		a.messages[0]?.type === 'welcome' && a.messages[0].peers.length === 0
	);
	check('welcome carries ICE servers', a.messages[0]?.iceServers?.length > 0);

	const b = client(code);
	await until(() => b.messages.length && a.messages.length > 1);
	check('second peer sees the first', b.messages[0]?.peers?.[0]?.id === a.peer);
	check(
		'first peer hears peer-joined',
		a.messages[1]?.type === 'peer-joined' && a.messages[1].peer.id === b.peer
	);
	check('origin is attested', typeof a.messages[1]?.peer?.origin === 'string');

	b.ws.send(JSON.stringify({ type: 'signal', data: { hello: 1 } }));
	b.ws.send(JSON.stringify({ type: 'chat', data: 'not relayed' }));
	await until(() => a.messages.length > 2);
	await new Promise((r) => setTimeout(r, 200));
	const relayed = a.messages.slice(2);
	check(
		'signal is relayed with its sender',
		relayed[0]?.type === 'signal' && relayed[0].from === b.peer && relayed[0].data.hello === 1
	);
	check('anything else is dropped', relayed.length === 1);

	const third = client(code);
	await until(() => third.messages.length);
	check(
		'third peer is refused',
		third.messages[0]?.code === 'room-full',
		JSON.stringify(third.messages)
	);
	third.ws.close();

	const before = a.messages.length;
	const b2 = client(code, b.peer);
	await until(() => b.closed && b2.messages.length);
	await new Promise((r) => setTimeout(r, 200));
	check('reconnect replaces the old socket', b.closed?.code === 4002, JSON.stringify(b.closed));
	check(
		'reconnect is not a leave or a join',
		a.messages.length === before,
		JSON.stringify(a.messages.slice(before))
	);

	b2.ws.close();
	await until(() => a.messages.length > before);
	check('leaving is announced', a.messages.at(-1)?.type === 'peer-left');
	a.ws.close();
}

// ── 2. DataChannel between two pages ─────────────────────────────────────────────────────────

{
	// mDNS host candidates don't always resolve between headless instances; real IPs keep this
	// deterministic. Phones run with the default (mDNS on), which Phase 0 measures.
	const browser = await chromium.launch({
		args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
	});
	try {
		const code = room();
		const host = await browser.newPage();
		const joiner = await browser.newPage();
		// The joiner's signaling goes through a proxy the test can cut, like a phone browser
		// losing its network in the background while the DataChannel lives on.
		const joinerSockets = [];
		await joiner.routeWebSocket(/\/api\/rooms\//, (ws) => {
			joinerSockets.push({ ws, server: ws.connectToServer() });
		});
		await host.goto(`${server}/?room=${code}`);
		await host.click('#join');
		await joiner.goto(`${server}/?room=${code}&join=1`);

		const summaries = async () =>
			Promise.all([host, joiner].map((p) => p.evaluate(() => window.__linkProbe?.summary())));
		let s = [];
		const end = Date.now() + 20000;
		while (Date.now() < end) {
			s = await summaries();
			if (
				s.every((x) => x?.channel === 'open' && x.pings.answered >= 1 && x.heartbeats.received >= 3)
			)
				break;
			await new Promise((r) => setTimeout(r, 250));
		}
		check(
			'DataChannel opens',
			s.every((x) => x?.channel === 'open'),
			s.map((x) => x?.pair?.key).join(' | ')
		);
		check(
			'heartbeats flow both ways',
			s.every((x) => x?.heartbeats.received >= 3)
		);
		check(
			'pings are answered both ways',
			s.every((x) => x?.pings.answered >= 1),
			s.map((x) => `${x?.pings.rttP50Ms} ms`).join(' / ')
		);

		// Signaling drops (the room announces peer-left) and comes back with the same peer id
		// (peer-joined). The channel was never down, so neither side may rebuild it.
		const events = (p) => p.evaluate(() => window.__linkProbe.export().events);
		const answeredBefore = (await summaries())[0].pings.answered;
		const { ws, server: upstream } = joinerSockets.at(-1);
		upstream.close();
		ws.close({ code: 4000, reason: 'test: network lost' });
		const rejoinEnd = Date.now() + 15000;
		let hostEvents = [];
		while (Date.now() < rejoinEnd) {
			hostEvents = await events(host);
			if (hostEvents.some((e) => e.kind === 'peer-rejoined')) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		check(
			'a signaling rejoin is announced as the same peer',
			hostEvents.some((e) => e.kind === 'peer-left') &&
				hostEvents.some((e) => e.kind === 'peer-rejoined')
		);
		let after = await summaries();
		for (const end = Date.now() + 15000; Date.now() < end; after = await summaries()) {
			if (after[0].pings.answered >= answeredBefore + 2) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		const rebuilt = [...hostEvents, ...(await events(joiner))].filter(
			(e) => e.kind === 'pc-created'
		).length;
		check(
			'the channel survives a signaling rejoin',
			after.every((x) => x.channel === 'open') &&
				after[0].pings.answered >= answeredBefore + 2 &&
				rebuilt === 2,
			`pc-created ${rebuilt}×, pings ${answeredBefore} → ${after[0].pings.answered}`
		);
	} finally {
		await browser.close();
	}
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
