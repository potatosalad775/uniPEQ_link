// Room codes, links and message parsing (design §2.2, §4.1).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	intentLink,
	landingUrl,
	webLink,
	WEB_LINK_PARAM,
	newRoomCode,
	normalizeRoomCode,
	parseMessage,
	parseRoomInput,
	ROOM_CODE
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
