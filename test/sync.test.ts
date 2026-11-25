// The shared-list rules (design §4.4, §4.6) without a channel: mGT's HostSync and uniPEQ's
// AuthoritySync wired back to back, with mocked timers.
//
//   node --test test/
import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it, mock } from 'node:test';
import type { EditOp, Filter, LinkChannel, LinkEq, MessageOf } from '../client/protocol.ts';
import {
	applyOps,
	AuthoritySync,
	HostSync,
	mergeOp,
	replaceOps,
	Throttle
} from '../client/sync.ts';

const pk = (freq: number, gain = 0): Filter => ({ type: 'PK', freq, q: 1, gain });
const flat = (n: number): LinkEq => ({
	filters: Array.from({ length: n }, (_, i) => pk(100 * (i + 1))),
	preamp: 0,
	autoPreamp: false
});

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

describe('mergeOp', () => {
	it('keeps the latest op per band', () => {
		let ops: EditOp[] = [];
		ops = mergeOp(ops, { op: 'band', i: 1, filter: pk(1) });
		ops = mergeOp(ops, { op: 'band', i: 2, filter: pk(2) });
		ops = mergeOp(ops, { op: 'band', i: 1, filter: pk(3) });
		assert.deepEqual(ops, [
			{ op: 'band', i: 2, filter: pk(2) },
			{ op: 'band', i: 1, filter: pk(3) }
		]);
	});

	it('lets a list op replace pending bands and lists, but not the preamp', () => {
		let ops: EditOp[] = [
			{ op: 'preamp', db: -2 },
			{ op: 'band', i: 0, filter: pk(1) }
		];
		ops = mergeOp(ops, { op: 'list', filters: [] });
		assert.deepEqual(ops, [
			{ op: 'preamp', db: -2 },
			{ op: 'list', filters: [] }
		]);
	});

	it('keeps one preamp op of each kind, the latest', () => {
		let ops: EditOp[] = [{ op: 'auto-preamp', on: false }];
		ops = mergeOp(ops, { op: 'preamp', db: -2 });
		ops = mergeOp(ops, { op: 'preamp', db: -3 });
		assert.deepEqual(ops, [{ op: 'preamp', db: -3 }]);
		// Auto doesn't drop the fixed value: turned off again, that value is the one in effect.
		ops = mergeOp(ops, { op: 'auto-preamp', on: true });
		ops = mergeOp(ops, { op: 'auto-preamp', on: false });
		assert.deepEqual(ops, [
			{ op: 'preamp', db: -3 },
			{ op: 'auto-preamp', on: false }
		]);
	});
});

describe('applyOps', () => {
	it('drops a band op past the end of the list', () => {
		const eq = applyOps(flat(2), [{ op: 'band', i: 5, filter: pk(9) }]);
		assert.deepEqual(eq, flat(2));
	});

	it('turns Auto off with a fixed preamp, and derives it while on', () => {
		assert.equal(applyOps(flat(1), [{ op: 'preamp', db: -3 }]).preamp, -3);
		const auto = applyOps(flat(1), [{ op: 'auto-preamp', on: true }], () => -7);
		assert.deepEqual([auto.autoPreamp, auto.preamp], [true, -7]);
	});
});

describe('Throttle', () => {
	it('runs at once, then once per window with the latest', () => {
		let runs = 0;
		const throttle = new Throttle(50, () => runs++);
		throttle.request();
		assert.equal(runs, 1);
		throttle.request();
		throttle.request();
		assert.equal(runs, 1);
		mock.timers.tick(50);
		assert.equal(runs, 2);
		mock.timers.tick(500);
		assert.equal(runs, 2);
	});
});

/** mGT and uniPEQ, with a channel that can be cut and delivers on `deliver()`. */
function pair(initial: LinkEq = flat(4)) {
	let mgt: LinkEq = structuredClone(initial);
	let unipeq: LinkEq = structuredClone(initial);
	let open = true;
	const toUnipeq: MessageOf<'edit'>[] = [];
	const toMgt: MessageOf<'eq'>[] = [];
	const settles: number[] = [];
	const adopted: { by: string; initial: boolean }[] = [];
	/** Every message that got through, in order: what each side was sent. */
	const edits: MessageOf<'edit'>[] = [];
	const echoes: MessageOf<'eq'>[] = [];

	const host = new HostSync(
		(m) => open && toUnipeq.push(structuredClone(m)) > 0,
		() => mgt
	);
	const authority = new AuthoritySync(
		(m) => open && toMgt.push(structuredClone(m)) > 0,
		() => unipeq
	);

	const t = {
		get mgt() {
			return mgt;
		},
		get unipeq() {
			return unipeq;
		},
		host,
		authority,
		toUnipeq,
		toMgt,
		settles,
		adopted,
		edits,
		echoes,
		cut: () => (open = false),
		restore: () => (open = true),
		/** mGT edits its own list and sends. */
		mgtEdit(ops: EditOp[], options?: { burst?: string; settle?: boolean }) {
			mgt = applyOps(mgt, ops);
			host.edit(ops, options);
		},
		/** uniPEQ edits its own list. */
		unipeqEdit(ops: EditOp[]) {
			unipeq = applyOps(unipeq, ops);
			authority.changed({ by: 'unipeq' });
		},
		/** Delivers everything in flight, both ways, until quiet (timers included). */
		deliver() {
			for (let round = 0; round < 50; round++) {
				mock.timers.tick(100);
				if (!toUnipeq.length && !toMgt.length) return;
				while (toUnipeq.length) {
					const m = toUnipeq.shift()!;
					edits.push(m);
					authority.receive(m, (ops) => {
						if (m.settle) settles.push(m.seq);
						const next = applyOps(unipeq, ops);
						const changed = JSON.stringify(next) !== JSON.stringify(unipeq);
						unipeq = next;
						return changed;
					});
				}
				while (toMgt.length) {
					const echo = toMgt.shift()!;
					echoes.push(echo);
					const adopt = host.receive(echo);
					if (adopt) {
						mgt = adopt.eq;
						adopted.push({ by: adopt.by, initial: adopt.initial });
					}
				}
			}
			throw new Error('never went quiet');
		}
	};
	return t;
}

describe('HostSync ↔ AuthoritySync', () => {
	it('adopts the first snapshot as the initial list', () => {
		const t = pair(flat(4));
		t.unipeqEdit([{ op: 'band', i: 0, filter: pk(1000, 3) }]);
		t.toMgt.length = 0;
		t.host.beginResync();
		t.authority.snapshot();
		t.deliver();
		assert.deepEqual(t.mgt, t.unipeq);
		assert.deepEqual(t.adopted, [{ by: 'unipeq', initial: true }]);
	});

	it('acknowledges mGT edits without adopting its own echo', () => {
		const t = pair();
		t.mgtEdit([{ op: 'band', i: 1, filter: pk(500, -2) }]);
		t.deliver();
		assert.deepEqual(t.unipeq, t.mgt);
		assert.equal(t.adopted.length, 0);
		assert.equal(t.host.dirty, false);
	});

	it('throttles a drag to the window and settles once', () => {
		const t = pair();
		for (let i = 0; i < 20; i++) {
			t.mgtEdit([{ op: 'band', i: 2, filter: pk(1000 + i) }], { burst: 'g1' });
			mock.timers.tick(10);
		}
		t.mgtEdit([], { burst: 'g1', settle: true });
		assert.ok(t.toUnipeq.length <= 5, `${t.toUnipeq.length} messages for 200 ms`);
		assert.ok(t.toUnipeq.every((m) => m.burst === 'g1'));
		t.deliver();
		assert.equal(t.settles.length, 1);
		assert.deepEqual(t.unipeq.filters[2], pk(1019));
	});

	it('keeps edits to different bands from both sides', () => {
		const t = pair();
		t.mgtEdit([{ op: 'band', i: 0, filter: pk(111) }]);
		t.unipeqEdit([{ op: 'band', i: 3, filter: pk(444) }]);
		t.deliver();
		assert.deepEqual(t.mgt, t.unipeq);
		assert.deepEqual([t.mgt.filters[0], t.mgt.filters[3]], [pk(111), pk(444)]);
	});

	it('converges on what uniPEQ applied last when both edit one band', () => {
		const t = pair();
		t.unipeqEdit([{ op: 'band', i: 1, filter: pk(222) }]);
		t.mgtEdit([{ op: 'band', i: 1, filter: pk(333) }]);
		t.deliver();
		assert.deepEqual(t.mgt, t.unipeq);
		assert.deepEqual(t.unipeq.filters[1], pk(333));
	});

	it("ignores uniPEQ's echo while its own edit is in flight", () => {
		const t = pair();
		t.unipeqEdit([{ op: 'band', i: 0, filter: pk(9) }]);
		t.mgtEdit([{ op: 'band', i: 0, filter: pk(8) }]);
		// uniPEQ's eq (ack 0) reaches mGT before mGT's edit reaches uniPEQ.
		const echo = t.toMgt.shift()!;
		assert.equal(t.host.receive(echo), null);
		assert.deepEqual(t.mgt.filters[0], pk(8));
		t.deliver();
		assert.deepEqual(t.mgt, t.unipeq);
	});

	it('marks a device read as fresh, even when coalesced', () => {
		const t = pair();
		t.unipeqEdit([{ op: 'band', i: 0, filter: pk(6) }]);
		// Inside the window: a read, then an edit on top. One message carries both.
		t.authority.changed({ by: 'device', fresh: true });
		t.unipeqEdit([{ op: 'band', i: 0, filter: pk(7) }]);
		mock.timers.tick(100);
		assert.equal(t.toMgt.length, 2);
		assert.deepEqual([t.toMgt[0].fresh, t.toMgt[1].fresh], [undefined, true]);
		t.deliver();
		t.authority.changed({ by: 'unipeq' });
		assert.equal(t.toMgt.at(-1)!.fresh, undefined);
	});

	it("resends mGT's list after a cut when uniPEQ didn't change", () => {
		const t = pair();
		t.mgtEdit([{ op: 'band', i: 0, filter: pk(1) }]);
		t.deliver();
		t.cut();
		t.mgtEdit([{ op: 'band', i: 1, filter: pk(2) }], { burst: 'a' });
		t.mgtEdit([{ op: 'band', i: 2, filter: pk(3) }], { burst: 'b' });
		mock.timers.tick(200);
		assert.equal(t.host.dirty, true);
		t.restore();
		t.host.beginResync();
		assert.deepEqual(t.host.helloFields(), { lastRev: 1, dirty: true });
		t.authority.snapshot();
		t.deliver();
		assert.deepEqual(t.unipeq, t.mgt);
		assert.deepEqual(t.mgt.filters[2], pk(3));
		assert.ok(t.settles.length >= 1, 'the resend settles, so uniPEQ writes');
		assert.equal(t.host.dirty, false);
	});

	it("takes uniPEQ's list after a cut when both changed", () => {
		const t = pair();
		t.host.beginResync();
		t.authority.snapshot();
		t.deliver();
		t.cut();
		t.mgtEdit([{ op: 'band', i: 1, filter: pk(2) }]);
		t.unipeqEdit([{ op: 'band', i: 3, filter: pk(4) }]);
		mock.timers.tick(200);
		t.restore();
		t.host.beginResync();
		t.authority.snapshot();
		t.deliver();
		assert.deepEqual(t.mgt, t.unipeq);
		assert.deepEqual(t.mgt.filters[1], flat(4).filters[1]);
		assert.equal(t.host.dirty, false);
	});

	it('continues the count after an mGT reload', () => {
		const t = pair();
		for (let i = 0; i < 3; i++) {
			t.mgtEdit([{ op: 'band', i: 0, filter: pk(i) }]);
			t.deliver();
		}
		// A reloaded mGT: a new HostSync with seq 0, wired to the same uniPEQ.
		const before = t.unipeq;
		const sent: MessageOf<'edit'>[] = [];
		const local = structuredClone(t.mgt);
		const reloaded = new HostSync(
			(m) => sent.push(m) > 0,
			() => local
		);
		reloaded.beginResync();
		t.authority.snapshot();
		const snapshot = t.toMgt.shift()!;
		assert.equal(snapshot.ack, 3);
		assert.equal(reloaded.receive(snapshot), null, 'same list: nothing to adopt');
		reloaded.edit([{ op: 'band', i: 1, filter: pk(77) }]);
		assert.equal(sent[0].seq, 4);
		assert.deepEqual(t.unipeq, before);
	});
});

// ── Proto 1.3: the channels ─────────────────────────────────────────────────────────────────

const side = (freqs: number[], preamp = 0, autoPreamp = false): LinkChannel => ({
	filters: freqs.map((f) => pk(f)),
	preamp,
	autoPreamp
});
/** Auto's value in these tests: -1 dB per band, so each channel's own list shows. */
const derive = (filters: Filter[]): number => -filters.length;
const withRight = (left: LinkChannel, right: LinkChannel): LinkEq => ({ ...left, right });

describe('replaceOps', () => {
	const linked: LinkEq = side([100, 200], -2);
	const linkedAuto: LinkEq = side([100, 200], -2, true);
	const apart: LinkEq = withRight(side([100, 200], -2), side([300], 0, true));

	it('sends a list and a preamp to a uniPEQ before 1.3, whatever the minor below it', () => {
		for (const minor of [undefined, 0, 1, 2]) {
			assert.deepEqual(replaceOps(linked, minor), [
				{ op: 'list', filters: linked.filters },
				{ op: 'preamp', db: -2 }
			]);
			assert.deepEqual(replaceOps(linkedAuto, minor), [
				{ op: 'list', filters: linked.filters },
				{ op: 'auto-preamp', on: true }
			]);
		}
	});

	it('sends the left channel only, with no ch, to a uniPEQ before 1.3, even when apart', () => {
		for (const minor of [0, 2]) {
			const ops = replaceOps(apart, minor);
			assert.deepEqual(ops, replaceOps(linked, minor));
			assert.ok(ops.every((op) => op.op !== 'channels' && !('ch' in op)));
		}
	});

	it('links the channels first for a uniPEQ on 1.3, when there is one list', () => {
		for (const minor of [3, 4]) {
			assert.deepEqual(replaceOps(linked, minor), [
				{ op: 'channels', apart: false },
				{ op: 'list', filters: linked.filters },
				{ op: 'preamp', db: -2 }
			]);
			assert.deepEqual(replaceOps(linkedAuto, minor), [
				{ op: 'channels', apart: false },
				{ op: 'list', filters: linked.filters },
				{ op: 'auto-preamp', on: true }
			]);
		}
	});

	it('sets the channels apart first, then each one, when there is a right channel', () => {
		assert.deepEqual(replaceOps(apart, 3), [
			{ op: 'channels', apart: true },
			{ op: 'list', filters: apart.filters, ch: 'left' },
			{ op: 'preamp', db: -2, ch: 'left' },
			{ op: 'list', filters: apart.right!.filters, ch: 'right' },
			{ op: 'auto-preamp', on: true, ch: 'right' }
		]);
	});

	it('sets the list outright: applied to anything, it gives the list back', () => {
		const starts: LinkEq[] = [
			flat(4),
			withRight(side([1, 2, 3, 4]), side([5, 6, 7, 8], -3)),
			withRight(side([9]), side([], 0, true))
		];
		for (const eq of [linked, linkedAuto, apart]) {
			for (const start of starts) {
				const done = applyOps(start, replaceOps(eq, 3), derive);
				assert.deepEqual(done, applyOps(eq, [], derive), JSON.stringify(eq));
			}
		}
	});

	it('survives mergeOp: nothing in it supersedes another', () => {
		for (const eq of [linked, linkedAuto, apart]) {
			const ops = replaceOps(eq, 3);
			assert.deepEqual(ops.reduce(mergeOp, [] as EditOp[]), ops);
		}
	});
});

describe('mergeOp, channels', () => {
	const merge = (...ops: EditOp[]): EditOp[] => ops.reduce(mergeOp, [] as EditOp[]);
	const band = (i: number, f: number, ch?: 'left' | 'right'): EditOp =>
		ch ? { op: 'band', i, filter: pk(f), ch } : { op: 'band', i, filter: pk(f) };
	const list = (f: number[], ch?: 'left' | 'right'): EditOp => {
		const filters = f.map((x) => pk(x));
		return ch ? { op: 'list', filters, ch } : { op: 'list', filters };
	};
	const preamp = (db: number, ch?: 'left' | 'right'): EditOp =>
		ch ? { op: 'preamp', db, ch } : { op: 'preamp', db };
	const auto = (on: boolean, ch?: 'left' | 'right'): EditOp =>
		ch ? { op: 'auto-preamp', on, ch } : { op: 'auto-preamp', on };

	it('keeps one band per channel', () => {
		assert.deepEqual(merge(band(1, 1, 'left'), band(1, 2, 'right')), [
			band(1, 1, 'left'),
			band(1, 2, 'right')
		]);
		assert.deepEqual(merge(band(1, 1, 'left'), band(1, 2, 'right'), band(1, 3, 'left')), [
			band(1, 2, 'right'),
			band(1, 3, 'left')
		]);
	});

	it('lets an op for no channel supersede both channels', () => {
		assert.deepEqual(merge(band(1, 1, 'left'), band(1, 2, 'right'), band(1, 3)), [band(1, 3)]);
		assert.deepEqual(merge(band(1, 1), band(1, 2, 'left'), band(0, 5, 'right'), band(1, 3)), [
			band(0, 5, 'right'),
			band(1, 3)
		]);
	});

	it('does not let an op for one channel supersede an op for none', () => {
		assert.deepEqual(merge(band(1, 1), band(1, 2, 'left')), [band(1, 1), band(1, 2, 'left')]);
		assert.deepEqual(merge(list([1]), list([2], 'right')), [list([1]), list([2], 'right')]);
		assert.deepEqual(merge(preamp(-1), preamp(-2, 'left')), [preamp(-1), preamp(-2, 'left')]);
		assert.deepEqual(merge(auto(true), preamp(-2, 'right')), [auto(true), preamp(-2, 'right')]);
	});

	it('lets a list drop the bands and lists of its own channel only', () => {
		const pending = merge(band(0, 1, 'left'), band(0, 2, 'right'), band(3, 3), preamp(-1, 'left'));
		assert.deepEqual(mergeOp(pending, list([9], 'left')), [
			band(0, 2, 'right'),
			band(3, 3),
			preamp(-1, 'left'),
			list([9], 'left')
		]);
		assert.deepEqual(mergeOp(pending, list([9])), [preamp(-1, 'left'), list([9])]);
	});

	it('keeps one preamp op of each kind per channel', () => {
		assert.deepEqual(merge(preamp(-1, 'left'), auto(true, 'right'), auto(false, 'left')), [
			preamp(-1, 'left'),
			auto(true, 'right'),
			auto(false, 'left')
		]);
		assert.deepEqual(merge(auto(true, 'left'), auto(true, 'right'), auto(false, 'left')), [
			auto(true, 'right'),
			auto(false, 'left')
		]);
		assert.deepEqual(merge(preamp(-1, 'left'), auto(true, 'right'), preamp(-4)), [preamp(-4)]);
		assert.deepEqual(merge(preamp(-4), preamp(-1, 'left'), preamp(-5, 'left')), [
			preamp(-4),
			preamp(-5, 'left')
		]);
	});

	it('supersedes nothing with a channels op, and keeps it', () => {
		const ops = merge(
			band(0, 1),
			{ op: 'channels', apart: true },
			{ op: 'channels', apart: true },
			{ op: 'channels', apart: false, keep: 'right' }
		);
		assert.deepEqual(ops, [
			band(0, 1),
			{ op: 'channels', apart: true },
			{ op: 'channels', apart: true },
			{ op: 'channels', apart: false, keep: 'right' }
		]);
	});

	it('drops nothing at or before the last channels op', () => {
		const joined: EditOp = { op: 'channels', apart: false };
		assert.deepEqual(merge(list([1]), band(0, 1), preamp(-1), joined, band(0, 2)), [
			list([1]),
			band(0, 1),
			preamp(-1),
			joined,
			band(0, 2)
		]);
		assert.deepEqual(merge(list([1]), band(0, 1), preamp(-1), joined, list([2]), preamp(-2)), [
			list([1]),
			band(0, 1),
			preamp(-1),
			joined,
			list([2]),
			preamp(-2)
		]);
		// After the op, supersession works as before.
		assert.deepEqual(merge(joined, band(0, 1), band(0, 2)), [joined, band(0, 2)]);
		assert.deepEqual(merge(band(0, 1), joined, band(0, 2), band(0, 3)), [
			band(0, 1),
			joined,
			band(0, 3)
		]);
	});

	it('keeps the earlier list when the channels were just linked (regression)', () => {
		const pending: EditOp[] = [list([2], 'right'), { op: 'channels', apart: false, keep: 'right' }];
		const before = structuredClone(pending);
		const merged = mergeOp(pending, list([3], 'right'));
		assert.deepEqual(merged, [
			list([2], 'right'),
			{ op: 'channels', apart: false, keep: 'right' },
			list([3], 'right')
		]);
		assert.deepEqual(pending, before, 'the input is left alone');
	});

	it('does not touch its input', () => {
		const pending = [band(0, 1, 'left'), preamp(-1)];
		const before = structuredClone(pending);
		mergeOp(pending, band(0, 2, 'left'));
		assert.deepEqual(pending, before);
	});
});

describe('applyOps, channels', () => {
	const apartEq = (): LinkEq => withRight(side([100, 200, 300], -1), side([400, 500], -2));

	it('sets the one list for an op with no channel while not apart', () => {
		const eq = applyOps(flat(3), [
			{ op: 'band', i: 1, filter: pk(7) },
			{ op: 'preamp', db: -4 }
		]);
		assert.equal(eq.right, undefined);
		assert.deepEqual(eq.filters[1], pk(7));
		assert.equal(eq.preamp, -4);
	});

	it('sets both channels for an op with no channel while apart', () => {
		const eq = applyOps(apartEq(), [
			{ op: 'band', i: 1, filter: pk(7) },
			{ op: 'preamp', db: -4 }
		]);
		assert.deepEqual([eq.filters[1], eq.right!.filters[1]], [pk(7), pk(7)]);
		assert.deepEqual([eq.preamp, eq.right!.preamp], [-4, -4]);
		assert.deepEqual(eq.filters.length, 3);
		assert.deepEqual(eq.right!.filters.length, 2);
		const listed = applyOps(apartEq(), [{ op: 'list', filters: [pk(1)] }]);
		assert.deepEqual([listed.filters, listed.right!.filters], [[pk(1)], [pk(1)]]);
		const on = applyOps(apartEq(), [{ op: 'auto-preamp', on: true }], derive);
		assert.deepEqual([on.autoPreamp, on.right!.autoPreamp], [true, true]);
	});

	it('drops an op for a channel while not apart, every kind', () => {
		for (const ch of ['left', 'right'] as const) {
			const eq = applyOps(
				flat(3),
				[
					{ op: 'band', i: 0, filter: pk(7), ch },
					{ op: 'list', filters: [], ch },
					{ op: 'preamp', db: -9, ch },
					{ op: 'auto-preamp', on: true, ch }
				],
				derive
			);
			assert.deepEqual(eq, flat(3), ch);
		}
	});

	it('sets only the named channel while apart', () => {
		const left = applyOps(apartEq(), [
			{ op: 'band', i: 0, filter: pk(7), ch: 'left' },
			{ op: 'preamp', db: -9, ch: 'left' }
		]);
		assert.deepEqual(left.filters[0], pk(7));
		assert.equal(left.preamp, -9);
		assert.deepEqual(left.right, apartEq().right);

		const right = applyOps(apartEq(), [
			{ op: 'list', filters: [pk(8)], ch: 'right' },
			{ op: 'auto-preamp', on: true, ch: 'right' }
		]);
		assert.deepEqual(right.right!.filters, [pk(8)]);
		assert.equal(right.right!.autoPreamp, true);
		assert.deepEqual({ ...right, right: undefined }, { ...apartEq(), right: undefined });
	});

	it('drops a band past the end of its own channel only', () => {
		const eq = applyOps(apartEq(), [{ op: 'band', i: 2, filter: pk(7) }]);
		assert.deepEqual(eq.filters[2], pk(7));
		assert.equal(eq.right!.filters.length, 2, 'the right list has no band 2');
		const right = applyOps(apartEq(), [{ op: 'band', i: 2, filter: pk(7), ch: 'right' }]);
		assert.deepEqual(right, apartEq());
	});

	it('makes the right a copy of the left when the channels are set apart', () => {
		const eq = applyOps(flat(3), [{ op: 'channels', apart: true }]);
		assert.deepEqual(eq.right, { filters: flat(3).filters, preamp: 0, autoPreamp: false });
		assert.deepEqual(eq.filters, flat(3).filters);
		// The copy is a list of its own from then on.
		const next = applyOps(flat(3), [
			{ op: 'channels', apart: true },
			{ op: 'band', i: 0, filter: pk(7), ch: 'right' },
			{ op: 'preamp', db: -3, ch: 'left' }
		]);
		assert.deepEqual(next.filters[0], flat(3).filters[0]);
		assert.deepEqual(next.right!.filters[0], pk(7));
		assert.equal(next.preamp, -3);
		assert.equal(next.right!.preamp, 0);
	});

	it('does nothing when set apart while apart already', () => {
		assert.deepEqual(applyOps(apartEq(), [{ op: 'channels', apart: true }]), apartEq());
	});

	it('drops the right channel when linked, keeping the left unless told to keep the right', () => {
		assert.deepEqual(
			applyOps(apartEq(), [{ op: 'channels', apart: false }]),
			side([100, 200, 300], -1)
		);
		assert.deepEqual(
			applyOps(apartEq(), [{ op: 'channels', apart: false, keep: 'left' }]),
			side([100, 200, 300], -1)
		);
		assert.deepEqual(
			applyOps(apartEq(), [{ op: 'channels', apart: false, keep: 'right' }]),
			side([400, 500], -2)
		);
	});

	it('does nothing when linked while linked already, whatever it keeps', () => {
		for (const keep of [undefined, 'left', 'right'] as const) {
			const op: EditOp = keep
				? { op: 'channels', apart: false, keep }
				: { op: 'channels', apart: false };
			assert.deepEqual(applyOps(flat(2), [op]), flat(2));
		}
	});

	it('follows an op sequence in order, a channel op after linking being dropped', () => {
		const eq = applyOps(apartEq(), [
			{ op: 'channels', apart: false, keep: 'right' },
			{ op: 'list', filters: [pk(1)], ch: 'right' },
			{ op: 'preamp', db: -7 }
		]);
		assert.deepEqual(eq, side([400, 500], -7));
	});

	it('derives Auto for each channel from its own list', () => {
		const eq = applyOps(
			withRight(side([1, 2, 3], 0, true), side([1], 0, true)),
			[{ op: 'band', i: 0, filter: pk(9), ch: 'left' }],
			derive
		);
		assert.equal(eq.preamp, -3);
		assert.equal(eq.right!.preamp, -1);
		const mixed = applyOps(
			withRight(side([1, 2], -6, true), side([1, 2, 3], -6)),
			[{ op: 'list', filters: [pk(1), pk(2), pk(3), pk(4)], ch: 'left' }],
			derive
		);
		assert.equal(mixed.preamp, -4, 'Auto on: derived');
		assert.equal(mixed.right!.preamp, -6, 'Auto off: as set');
		const turnedOn = applyOps(apartEq(), [{ op: 'auto-preamp', on: true, ch: 'right' }], derive);
		assert.deepEqual([turnedOn.preamp, turnedOn.right!.preamp], [-1, -2]);
	});

	it('does not touch its input, and skips an op it does not know', () => {
		const eq = apartEq();
		const before = structuredClone(eq);
		const done = applyOps(
			eq,
			[{ op: 'band', i: 0, filter: pk(7), ch: 'left' }, { op: 'future' } as unknown as EditOp],
			derive
		);
		assert.deepEqual(eq, before);
		assert.deepEqual(done.filters[0], pk(7));
		assert.deepEqual(done.right, before.right);
	});
});

describe('mergeOp and applyOps agree', () => {
	const b = (i: number, f: number, ch?: 'left' | 'right'): EditOp =>
		ch ? { op: 'band', i, filter: pk(f), ch } : { op: 'band', i, filter: pk(f) };
	const l = (f: number[], ch?: 'left' | 'right'): EditOp => {
		const filters = f.map((x) => pk(x));
		return ch ? { op: 'list', filters, ch } : { op: 'list', filters };
	};
	const p = (db: number, ch?: 'left' | 'right'): EditOp =>
		ch ? { op: 'preamp', db, ch } : { op: 'preamp', db };
	const a = (on: boolean, ch?: 'left' | 'right'): EditOp =>
		ch ? { op: 'auto-preamp', on, ch } : { op: 'auto-preamp', on };
	const apartOn = { op: 'channels', apart: true } as const;
	const linkedOn = { op: 'channels', apart: false } as const;
	const keepRight = { op: 'channels', apart: false, keep: 'right' } as const;

	const sequences: Record<string, EditOp[]> = {
		'bands of one channel twice': [b(0, 1, 'left'), b(0, 2, 'left'), b(1, 3, 'right')],
		'a band for none between two for one channel': [b(0, 1), b(0, 2, 'left'), b(0, 3)],
		'a band for one channel around a band for none': [b(0, 1, 'left'), b(0, 2), b(0, 3, 'left')],
		'lists and bands across channels': [l([1, 2], 'left'), b(1, 5), l([3, 4, 5]), b(0, 6, 'right')],
		'a list for one channel after a list for none': [l([1, 2, 3]), b(2, 8, 'left'), l([4], 'left')],
		'a band past the end of the list it follows': [
			b(2, 1, 'left'),
			l([1], 'left'),
			b(2, 2, 'left')
		],
		'preamps and Auto on both and either': [
			p(-3, 'left'),
			a(true, 'right'),
			p(-5),
			a(true, 'left')
		],
		'a preamp for one channel around Auto for none': [p(-3, 'left'), a(true), p(-5, 'left')],
		'Auto on for one channel around a preamp for none': [a(true, 'left'), p(-2), a(true, 'left')],
		'a fixed preamp turning Auto off': [a(true), p(-3, 'right'), a(true, 'right'), p(-4, 'right')],
		'apart, then each channel': [apartOn, b(0, 1, 'left'), b(0, 2, 'right'), b(0, 3, 'left')],
		'a band for none around setting apart': [b(0, 1), apartOn, b(0, 2), b(0, 3, 'right')],
		'the regression: linking to the right': [l([2], 'right'), keepRight, l([3], 'right')],
		'linking to the right, then apart again': [
			l([2], 'right'),
			keepRight,
			l([3], 'right'),
			apartOn,
			l([4], 'right'),
			l([5], 'right')
		],
		'linking and splitting around lists for none': [
			l([1]),
			apartOn,
			l([2]),
			b(0, 7, 'right'),
			linkedOn,
			l([3]),
			b(0, 8)
		],
		'a band for the right channel before linking': [b(0, 1, 'right'), linkedOn, b(0, 2, 'right')],
		'preamps around a channels op': [
			p(-1, 'left'),
			apartOn,
			p(-2, 'left'),
			p(-3),
			keepRight,
			p(-4)
		],
		'a band for none, apart, a band for none again': [b(1, 1), apartOn, b(1, 2, 'left'), b(1, 3)],
		'Auto around linking': [a(true, 'right'), keepRight, a(true), p(-1, 'right'), a(true, 'right')]
	};

	// Auto's value is derived, so the starts differ in how many bands each channel has.
	const starts: Record<string, LinkEq> = {
		linked: { ...flat(4), preamp: -2 },
		apart: withRight(side([100, 200, 300], -1), side([400, 500, 600, 700], -2)),
		'apart, Auto on the right': withRight(side([100, 200], -1), side([400], 0, true))
	};

	const fold = (ops: EditOp[]): EditOp[] => ops.reduce(mergeOp, [] as EditOp[]);

	for (const [name, ops] of Object.entries(sequences)) {
		it(`${name}: one by one equals the merged pending list`, () => {
			for (const [startName, start] of Object.entries(starts)) {
				for (let k = 1; k <= ops.length; k++) {
					const prefix = ops.slice(0, k);
					const merged = fold(prefix);
					assert.deepEqual(
						applyOps(start, merged, derive),
						applyOps(start, prefix, derive),
						`from ${startName}, after ${k} ops: ${JSON.stringify(prefix)} merged to ${JSON.stringify(merged)}`
					);
				}
			}
		});
	}

	// FAILS on purpose (a client bug, reported rather than worked around): `mergeOp` drops a pending
	// `preamp` for a later `auto-preamp` of any value, but `auto-preamp { on: false }` keeps the
	// preamp that was set before it, which the merged list no longer says.
	it('a fixed preamp followed by Auto off keeps the preamp', () => {
		const cases: [string, EditOp[]][] = [
			['one list', [p(-3), a(false)]],
			['one channel', [p(-3, 'right'), a(false, 'right')]]
		];
		for (const [name, ops] of cases) {
			const merged = fold(ops);
			const start = name === 'one list' ? starts.linked : starts.apart;
			assert.deepEqual(
				applyOps(start, merged, derive),
				applyOps(start, ops, derive),
				`${name}: ${JSON.stringify(ops)} merged to ${JSON.stringify(merged)}`
			);
		}
	});

	it('also holds when the pending list is flushed in the middle of the sequence', () => {
		// HostSync sends what is pending on a burst change; uniPEQ applies it, and a later op
		// merges into a fresh list. The two halves must meet the one-by-one result.
		for (const [name, ops] of Object.entries(sequences)) {
			for (let cut = 1; cut < ops.length; cut++) {
				const first = applyOps(starts.apart, fold(ops.slice(0, cut)), derive);
				const second = applyOps(first, fold(ops.slice(cut)), derive);
				assert.deepEqual(second, applyOps(starts.apart, ops, derive), `${name}, cut at ${cut}`);
			}
		}
	});
});

describe('HostSync ↔ AuthoritySync, channels', () => {
	const apartStart = (): LinkEq =>
		withRight(
			{ filters: flat(3).filters, preamp: -1, autoPreamp: false },
			{ filters: [pk(101), pk(201), pk(301)], preamp: -2, autoPreamp: false }
		);

	it('edits one channel with ch; uniPEQ echoes with right; mGT does not adopt it', () => {
		const t = pair(apartStart());
		t.mgtEdit([{ op: 'band', i: 1, filter: pk(555), ch: 'right' }]);
		t.deliver();
		assert.deepEqual(
			t.edits.map((m) => m.ops),
			[[{ op: 'band', i: 1, filter: pk(555), ch: 'right' }]]
		);
		assert.equal(t.echoes.length, 1);
		assert.deepEqual(t.echoes[0].eq, t.unipeq);
		assert.deepEqual(t.echoes[0].eq.right!.filters[1], pk(555));
		assert.deepEqual(t.echoes[0].eq.filters, apartStart().filters, 'the left one is as it was');
		assert.deepEqual(t.unipeq, t.mgt);
		assert.equal(t.adopted.length, 0);
		assert.equal(t.host.dirty, false);
		assert.deepEqual(t.host.rev, 1);
	});

	it('sends one op per channel when both change, and keeps them apart', () => {
		const t = pair(apartStart());
		t.mgtEdit([
			{ op: 'band', i: 0, filter: pk(10), ch: 'left' },
			{ op: 'band', i: 0, filter: pk(20), ch: 'right' },
			{ op: 'preamp', db: -6, ch: 'right' }
		]);
		t.deliver();
		assert.equal(t.edits[0].ops.length, 3);
		assert.deepEqual([t.unipeq.filters[0], t.unipeq.right!.filters[0]], [pk(10), pk(20)]);
		assert.deepEqual([t.unipeq.preamp, t.unipeq.right!.preamp], [-1, -6]);
		assert.equal(t.adopted.length, 0);
	});

	it('does not adopt its own echo of a channels op, and links by it', () => {
		const t = pair(flat(3));
		t.mgtEdit([{ op: 'channels', apart: true }]);
		t.deliver();
		assert.deepEqual(t.unipeq.right, flat(3));
		assert.deepEqual(t.unipeq, t.mgt);
		assert.equal(t.adopted.length, 0);
		t.mgtEdit([{ op: 'list', filters: [pk(9)], ch: 'right' }]);
		t.mgtEdit([{ op: 'channels', apart: false, keep: 'right' }]);
		t.deliver();
		assert.deepEqual(t.unipeq, { filters: [pk(9)], preamp: 0, autoPreamp: false });
		assert.deepEqual(t.unipeq, t.mgt);
		assert.equal(t.adopted.length, 0);
		assert.equal(t.host.dirty, false);
	});

	it('sends a list for the right channel before linking, then another after it, whole', () => {
		const t = pair(apartStart());
		// All inside one window: one message, which must keep the first list (regression).
		t.mgtEdit([{ op: 'list', filters: [pk(2)], ch: 'right' }]);
		t.mgtEdit([{ op: 'channels', apart: false, keep: 'right' }]);
		t.mgtEdit([{ op: 'list', filters: [pk(3)], ch: 'right' }]);
		t.deliver();
		const ops = t.edits.flatMap((m) => m.ops);
		assert.deepEqual(
			ops.filter((op) => op.op === 'list'),
			[
				{ op: 'list', filters: [pk(2)], ch: 'right' },
				{ op: 'list', filters: [pk(3)], ch: 'right' }
			]
		);
		assert.deepEqual(t.unipeq, t.mgt);
		assert.equal(t.unipeq.right, undefined);
	});

	it("adopts uniPEQ's edit of the right channel, and its linking", () => {
		const t = pair(apartStart());
		t.unipeqEdit([{ op: 'band', i: 2, filter: pk(777), ch: 'right' }]);
		t.deliver();
		assert.deepEqual(t.mgt, t.unipeq);
		assert.deepEqual(t.mgt.right!.filters[2], pk(777));
		assert.deepEqual(t.adopted, [{ by: 'unipeq', initial: true }]);
		// Linked: the same lists, but one for both is not two that match.
		t.unipeqEdit([{ op: 'channels', apart: false }]);
		t.deliver();
		assert.equal(t.mgt.right, undefined);
		assert.deepEqual(t.mgt, t.unipeq);
		assert.equal(t.adopted.length, 2);
	});

	it('adopts a uniPEQ that linked two channels which were already equal', () => {
		const same = withRight(flat(2), flat(2));
		const t = pair(same);
		t.unipeqEdit([{ op: 'channels', apart: false }]);
		t.deliver();
		assert.equal(t.adopted.length, 1, 'apart-but-equal is not one list');
		assert.deepEqual(t.mgt, flat(2));
	});

	describe('a resync', () => {
		/** mGT edits while the channel is cut, then reopens it on `minor`. Returns what it sent. */
		function resyncOn(minor: number, initial: LinkEq) {
			const t = pair(initial);
			t.host.minor = minor;
			t.mgtEdit([{ op: 'band', i: 0, filter: pk(1) }]);
			t.deliver();
			t.cut();
			const edits: EditOp[] = [{ op: 'band', i: 1, filter: pk(2) }];
			if (initial.right) edits.push({ op: 'band', i: 0, filter: pk(3), ch: 'right' });
			t.mgtEdit(edits);
			mock.timers.tick(200);
			assert.equal(t.host.dirty, true);
			t.restore();
			t.edits.length = 0;
			t.host.beginResync();
			t.authority.snapshot();
			assert.equal(t.host.receive(t.toMgt.shift()!), null);
			const sent = t.toUnipeq.map((m) => structuredClone(m));
			t.deliver();
			return { t, sent };
		}

		it('sends the channels op first on minor 3, apart', () => {
			const { t, sent } = resyncOn(3, apartStart());
			assert.equal(sent.length, 1);
			assert.deepEqual(sent[0].ops, replaceOps(t.mgt, 3));
			assert.deepEqual(sent[0].ops[0], { op: 'channels', apart: true });
			assert.equal(sent[0].settle, true);
			assert.deepEqual(t.unipeq, t.mgt);
			assert.deepEqual(t.unipeq.right!.filters[0], pk(3));
			assert.equal(t.host.dirty, false);
		});

		it('sends the channels op first on minor 3, linked', () => {
			const { t, sent } = resyncOn(3, flat(3));
			assert.deepEqual(sent[0].ops, replaceOps(t.mgt, 3));
			assert.deepEqual(sent[0].ops[0], { op: 'channels', apart: false });
			assert.deepEqual(t.unipeq, t.mgt);
		});

		it('sends no channels op, and no ch, on minor 0 and 2', () => {
			for (const minor of [0, 2]) {
				const { t, sent } = resyncOn(minor, flat(3));
				assert.deepEqual(sent[0].ops, replaceOps(t.mgt, 0));
				assert.ok(sent[0].ops.every((op) => op.op !== 'channels' && !('ch' in op)));
				assert.deepEqual(t.unipeq, t.mgt);
			}
		});

		it('sends the left channel only, with no ch, on minor 0 even when mGT has two', () => {
			const { sent } = resyncOn(0, apartStart());
			assert.equal(sent.length, 1);
			assert.ok(sent[0].ops.every((op) => op.op !== 'channels' && !('ch' in op)));
			assert.deepEqual(
				sent[0].ops.map((op) => op.op),
				['list', 'preamp']
			);
		});

		it('is on minor 0 until the hello says more', () => {
			const t = pair();
			assert.equal(t.host.minor, 0);
		});
	});
});
