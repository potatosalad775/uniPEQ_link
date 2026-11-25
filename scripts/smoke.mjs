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
	const pk = (freq, gain = 0) => ({ type: 'PK', freq, q: 1, gain });

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

		// Both on the default proto: each side's minor is the newest, and set by `hello`.
		const proto = await mgt.evaluate(() => [...PeqLink.PROTO]);
		const seen = await Promise.all(
			[mgt, unipeq].map((p) =>
				p.evaluate(() => ({ minor: window.fake.link.minor, peerProto: window.fake.link.peerProto }))
			)
		);
		check(
			'on the default proto both sides share the newest minor and know the other proto',
			seen.every((x) => x.minor === proto[1] && same(x.peerProto, proto)) &&
				[m, u].every((x) => x?.hello?.minor === proto[1] && same(x.hello.proto, proto)),
			JSON.stringify({ proto, seen, hello: [m?.hello, u?.hello] })
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

		// A 1.3 command: it reaches uniPEQ's handler, and its effect comes back in `status`.
		const control = await mgt.evaluate(() =>
			window.fake.link.command('control', { id: 'gain', value: -3 })
		);
		m = await waitFor(
			'mGT sees the control in status',
			mgt,
			(s) => s.status?.controls?.gain === -3
		);
		u = await state(unipeq);
		check(
			'a 1.3 command round trip: control reaches uniPEQ and returns in status',
			control.ok && m?.status.controls.gain === -3 && u.controls.gain === -3,
			JSON.stringify({ control, mgt: m?.status.controls, unipeq: u.controls })
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

		// Two sides on different minors: both fall back to the lower one, and the newer side
		// leaves out what the older lacks.
		const link = async (hostOptions, joinerOptions) => {
			const mgt = await page();
			const unipeq = await page();
			const code = await mgt.evaluate(
				([server, options]) => window.setupHost(server, options),
				[server, hostOptions]
			);
			await unipeq.evaluate(
				([server, code, options]) => window.setupJoiner(server, code, options),
				[server, code, joinerOptions]
			);
			await waitFor('uniPEQ asks', unipeq, (s) => s.requests.length > 0);
			await unipeq.evaluate(() => window.fake.link.approve());
			await waitFor('mGT links', mgt, (s) => s.states.at(-1) === 'linked');
			await waitFor('mGT has the hello', mgt, (s) => s.hello);
			await waitFor('uniPEQ has the hello', unipeq, (s) => s.hello);
			return [mgt, unipeq];
		};
		const minors = (p) =>
			p.evaluate(() => ({ minor: window.fake.link.minor, peerProto: window.fake.link.peerProto }));
		const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

		// mGT is the older one (1.2).
		const [mgt4, unipeq4] = await link({ proto: [1, 2] });
		const [m4, u4] = [await minors(mgt4), await minors(unipeq4)];
		check(
			'mixed minors, mGT older: both settle on 2 and know the other proto',
			m4.minor === 2 && u4.minor === 2 && same(m4.peerProto, [1, 3]) && same(u4.peerProto, [1, 2]),
			JSON.stringify([m4, u4])
		);
		let [ms4, us4] = [await state(mgt4), await state(unipeq4)];
		check('mixed minors link rather than end', !ms4.ended && !us4.ended);

		const refused = await mgt4.evaluate(() =>
			window.fake.link.command('control', { id: 'gain', value: 1 })
		);
		await settle();
		us4 = await state(unipeq4);
		check(
			'a 1.3 command to an older uniPEQ is unsupported, and not sent',
			!refused.ok && refused.code === 'unsupported' && !us4.commands.includes('control'),
			JSON.stringify({ refused, commands: us4.commands })
		);

		// A busy value 1.3 added reaches an older mGT as null: after a real one, so the change
		// is seen.
		for (const busy of ['preset', 'control']) {
			await unipeq4.evaluate(() => window.fake.busy('write'));
			await waitFor('mGT sees busy write', mgt4, (s) => s.status?.busy === 'write');
			await unipeq4.evaluate((busy) => window.fake.busy(busy), busy);
			ms4 = await waitFor(`mGT sees busy ${busy} as none`, mgt4, (s) => s.status?.busy === null);
			check(
				`busy '${busy}' reaches an older mGT as null`,
				ms4?.status.busy === null,
				JSON.stringify(ms4?.status.busy)
			);
		}

		await mgt4.evaluate(() =>
			window.fake.replaceAll({ filters: [pk(111), pk(222)], preamp: -2, autoPreamp: false })
		);
		us4 = await waitFor('older uniPEQ gets the list', unipeq4, (s) => s.eq.filters.length === 2);
		check(
			'replaceAll to an older uniPEQ sends the list and preamp, no channels op',
			us4 &&
				us4.ops.some((o) => o.op === 'list') &&
				us4.ops.some((o) => o.op === 'preamp') &&
				!us4.ops.some((o) => o.op === 'channels' || o.ch),
			JSON.stringify(us4?.ops)
		);
		await Promise.all([mgt4.close(), unipeq4.close()]);

		// uniPEQ is the older one (1.2).
		const [mgt5, unipeq5] = await link({}, { proto: [1, 2] });
		const [m5, u5] = [await minors(mgt5), await minors(unipeq5)];
		check(
			'mixed minors, uniPEQ older: both settle on 2 and know the other proto',
			m5.minor === 2 && u5.minor === 2 && same(m5.peerProto, [1, 2]) && same(u5.peerProto, [1, 3]),
			JSON.stringify([m5, u5])
		);
		const noEq = await mgt5.evaluate(() => window.fake.link.command('eq', { id: null }));
		const write5 = await mgt5.evaluate(() => window.fake.link.command('write'));
		await settle();
		const us5 = await state(unipeq5);
		check(
			'a 1.3 command to an older uniPEQ is unsupported, and an older one still goes through',
			!noEq.ok && noEq.code === 'unsupported' && write5.ok && same(us5.commands, ['write']),
			JSON.stringify({ noEq, write5, commands: us5.commands })
		);
		await Promise.all([mgt5.close(), unipeq5.close()]);

		// Channels apart, both on 1.3.
		const apart = {
			filters: [pk(1000, 1), pk(2000, 2)],
			preamp: -4,
			autoPreamp: false,
			right: { filters: [pk(1100, -1), pk(2100, -2)], preamp: -5, autoPreamp: false }
		};
		const [mgt6, unipeq6] = await link({}, { eq: apart });
		let [ms6, us6] = [await state(mgt6), await state(unipeq6)];
		check(
			"uniPEQ's channels apart reach mGT",
			same(ms6.eq, apart) && same(us6.eq, apart),
			JSON.stringify(ms6.eq)
		);
		const adoptedBefore = ms6.adopted.length;

		// mGT edits the right channel only.
		const right0 = { type: 'PK', freq: 1500, q: 2, gain: 5 };
		await mgt6.evaluate(
			(filter) => window.fake.edit([{ op: 'band', i: 0, ch: 'right', filter }], { settle: true }),
			right0
		);
		us6 = await waitFor(
			'uniPEQ applies the right band',
			unipeq6,
			(s) => s.eq.right.filters[0].freq === 1500
		);
		await settle();
		ms6 = await state(mgt6);
		check(
			"mGT's right-channel edit changes uniPEQ's right and leaves the left",
			us6 &&
				same(us6.eq.right.filters[0], right0) &&
				same(us6.eq.right.filters[1], apart.right.filters[1]) &&
				same(us6.eq.filters, apart.filters) &&
				us6.eq.right.preamp === apart.right.preamp,
			JSON.stringify(us6?.eq)
		);
		check(
			"uniPEQ's acknowledgement leaves mGT as it is",
			same(ms6.eq, us6.eq) && ms6.adopted.length === adoptedBefore,
			JSON.stringify({ mgt: ms6.eq, adopted: ms6.adopted.length })
		);

		// uniPEQ edits the right channel: mGT adopts it, the channels still apart.
		await unipeq6.evaluate(() =>
			window.fake.edit([
				{ op: 'band', i: 1, ch: 'right', filter: { type: 'LSC', freq: 90, q: 1, gain: 2 } }
			])
		);
		ms6 = await waitFor(
			'mGT adopts the right band',
			mgt6,
			(s) => s.eq.right?.filters[1].type === 'LSC'
		);
		check(
			"uniPEQ's right-channel edit is adopted by mGT, the left untouched",
			ms6 && same(ms6.eq.filters, apart.filters) && ms6.adopted.length === adoptedBefore + 1,
			JSON.stringify(ms6?.eq)
		);

		// A list without `right` joins the channels, and the link stays up.
		const one = { filters: [pk(333), pk(444)], preamp: -1, autoPreamp: false };
		await mgt6.evaluate((eq) => window.fake.replaceAll(eq), one);
		us6 = await waitFor(
			'uniPEQ joins the channels',
			unipeq6,
			(s) => !s.eq.right && s.eq.filters[0].freq === 333
		);
		await settle();
		ms6 = await state(mgt6);
		check(
			'replaceAll without right joins the channels on uniPEQ',
			us6 &&
				same(us6.eq, one) &&
				same(ms6.eq, one) &&
				us6.ops.some((o) => o.op === 'channels' && o.apart === false),
			JSON.stringify({ unipeq: us6?.eq, mgt: ms6.eq })
		);
		check(
			'the session stays linked through it',
			ms6.states.at(-1) === 'linked' && !ms6.ended && !us6?.ended,
			JSON.stringify([ms6.states.at(-1), ms6.ended, us6?.ended])
		);
		await Promise.all([mgt6.close(), unipeq6.close()]);
	} finally {
		await browser.close();
	}
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
