// The shared-list rules (design §4.4, §4.6) without a channel: mGT's HostSync and uniPEQ's
// AuthoritySync wired back to back, with mocked timers.
//
//   node --test test/
import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it, mock } from 'node:test';
import type { EditOp, Filter, LinkEq, MessageOf } from '../client/protocol.ts';
import { applyOps, AuthoritySync, HostSync, mergeOp, Throttle } from '../client/sync.ts';

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

	it('keeps one preamp op, the latest', () => {
		let ops: EditOp[] = [{ op: 'preamp', db: -2 }];
		ops = mergeOp(ops, { op: 'auto-preamp', on: true });
		assert.deepEqual(ops, [{ op: 'auto-preamp', on: true }]);
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
					authority.receive(m, (ops) => {
						if (m.settle) settles.push(m.seq);
						const next = applyOps(unipeq, ops);
						const changed = JSON.stringify(next) !== JSON.stringify(unipeq);
						unipeq = next;
						return changed;
					});
				}
				while (toMgt.length) {
					const adopt = host.receive(toMgt.shift()!);
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
