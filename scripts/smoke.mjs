#!/usr/bin/env node
// Smoke test against a running Worker (`npm run dev`, or a deployed one with --server):
//   1. signaling rules, with plain WebSocket clients, and the static routes;
//   2. a real DataChannel between two headless Chromium pages running public/probe/probe.js;
//   3. the protocol: the reference client as mGT and as uniPEQ with a fake device.
//
//   node scripts/smoke.mjs [--server http://localhost:8787]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { newRoomCode as room } from '../client/protocol.ts';

const i = process.argv.indexOf('--server');
const server = (i >= 0 ? process.argv[i + 1] : 'http://localhost:8787').replace(/\/+$/, '');
const wsBase = server.replace(/^http/, 'ws');

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
	const typed = await fetch(`${server}/l/abcd-efgh`, { redirect: 'manual' });
	check(
		'a typed landing code redirects to the canonical one',
		typed.status === 301 && new URL(typed.headers.get('location')).pathname === '/l/ABCDEFGH'
	);
	const landing = await fetch(`${server}/l/ABCDEFGH`);
	const landingHtml = await landing.text();
	check(
		'the landing page shows the code, an intent link and the web app',
		landing.ok &&
			landingHtml.includes('ABCD-EFGH') &&
			landingHtml.includes('intent://link?') &&
			landingHtml.includes('?link=http')
	);
	check('a bad landing code is a 404', (await fetch(`${server}/l/ABCDEFGU`)).status === 404);
	const links = await fetch(`${server}/.well-known/assetlinks.json`);
	check(
		'assetlinks.json is served as JSON',
		links.ok &&
			links.headers.get('content-type')?.startsWith('application/json') &&
			Array.isArray(await links.json())
	);
	check('the probe is at /probe/', (await fetch(`${server}/probe/`)).ok);
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
		await host.goto(`${server}/probe/?room=${code}`);
		await host.click('#join');
		await joiner.goto(`${server}/probe/?room=${code}&join=1`);

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

// ── 3. The protocol, mGT ↔ uniPEQ ────────────────────────────────────────────────────────────

{
	const { outputFiles } = await build({
		entryPoints: [fileURLToPath(new URL('../client/index.ts', import.meta.url))],
		bundle: true,
		format: 'iife',
		globalName: 'PeqLink',
		write: false
	});
	const bundle = outputFiles[0].text;
	const harness = readFileSync(new URL('./smoke-page.js', import.meta.url), 'utf8');
	const browser = await chromium.launch({
		args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
	});
	const context = await browser.newContext();

	/** A page on the Worker's origin with the client loaded: what an app's page would be. */
	async function page(beforeLoad) {
		const p = await context.newPage();
		p.on('pageerror', (error) => console.log(`     page error: ${error.message}`));
		await beforeLoad?.(p);
		await load(p);
		return p;
	}
	async function load(p) {
		await p.goto(`${server}/probe/`);
		await p.addScriptTag({ content: bundle });
		await p.addScriptTag({ content: harness });
	}
	const state = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.fake.state)));
	async function waitFor(name, p, predicate, ms = 15000) {
		let s;
		for (const end = Date.now() + ms; Date.now() < end;) {
			s = await state(p);
			if (predicate(s)) return s;
			await new Promise((r) => setTimeout(r, 100));
		}
		check(name, false, `timed out: ${JSON.stringify(s).slice(0, 400)}`);
		return null;
	}
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

	try {
		// Handshake, approval gating, approval.
		const mgt = await page();
		// uniPEQ's signaling goes through a proxy the test can cut.
		const unipeqSockets = [];
		const unipeq = await page((p) =>
			p.routeWebSocket(/\/api\/rooms\//, (ws) => {
				unipeqSockets.push({ ws, upstream: ws.connectToServer() });
			})
		);
		const code = await mgt.evaluate((server) => window.setupHost(server), server);
		await unipeq.evaluate(([server, code]) => window.setupJoiner(server, code), [server, code]);

		let u = await waitFor('uniPEQ asks with the site', unipeq, (s) =>
			s.requests.some((r) => r.site)
		);
		if (u) {
			const request = u.requests.at(-1);
			check(
				'uniPEQ asks with the attested origin and the site title',
				request.host.origin === server && request.site === 'Smoke Graph',
				JSON.stringify(request)
			);
		}
		let m = await waitFor('mGT waits for approval', mgt, (s) => s.states.includes('approval'));
		check('mGT went waiting → connecting → approval', same(m?.states, ['connecting', 'approval']));

		// Before approval nothing reaches the device, even sent straight past HostLink's own gate.
		await mgt.evaluate(() =>
			window.fake.link.session.send({
				t: 'edit',
				seq: 1,
				ops: [{ op: 'band', i: 0, filter: { type: 'PK', freq: 9, q: 1, gain: 9 } }],
				settle: true
			})
		);
		await new Promise((r) => setTimeout(r, 500));
		u = await state(unipeq);
		m = await state(mgt);
		check(
			'an edit before approval is refused',
			u.applied === 0 && u.writes === 0 && m.states.at(-1) === 'approval'
		);

		await unipeq.evaluate(() => window.fake.link.approve());
		m = await waitFor('mGT links on approval', mgt, (s) => s.states.at(-1) === 'linked');
		u = await state(unipeq);
		check(
			"approval brings uniPEQ's device, status and list",
			m?.device?.name === 'Smoke DAC' && m.status?.connected === true && same(m.eq, u.eq)
		);
		check(
			"the first list is marked initial (mGT's start dialog)",
			same(m?.adopted, [{ by: 'unipeq', initial: true, fresh: false }])
		);

		// Concurrent edits: mGT drags band 0 while uniPEQ edits band 2.
		await Promise.all([
			mgt.evaluate(async () => {
				for (let i = 0; i < 15; i++) {
					window.fake.edit(
						[{ op: 'band', i: 0, filter: { type: 'PK', freq: 500 + i, q: 2, gain: -3 } }],
						{
							burst: 'drag'
						}
					);
					await new Promise((r) => setTimeout(r, 15));
				}
				window.fake.edit([], { burst: 'drag', settle: true });
			}),
			unipeq.evaluate(async () => {
				for (let i = 0; i < 5; i++) {
					window.fake.edit([
						{ op: 'band', i: 2, filter: { type: 'HSC', freq: 8000, q: 0.7, gain: i } }
					]);
					await new Promise((r) => setTimeout(r, 40));
				}
			})
		]);
		await new Promise((r) => setTimeout(r, 500));
		[m, u] = [await state(mgt), await state(unipeq)];
		check(
			'concurrent edits converge',
			same(m.eq, u.eq),
			JSON.stringify([m.eq, u.eq]).slice(0, 300)
		);
		check(
			'both edits survive',
			u.eq.filters[0].freq === 514 && u.eq.filters[2].gain === 4,
			JSON.stringify(u.eq.filters)
		);
		check('settle writes, once', u.writes === 1, `${u.writes} writes`);
		check('a drag is throttled', u.applied < 15, `${u.applied} ops applied for 15 moves`);

		const write = await mgt.evaluate(() => window.fake.link.command('write'));
		const unknown = await mgt.evaluate(() => window.fake.link.command('self-destruct'));
		check(
			'commands are answered, unknown ones as unsupported',
			write.ok && !unknown.ok && unknown.code === 'unsupported',
			JSON.stringify([write, unknown])
		);

		// Resync after `fresh`: uniPEQ's connection dies and its signaling drops. mGT keeps
		// editing; uniPEQ rebuilds on reconnect, and mGT's list goes over whole.
		const { eq: before, requests: asked } = await state(unipeq);
		await unipeq.evaluate(() => window.fake.link.session.connection.close());
		const { ws, upstream } = unipeqSockets.at(-1);
		upstream.close();
		ws.close({ code: 4000, reason: 'test: network lost' });
		await mgt.evaluate(() =>
			window.fake.edit(
				[{ op: 'band', i: 1, filter: { type: 'LSC', freq: 105, q: 0.7, gain: 5 } }],
				{
					settle: true
				}
			)
		);
		u = await waitFor(
			'uniPEQ gets the edit made while apart',
			unipeq,
			(s) => s.eq.filters[1].type === 'LSC',
			20000
		);
		m = await state(mgt);
		check(
			"after a rebuild mGT's list goes over whole, without asking again",
			u && same(m.eq, u.eq) && !same(u.eq, before) && u.requests.length === asked.length,
			`approval requests ${asked.length} → ${u?.requests.length}`
		);

		// An mGT reload resumes: same peer id, no new approval, uniPEQ's list adopted.
		await unipeq.evaluate(() =>
			window.fake.edit([{ op: 'band', i: 3, filter: { type: 'PK', freq: 6000, q: 4, gain: -6 } }])
		);
		await mgt.reload();
		await load(mgt);
		await mgt.evaluate((server) => window.setupHost(server, { resume: true }), server);
		m = await waitFor(
			'mGT resumes after a reload',
			mgt,
			(s) => s.states.at(-1) === 'linked',
			20000
		);
		u = await state(unipeq);
		check(
			"a reload resumes without approval and adopts uniPEQ's list",
			m &&
				same(m.eq, u.eq) &&
				u.requests.length === asked.length &&
				m.adopted.every((a) => !a.initial),
			JSON.stringify({ adopted: m?.adopted, requests: u.requests.length })
		);
		check(
			'the room code survives the reload',
			(await mgt.evaluate(() => window.fake.link.room)) === code
		);

		// Unlink from mGT ends both.
		await mgt.evaluate(() => window.fake.link.unlink());
		u = await waitFor('uniPEQ hears the unlink', unipeq, (s) => s.ended);
		check('unlink ends both sides', u?.ended.reason === 'unlink' && u.ended.by === 'peer');
		await Promise.all([mgt.close(), unipeq.close()]);
	} finally {
		// Separate sessions below.
	}

	try {
		// A major-version mismatch ends both sides, each knowing the other's version.
		const mgt = await page();
		const unipeq = await page();
		const code = await mgt.evaluate(
			(server) => window.setupHost(server, { proto: [2, 0] }),
			server
		);
		await unipeq.evaluate(([server, code]) => window.setupJoiner(server, code), [server, code]);
		const u = await waitFor('uniPEQ refuses another major', unipeq, (s) => s.ended);
		const m = await waitFor('mGT refuses another major', mgt, (s) => s.ended);
		check(
			'a major mismatch ends both with version',
			u?.ended.reason === 'version' &&
				m?.ended.reason === 'version' &&
				same(u.ended.peerProto, [2, 0])
		);
		await Promise.all([mgt.close(), unipeq.close()]);

		// Denial.
		const mgt2 = await page();
		const unipeq2 = await page();
		const code2 = await mgt2.evaluate((server) => window.setupHost(server), server);
		await unipeq2.evaluate(([server, code]) => window.setupJoiner(server, code), [server, code2]);
		await waitFor('uniPEQ asks', unipeq2, (s) => s.requests.length > 0);
		await waitFor('mGT awaits approval', mgt2, (s) => s.states.includes('approval'));
		await unipeq2.evaluate(() => window.fake.link.deny());
		const denied = await waitFor('mGT hears the denial', mgt2, (s) => s.ended);
		check(
			'denial ends mGT with denied',
			denied?.ended.reason === 'denied' && denied.ended.by === 'peer'
		);
		await Promise.all([mgt2.close(), unipeq2.close()]);

		// Grace: mGT's page goes away and never comes back; uniPEQ ends after awayMs.
		const mgt3 = await page();
		const unipeq3 = await page();
		const code3 = await mgt3.evaluate((server) => window.setupHost(server), server);
		await unipeq3.evaluate(
			([server, code]) =>
				window.setupJoiner(server, code, {
					foreground: false,
					timings: { awayMs: 1500, endMs: 20000 }
				}),
			[server, code3]
		);
		await waitFor('uniPEQ asks', unipeq3, (s) => s.requests.length > 0);
		await unipeq3.evaluate(() => window.fake.link.approve());
		await waitFor('mGT links', mgt3, (s) => s.states.at(-1) === 'linked');
		await mgt3.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await mgt3.close();
		const started = Date.now();
		const graced = await waitFor('uniPEQ ends after away', unipeq3, (s) => s.ended, 10000);
		const after = Date.now() - started;
		check(
			'uniPEQ ends a session mGT left, after awayMs',
			graced?.ended.reason === 'timeout' && graced.ended.by === 'self' && after < 3500,
			`${after} ms`
		);
		await unipeq3.close();
	} finally {
		await browser.close();
	}
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
