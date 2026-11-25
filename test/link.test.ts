// HostLink and JoinerLink over a fake session: the rules each side applies to the other's
// version, its approval and its peers, without signaling or WebRTC. The smoke test runs the
// real thing.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { startHost, type HostLink } from '../client/host.ts';
import { startJoiner, type JoinerHandlers, type JoinerLink } from '../client/joiner.ts';
import type {
	EditOp,
	Filter,
	LinkEq,
	LinkStatus,
	Message,
	MessageOf,
	Proto
} from '../client/protocol.ts';
import {
	Emitter,
	type LinkSession,
	type Peer,
	type SessionEvents,
	type SessionOptions
} from '../client/session.ts';

beforeEach(() =>
	mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
);
afterEach(() => mock.timers.reset());

/** A session that records what would go on the wire, and fires what the network would. */
class FakeSession extends Emitter<SessionEvents> {
	readonly server: string;
	readonly room: string;
	readonly peerId: string;
	open = false;
	closed = false;
	/** As the other side would read them: `undefined` fields are gone. */
	readonly sent: Message[] = [];

	constructor(options: SessionOptions) {
		super();
		this.server = new URL(options.server).origin;
		this.room = options.room;
		this.peerId = options.peerId ?? 'this-side';
	}

	send(message: Message): boolean {
		if (!this.open) return false;
		this.sent.push(JSON.parse(JSON.stringify(message)));
		return true;
	}

	close(): void {
		this.closed = true;
		this.open = false;
	}

	fire<K extends keyof SessionEvents>(
		type: K,
		...value: SessionEvents[K] extends void ? [] : [SessionEvents[K]]
	): void {
		this.emit(type, ...value);
	}

	/** The other peer joined and the channel opened. */
	connect(id: string, rejoin = false): void {
		this.fire('peer', { peer: peer(id), rejoin });
		this.open = true;
		this.fire('open');
	}

	of<T extends Message['t']>(t: T): MessageOf<T>[] {
		return this.sent.filter((m): m is MessageOf<T> => m.t === t);
	}
}

const peer = (id: string): Peer => ({
	id,
	origin: 'https://example.test',
	userAgent: '',
	joinedAt: 0
});
const pk = (freq: number): Filter => ({ type: 'PK', freq, q: 1, gain: 0 });
const SERVER = 'https://link.example.test';

// ── mGT ──────────────────────────────────────────────────────────────────────────────────────

/** mGT, linked to a uniPEQ on `theirs`, with what it sent so far cleared. */
function linkedHost(
	theirs: Proto = [1, 3],
	local: LinkEq = { filters: [], preamp: 0, autoPreamp: false }
) {
	let fake!: FakeSession;
	const host = startHost({
		server: SERVER,
		version: 'test',
		local: () => local,
		storage: null,
		session: (options) => (fake = new FakeSession(options)) as unknown as LinkSession
	});
	const ended: unknown[] = [];
	host.on('ended', (e) => ended.push(e));
	fake.connect('unipeq-1');
	fake.fire('message', { t: 'hello', proto: theirs, app: 'unipeq', version: 'u' });
	fake.fire('message', { t: 'approval', state: 'approved' });
	assert.equal(host.state, 'linked');
	fake.sent.length = 0;
	return { host, fake, ended };
}

const edits = (fake: FakeSession) => fake.of('edit').map((m) => m.ops);

describe('HostLink, edits to an older uniPEQ', () => {
	it('keeps an op whose ch is undefined, which is for both channels', () => {
		const { host, fake } = linkedHost([1, 2]);
		const op = { op: 'band', i: 0, filter: pk(1), ch: undefined } as EditOp;
		host.edit([op]);
		assert.deepEqual(edits(fake), [[{ op: 'band', i: 0, filter: pk(1) }]]);
	});

	it("drops a channel's ops and channels ops, and still asks for an eq", () => {
		const { host, fake } = linkedHost([1, 2]);
		host.edit([
			{ op: 'band', i: 0, filter: pk(1) },
			{ op: 'band', i: 1, filter: pk(2), ch: 'right' },
			{ op: 'channels', apart: true }
		]);
		mock.timers.tick(100);
		// The kept op, then an empty edit: uniPEQ answers both with an `eq`.
		assert.deepEqual(edits(fake), [[{ op: 'band', i: 0, filter: pk(1) }], []]);
	});

	it('sends an empty edit when every op is dropped and nothing settles', () => {
		const { host, fake } = linkedHost([1, 2]);
		host.edit([{ op: 'channels', apart: true }]);
		mock.timers.tick(100);
		const [edit] = fake.of('edit');
		assert.deepEqual(edit.ops, []);
		assert.equal(edit.settle, undefined);
		assert.equal(host.dirty, true, 'until uniPEQ acknowledges it');
	});

	it('sends every op unchanged on minor 3', () => {
		const { host, fake } = linkedHost([1, 3]);
		const ops: EditOp[] = [
			{ op: 'channels', apart: true },
			{ op: 'band', i: 1, filter: pk(2), ch: 'right' }
		];
		host.edit(ops);
		mock.timers.tick(100);
		assert.deepEqual(edits(fake), [ops]);
	});

	it('ignores edits before approval', () => {
		let fake!: FakeSession;
		const host = startHost({
			server: SERVER,
			version: 'test',
			local: () => ({ filters: [], preamp: 0, autoPreamp: false }),
			storage: null,
			session: (options) => (fake = new FakeSession(options)) as unknown as LinkSession
		});
		fake.connect('unipeq-1');
		host.edit([{ op: 'preamp', db: -1 }]);
		mock.timers.tick(100);
		assert.deepEqual(fake.of('edit'), []);
	});
});

describe('HostLink.replaceAll', () => {
	const one: LinkEq = { filters: [pk(1)], preamp: -1, autoPreamp: false };
	const apart: LinkEq = { ...one, right: { filters: [pk(2)], preamp: 0, autoPreamp: true } };

	it('sends one list without a channels op, even on minor 3', () => {
		for (const minor of [2, 3]) {
			const { host, fake } = linkedHost([1, minor]);
			host.replaceAll(one);
			const [edit] = fake.of('edit');
			assert.deepEqual(edit.ops, [
				{ op: 'list', filters: one.filters },
				{ op: 'preamp', db: -1 }
			]);
			assert.equal(edit.settle, true);
		}
	});

	it('sets the channels apart on minor 3 when the list has right', () => {
		const { host, fake } = linkedHost([1, 3]);
		host.replaceAll(apart);
		assert.deepEqual(fake.of('edit')[0].ops, [
			{ op: 'channels', apart: true },
			{ op: 'list', filters: one.filters, ch: 'left' },
			{ op: 'preamp', db: -1, ch: 'left' },
			{ op: 'list', filters: [pk(2)], ch: 'right' },
			{ op: 'auto-preamp', on: true, ch: 'right' }
		]);
	});

	it('sends the left list alone below minor 3', () => {
		const { host, fake } = linkedHost([1, 2]);
		host.replaceAll(apart);
		assert.deepEqual(fake.of('edit')[0].ops, [
			{ op: 'list', filters: one.filters },
			{ op: 'preamp', db: -1 }
		]);
	});
});

describe('HostLink, versions and peers', () => {
	it("answers a command above uniPEQ's minor itself, and sends the rest", async () => {
		const { host, fake } = linkedHost([1, 2]);
		const refused = await host.command('control', { id: 'gain', value: 1 });
		assert.deepEqual(refused, { ok: false, code: 'unsupported' });
		const write = host.command('write');
		const [cmd] = fake.of('cmd');
		assert.equal(cmd.name, 'write');
		fake.fire('message', { t: 're', id: cmd.id, ok: true });
		assert.deepEqual(await write, { ok: true });
		assert.equal(fake.of('cmd').length, 1);
	});

	it('times a command out when no answer comes', async () => {
		const { host } = linkedHost([1, 3]);
		const result = host.command('read');
		mock.timers.tick(20_000);
		assert.deepEqual(await result, { ok: false, code: 'timeout' });
	});

	it('forgets the old proto when another uniPEQ joins, until its hello', async () => {
		const { host, fake } = linkedHost([1, 3]);
		assert.equal(host.minor, 3);
		fake.fire('peer', { peer: peer('unipeq-2'), rejoin: false });
		assert.equal(host.minor, 0);
		assert.equal(host.peerProto, null);
		assert.deepEqual(await host.command('eq', { id: null }), { ok: false, code: 'unsupported' });
		assert.deepEqual(fake.of('cmd'), []);
		fake.fire('message', { t: 'hello', proto: [1, 2], app: 'unipeq', version: 'u' });
		assert.equal(host.minor, 2);
	});

	it('keeps the proto when the same uniPEQ rejoins', () => {
		const { host, fake } = linkedHost([1, 3]);
		fake.fire('peer', { peer: peer('unipeq-1'), rejoin: true });
		assert.equal(host.minor, 3);
	});

	it('ends with version on another major, and says its own proto', () => {
		const { host, fake, ended } = linkedHost([1, 3]);
		fake.fire('message', { t: 'hello', proto: [2, 0], app: 'unipeq', version: 'u' });
		assert.equal(host.state, 'ended');
		assert.deepEqual(ended, [{ reason: 'version', by: 'self', peerProto: [2, 0] }]);
		assert.deepEqual(fake.of('bye'), [{ t: 'bye', reason: 'version', proto: [1, 3] }]);
		mock.timers.tick(100);
		assert.ok(fake.closed);
	});
});

// ── uniPEQ ───────────────────────────────────────────────────────────────────────────────────

const STATUS: LinkStatus = {
	connected: true,
	knownDevice: 'DAC',
	editable: true,
	activeSlot: null,
	deviceSlot: null,
	eqEnabled: true,
	busy: null,
	inSync: true,
	unwritten: false,
	needsReconnect: false,
	auto: { on: false, pending: false, paused: false, stopped: false, clipRisk: false },
	failure: null,
	review: null
};

function joiner(status: Partial<LinkStatus> = {}) {
	let fake!: FakeSession;
	const handlers: JoinerHandlers = {
		eq: () => ({ filters: [pk(1)], preamp: 0, autoPreamp: false }),
		device: () => null,
		status: () => ({ ...STATUS, ...status }),
		edit: () => false,
		command: async () => ({ ok: true })
	};
	const link: JoinerLink = startJoiner({
		server: SERVER,
		room: 'ABCDEFGH',
		version: 'test',
		handlers,
		session: (options) => (fake = new FakeSession(options)) as unknown as LinkSession
	});
	const requests: unknown[] = [];
	link.on('request', (r) => requests.push(r));
	return { link, fake: () => fake, requests };
}

const mgtHello = (minor: number): Message => ({
	t: 'hello',
	proto: [1, minor],
	app: 'mgt',
	version: 'm',
	site: 'Graph'
});

describe('JoinerLink', () => {
	it('asks for approval, and answers nothing but pending until the user approves', () => {
		const { link, fake, requests } = joiner();
		fake().connect('mgt-1');
		assert.equal(link.state, 'approval');
		fake().fire('message', mgtHello(3));
		assert.equal(requests.length, 2, 'again with the site');
		fake().fire('message', { t: 'edit', seq: 1, ops: [] });
		assert.deepEqual(
			fake().sent.map((m) => m.t),
			['hello', 'approval', 'approval']
		);
		fake().sent.length = 0;
		link.approve();
		mock.timers.tick(100);
		assert.deepEqual(
			fake().sent.map((m) => m.t),
			['approval', 'device', 'status', 'eq']
		);
	});

	it('takes out busy values an older mGT lacks, and keeps them for 1.3', () => {
		for (const [minor, busy] of [
			[2, null],
			[3, 'preset']
		] as const) {
			const { link, fake } = joiner({ busy: 'preset' });
			fake().connect('mgt-1');
			fake().fire('message', mgtHello(minor));
			link.approve();
			assert.equal(fake().of('status')[0].status.busy, busy, `minor ${minor}`);
		}
	});

	it('forgets the proto and asks again when another mGT joins', () => {
		const { link, fake, requests } = joiner();
		fake().connect('mgt-1');
		fake().fire('message', mgtHello(3));
		link.approve();
		assert.equal(link.minor, 3);
		fake().fire('peer', { peer: peer('mgt-2'), rejoin: false });
		assert.equal(link.minor, 0);
		assert.equal(link.approved, false);
		assert.equal(link.state, 'approval');
		assert.equal(requests.length, 3);
	});
});
