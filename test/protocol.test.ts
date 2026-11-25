// Room codes, links and message parsing (design §2.2, §4.1).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	COMMAND_MINOR,
	COMMANDS,
	eqEqual,
	intentLink,
	landingUrl,
	webLink,
	WEB_LINK_PARAM,
	newLaunchToken,
	newRoomCode,
	normalizeRoomCode,
	parseMessage,
	parseRoomInput,
	PROTO,
	ROOM_CODE,
	sharedMinor,
	statusFor,
	type CommandName,
	type LinkChannel,
	type LinkEq,
	type LinkStatus
} from '../client/protocol.ts';

const server = 'https://link.unipeq.com';

describe('room codes', () => {
	it('makes valid codes', () => {
		for (let i = 0; i < 100; i++) assert.match(newRoomCode(), ROOM_CODE);
	});

	it('forgives look-alikes, case, spaces and dashes', () => {
		assert.equal(normalizeRoomCode(' abcd-efgh '), 'ABCDEFGH');
		assert.equal(normalizeRoomCode('io0l 1234'), '10011234');
		assert.equal(normalizeRoomCode('ABCDEFG'), null);
		assert.equal(normalizeRoomCode('ABCDEFGU'), null);
	});

	it('accepts a code, a landing link or the intent link', () => {
		assert.deepEqual(parseRoomInput('abcd-efgh', server), { server, room: 'ABCDEFGH' });
		assert.deepEqual(parseRoomInput('https://other.example/l/ABCD-EFGH', server), {
			server: 'https://other.example',
			room: 'ABCDEFGH'
		});
		assert.deepEqual(
			parseRoomInput('unipeq://link?server=https%3A%2F%2Fo.example&room=ABCDEFGH', server),
			{ server: 'https://o.example', room: 'ABCDEFGH' }
		);
		assert.equal(parseRoomInput('https://other.example/x/ABCDEFGH', server), null);
		assert.equal(parseRoomInput('unipeq://link?server=javascript:1&room=ABCDEFGH', server), null);
	});

	it('builds the QR target and the intent link', () => {
		assert.equal(landingUrl(`${server}/`, 'ABCDEFGH'), `${server}/l/ABCDEFGH`);
		assert.equal(
			intentLink(server, 'ABCDEFGH'),
			'intent://link?server=https%3A%2F%2Flink.unipeq.com&room=ABCDEFGH#Intent;scheme=unipeq;' +
				'S.browser_fallback_url=https%3A%2F%2Flink.unipeq.com%2Fl%2FABCDEFGH;end'
		);
	});

	it('builds the web link, which uniPEQ on the web reads back', () => {
		const href = webLink(server, 'ABCDEFGH', 'https://app.example/uniPEQ/');
		assert.equal(
			href,
			'https://app.example/uniPEQ/?link=https%3A%2F%2Flink.unipeq.com%2Fl%2FABCDEFGH'
		);
		const param = new URL(href).searchParams.get(WEB_LINK_PARAM) ?? '';
		assert.deepEqual(parseRoomInput(param, 'https://default.example'), {
			server,
			room: 'ABCDEFGH'
		});
		assert.match(
			webLink(server, 'ABCDEFGH'),
			/^https:\/\/potatosalad775\.github\.io\/uniPEQ\/\?link=/
		);
	});

	it('carries the launch token on the links mGT opens, and reads it back', () => {
		const launch = newLaunchToken();
		assert.match(launch, /^[0-9A-HJKMNP-TV-Z]{16}$/);
		assert.notEqual(launch, newLaunchToken());

		const intent = intentLink(server, 'ABCDEFGH', launch);
		assert.ok(
			intent.startsWith(
				`intent://link?server=https%3A%2F%2Flink.unipeq.com&room=ABCDEFGH&from=${launch}#`
			)
		);
		// The fallback is the landing page, which anyone can reach: no token.
		assert.ok(
			intent.endsWith('S.browser_fallback_url=https%3A%2F%2Flink.unipeq.com%2Fl%2FABCDEFGH;end')
		);
		const opened = intent.slice('intent://'.length, intent.indexOf('#'));
		assert.deepEqual(parseRoomInput(`unipeq://${opened}`, server), {
			server,
			room: 'ABCDEFGH',
			launch
		});

		const web = webLink(server, 'ABCDEFGH', 'https://app.example/uniPEQ/', launch);
		const param = new URL(web).searchParams.get(WEB_LINK_PARAM) ?? '';
		assert.deepEqual(parseRoomInput(param, server), { server, room: 'ABCDEFGH', launch });
	});

	it('finds no launch token on a QR link, a typed code or a malformed token', () => {
		assert.equal(parseRoomInput(landingUrl(server, 'ABCDEFGH'), server)?.launch, undefined);
		assert.equal(parseRoomInput('ABCDEFGH', server)?.launch, undefined);
		assert.deepEqual(parseRoomInput(`${server}/l/ABCDEFGH?from=nope`, server), {
			server,
			room: 'ABCDEFGH'
		});
	});
});

describe('parseMessage', () => {
	it('ignores unknown types and malformed frames', () => {
		assert.equal(parseMessage('{"t":"from-the-future"}'), null);
		assert.equal(parseMessage('not json'), null);
		assert.equal(parseMessage('{"t":"ping"}'), null);
		assert.equal(parseMessage(new ArrayBuffer(4)), null);
	});

	it('keeps unknown fields and unknown ops', () => {
		const m = parseMessage(
			JSON.stringify({ t: 'edit', seq: 1, ops: [{ op: 'future', x: 1 }], extra: true })
		);
		assert.ok(m && m.t === 'edit');
	});

	it('checks what handlers rely on', () => {
		const eq = {
			filters: [{ type: 'PK', freq: 1000, q: 1, gain: 2 }],
			preamp: 0,
			autoPreamp: true
		};
		assert.ok(parseMessage(JSON.stringify({ t: 'eq', rev: 1, ack: 0, by: 'mgt', eq })));
		const bad = { ...eq, filters: [{ type: 'PK', freq: 'x', q: 1, gain: 2 }] };
		assert.equal(
			parseMessage(JSON.stringify({ t: 'eq', rev: 1, ack: 0, by: 'mgt', eq: bad })),
			null
		);
		assert.equal(
			parseMessage(JSON.stringify({ t: 'edit', seq: 1, ops: [{ op: 'band', i: -1, filter: {} }] })),
			null
		);
		assert.ok(
			parseMessage(JSON.stringify({ t: 'hello', proto: [1, 3], app: 'mgt', version: '1' }))
		);
		assert.equal(parseMessage(JSON.stringify({ t: 'hello', proto: [1], app: 'mgt' })), null);
	});
});

const pk = (freq: number, gain = 0) => ({ type: 'PK', freq, q: 1, gain });
const channel = (...freqs: number[]): LinkChannel => ({
	filters: freqs.map((f) => pk(f)),
	preamp: 0,
	autoPreamp: false
});
const eqMessage = (eq: unknown) => JSON.stringify({ t: 'eq', rev: 1, ack: 0, by: 'mgt', eq });
const editMessage = (...ops: unknown[]) => JSON.stringify({ t: 'edit', seq: 1, ops });
const minorOf = (name: string) => COMMAND_MINOR[name as CommandName];

describe('proto 1.3 versions', () => {
	it('speaks 1.3, and shares the lower minor', () => {
		assert.deepEqual(PROTO, [1, 3]);
		assert.equal(sharedMinor([1, 3], [1, 0]), 0);
		assert.equal(sharedMinor([1, 3], [1, 2]), 2);
		assert.equal(sharedMinor([1, 3], [1, 3]), 3);
		// A newer peer: what it added after ours stays unused.
		assert.equal(sharedMinor([1, 3], [1, 9]), 3);
	});

	it('names the minor each command came with, and COMMANDS is those names', () => {
		assert.deepEqual(COMMANDS, Object.keys(COMMAND_MINOR));
		for (const name of ['read', 'write', 'review', 'switch', 'fit', 'reconnect', 'auto-write']) {
			assert.equal(minorOf(name), 0, name);
		}
		assert.equal(COMMAND_MINOR.consent, 1);
		for (const name of ['eq', 'control', 'preset-create', 'preset-rename', 'preset-delete']) {
			assert.equal(minorOf(name), 3, name);
			assert.ok(COMMANDS.includes(name), name);
		}
		assert.equal(COMMANDS.length, 13);
		assert.ok(COMMANDS.every((name) => minorOf(name) <= PROTO[1]));
	});
});

describe('statusFor', () => {
	const status = (patch: Partial<LinkStatus> = {}): LinkStatus => ({
		connected: true,
		activeSlot: 1,
		deviceSlot: 1,
		eqEnabled: true,
		busy: null,
		inSync: true,
		unwritten: false,
		needsReconnect: false,
		autoWrite: false,
		...patch
	});

	it('shows an mGT before 1.3 no busy it does not know', () => {
		for (const busy of ['control', 'preset'] as const) {
			for (const minor of [0, 1, 2]) {
				assert.equal(statusFor(status({ busy }), minor).busy, null, `${busy} at ${minor}`);
			}
			assert.equal(statusFor(status({ busy }), 3).busy, busy);
		}
	});

	it('passes every other busy, and an unchanged status as the same object', () => {
		for (const busy of ['read', 'write', 'switch', 'connect', null] as const) {
			const s = status({ busy });
			assert.equal(statusFor(s, 0), s, `${busy}`);
			assert.equal(statusFor(s, 3), s, `${busy} at 3`);
		}
	});

	it('keeps the newer fields, and does not touch its input', () => {
		const s = status({
			busy: 'preset',
			slots: [{ id: 4, name: 'Movie' }],
			unsaved: true,
			absentEqs: ['x'],
			controls: { gain: 3, other: null }
		});
		const before = structuredClone(s);
		const old = statusFor(s, 2);
		assert.deepEqual(old, { ...before, busy: null });
		assert.deepEqual(s, before);
		assert.notEqual(old, s);
	});
});

describe('eqEqual with a right channel', () => {
	const linked: LinkEq = { ...channel(100, 200) };
	const apart = (right: LinkChannel): LinkEq => ({ ...channel(100, 200), right });

	it('compares both channels when apart', () => {
		assert.ok(eqEqual(apart(channel(300)), apart(channel(300))));
		assert.ok(eqEqual(apart(channel(300)), structuredClone(apart(channel(300)))));
	});

	it('tells a differing right channel', () => {
		assert.ok(!eqEqual(apart(channel(300)), apart(channel(301))));
		assert.ok(!eqEqual(apart(channel(300)), apart({ ...channel(300), preamp: -1 })));
		assert.ok(!eqEqual(apart(channel(300)), apart({ ...channel(300), autoPreamp: true })));
		assert.ok(!eqEqual(apart(channel(300)), apart(channel(300, 400))));
	});

	it('tells a differing left channel when the right is the same', () => {
		const other: LinkEq = { ...channel(100, 201), right: channel(300) };
		assert.ok(!eqEqual(apart(channel(300)), other));
	});

	it('tells one side without a right channel, either way round', () => {
		assert.ok(!eqEqual(linked, apart(channel(300))));
		assert.ok(!eqEqual(apart(channel(300)), linked));
		assert.ok(eqEqual(linked, { ...channel(100, 200) }));
	});

	it('does not take apart-but-equal for one list', () => {
		const same = apart(channel(100, 200));
		assert.ok(!eqEqual(same, linked));
		assert.ok(!eqEqual(linked, same));
		assert.ok(eqEqual(same, structuredClone(same)));
	});
});

describe('parseMessage, proto 1.3', () => {
	const left = channel(1000);

	it('keeps an eq with a valid right channel', () => {
		const m = parseMessage(eqMessage({ ...left, right: channel(2000, 3000) }));
		assert.ok(m && m.t === 'eq');
		assert.deepEqual(m.eq.right, channel(2000, 3000));
		assert.ok(parseMessage(eqMessage(left)), 'one list still parses');
	});

	it('rejects an eq with a malformed right channel', () => {
		const bad: unknown[] = [
			null,
			'right',
			[],
			{},
			{ ...channel(1), filters: 'x' },
			{ ...channel(1), filters: [{ type: 'PK', freq: 'x', q: 1, gain: 0 }] },
			{ ...channel(1), preamp: 'x' },
			{ ...channel(1), autoPreamp: 1 },
			{ filters: [], preamp: 0 }
		];
		for (const right of bad) {
			assert.equal(parseMessage(eqMessage({ ...left, right })), null, JSON.stringify(right));
		}
	});

	it('keeps an edit op for either channel, and one for both', () => {
		const ops = [
			{ op: 'band', i: 0, filter: pk(1), ch: 'left' },
			{ op: 'band', i: 0, filter: pk(1), ch: 'right' },
			{ op: 'list', filters: [pk(1)], ch: 'right' },
			{ op: 'preamp', db: -1, ch: 'left' },
			{ op: 'auto-preamp', on: true, ch: 'right' },
			{ op: 'band', i: 0, filter: pk(1) }
		];
		for (const op of ops) assert.ok(parseMessage(editMessage(op)), JSON.stringify(op));
		const all = parseMessage(editMessage(...ops));
		assert.ok(all && all.t === 'edit');
		assert.equal(all.ops.length, ops.length);
	});

	it('rejects the whole edit when an op names a channel it cannot', () => {
		for (const ch of ['both', 'Left', '', null, 0, true, ['left'], {}]) {
			assert.equal(
				parseMessage(editMessage({ op: 'preamp', db: 0 }, { op: 'list', filters: [], ch })),
				null,
				JSON.stringify(ch)
			);
			assert.equal(parseMessage(editMessage({ op: 'auto-preamp', on: true, ch })), null);
			assert.equal(parseMessage(editMessage({ op: 'channels', apart: true, ch })), null);
			// Even an op from a newer minor: it would land on both.
			assert.equal(parseMessage(editMessage({ op: 'future', ch })), null);
		}
	});

	it('keeps a channels op with a boolean apart, and rejects any other', () => {
		for (const op of [
			{ op: 'channels', apart: true },
			{ op: 'channels', apart: false },
			{ op: 'channels', apart: false, keep: 'right' }
		]) {
			const m = parseMessage(editMessage(op));
			assert.ok(m && m.t === 'edit', JSON.stringify(op));
			assert.deepEqual(m.ops, [op]);
		}
		for (const apart of [undefined, 'true', 1, 0, null]) {
			assert.equal(
				parseMessage(editMessage({ op: 'channels', apart })),
				null,
				`apart ${String(apart)}`
			);
		}
	});

	it('still keeps an unknown op name, and an unknown command', () => {
		const m = parseMessage(editMessage({ op: 'future', x: 1 }, { op: 'channels', apart: true }));
		assert.ok(m && m.t === 'edit');
		assert.equal(m.ops.length, 2);
		// The joiner answers an unknown command (`unsupported`), so the parser must hand it over.
		const cmd = parseMessage(JSON.stringify({ t: 'cmd', id: 7, name: 'from-the-future', args: 1 }));
		assert.ok(cmd && cmd.t === 'cmd');
		assert.equal(cmd.name, 'from-the-future');
		const known = parseMessage(JSON.stringify({ t: 'cmd', id: 8, name: 'control', args: {} }));
		assert.ok(known && known.t === 'cmd');
		assert.equal(parseMessage(JSON.stringify({ t: 'cmd', id: 9 })), null);
		assert.equal(parseMessage(JSON.stringify({ t: 'cmd', name: 'read' })), null);
	});
});
