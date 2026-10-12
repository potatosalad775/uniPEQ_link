/**
 * Keeping the shared list in step (design §4.4, §4.6). uniPEQ is the authority: it applies mGT's
 * edits, numbers every change (`rev`) and echoes the list back. mGT edits optimistically and
 * adopts what uniPEQ echoes once uniPEQ has seen all of mGT's edits (`ack`).
 *
 * Neither class touches the channel or a store: they take a `send` and getters, so the apps keep
 * their own state and the rules can be tested without a peer.
 */
import {
	eqEqual,
	TIMINGS,
	type EditOp,
	type Editor,
	type LinkEq,
	type MessageOf
} from './protocol.ts';

/**
 * Sends at most once per `ms`: the first call at once, later ones together after the window, so a
 * drag costs 20 messages a second and the last state always goes out.
 */
export class Throttle {
	private readonly ms: number;
	private readonly run: () => void;
	private lastAt = -Infinity;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(ms: number, run: () => void) {
		this.ms = ms;
		this.run = run;
	}

	request(): void {
		if (this.timer !== null) return;
		const wait = this.lastAt + this.ms - Date.now();
		if (wait <= 0) this.now();
		else this.timer = setTimeout(() => this.now(), wait);
	}

	/** Runs now and cancels the pending run. */
	now(): void {
		this.cancel();
		this.lastAt = Date.now();
		this.run();
	}

	cancel(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}

/**
 * The ops as one list op sequence that sets `eq` outright: what a resync or "Send this EQ to
 * uniPEQ" sends.
 */
export function replaceOps(eq: LinkEq): EditOp[] {
	return [
		{ op: 'list', filters: eq.filters },
		eq.autoPreamp ? { op: 'auto-preamp', on: true } : { op: 'preamp', db: eq.preamp }
	];
}

/**
 * Adds `op` to pending ops, dropping the ones it supersedes. Order only matters between a `list`
 * and the bands before it, and a `list` drops those.
 */
export function mergeOp(pending: EditOp[], op: EditOp): EditOp[] {
	const kept = pending.filter((old) => {
		switch (op.op) {
			case 'list':
				return old.op !== 'list' && old.op !== 'band';
			case 'band':
				return !(old.op === 'band' && old.i === op.i);
			case 'preamp':
			case 'auto-preamp':
				return old.op !== 'preamp' && old.op !== 'auto-preamp';
			default:
				return true;
		}
	});
	return [...kept, op];
}

/**
 * The reference meaning of each op, for tests and fakes. uniPEQ applies ops through its own store,
 * which also projects a band onto its slot. `derivePreamp` gives Auto's value.
 */
export function applyOps(
	eq: LinkEq,
	ops: EditOp[],
	derivePreamp: (filters: LinkEq['filters']) => number = () => 0
): LinkEq {
	let { filters, preamp, autoPreamp } = eq;
	for (const op of ops) {
		switch (op.op) {
			case 'band':
				if (op.i < filters.length) filters = filters.map((f, i) => (i === op.i ? op.filter : f));
				break;
			case 'list':
				filters = op.filters;
				break;
			case 'preamp':
				preamp = op.db;
				autoPreamp = false;
				break;
			case 'auto-preamp':
				autoPreamp = op.on;
				break;
		}
	}
	if (autoPreamp) preamp = derivePreamp(filters);
	return { filters, preamp, autoPreamp };
}

// ── mGT ──────────────────────────────────────────────────────────────────────────────────────

export interface EditOptions {
	/** Shared by one gesture's edits: uniPEQ makes them one undo step. */
	burst?: string;
	/** The gesture ended: uniPEQ writes now, if auto-write is on. */
	settle?: boolean;
}

/** What mGT should do with an `eq` from uniPEQ. */
export interface Adopt {
	eq: LinkEq;
	rev: number;
	by: Editor;
	burst?: string;
	/** An undo barrier: undoing past it would hand the device another device's bands. */
	fresh: boolean;
	/** The session's first list, which mGT may want to ask about (design §6.3). */
	initial: boolean;
}

export class HostSync {
	/** The last `seq` sent. */
	private seq = 0;
	/** The last `seq` uniPEQ acknowledged. */
	private acked = 0;
	private pending: EditOp[] = [];
	private burst: string | undefined;
	private settle = false;
	/** The last `eq` adopted, or null before the first. */
	private lastRev: number | null = null;
	/** The next `eq` is the snapshot after a channel open. */
	private resyncing = false;
	private readonly throttle: Throttle;
	private readonly send: (message: MessageOf<'edit'>) => boolean;
	/** mGT's list as it is now, including edits not yet acknowledged. */
	private readonly local: () => LinkEq;

	constructor(
		send: (message: MessageOf<'edit'>) => boolean,
		local: () => LinkEq,
		sendMs = TIMINGS.sendMs
	) {
		this.send = send;
		this.local = local;
		this.throttle = new Throttle(sendMs, () => this.flush());
	}

	/** Edits uniPEQ hasn't acknowledged, sent or not. */
	get dirty(): boolean {
		return this.pending.length > 0 || this.seq > this.acked;
	}

	get rev(): number | null {
		return this.lastRev;
	}

	/** mGT's own edit, already applied locally. */
	edit(ops: EditOp[], { burst, settle = false }: EditOptions = {}): void {
		// One gesture's ops never ride with another's, or uniPEQ's undo steps would merge.
		if (this.pending.length && burst !== this.burst) this.throttle.now();
		for (const op of ops) this.pending = mergeOp(this.pending, op);
		this.burst = burst;
		this.settle ||= settle;
		if (this.pending.length || this.settle) this.throttle.request();
	}

	/** The channel opened: the next `eq` is uniPEQ's snapshot. */
	beginResync(): void {
		this.resyncing = true;
		this.throttle.cancel();
	}

	/** `hello`'s resync fields. */
	helloFields(): { lastRev: number | null; dirty: boolean } {
		return { lastRev: this.lastRev, dirty: this.dirty };
	}

	/**
	 * An `eq` from uniPEQ: what to adopt, or null when there's nothing to adopt: mGT's own edits
	 * will overwrite it, or it's the list mGT already has.
	 */
	receive(message: MessageOf<'eq'>): Adopt | null {
		const adopt: Adopt = {
			eq: message.eq,
			rev: message.rev,
			by: message.by,
			burst: message.burst,
			fresh: message.fresh === true,
			initial: this.lastRev === null
		};
		if (this.resyncing) {
			this.resyncing = false;
			// A reload starts mGT's count again; uniPEQ's ack is the session's.
			this.seq = Math.max(this.seq, message.ack);
			const keepMine = this.dirty && message.rev === this.lastRev;
			this.pending = [];
			this.settle = false;
			this.acked = this.seq;
			if (keepMine) {
				// Nothing changed in uniPEQ while apart: mGT's list goes over whole.
				this.edit(replaceOps(this.local()), { settle: true });
				return null;
			}
			// Otherwise uniPEQ's list wins, even if mGT changed things too.
			this.lastRev = message.rev;
			return eqEqual(message.eq, this.local()) ? null : adopt;
		}
		this.acked = Math.max(this.acked, message.ack);
		// An edit of mGT's own is still in flight or waiting, and will overwrite this.
		if (this.dirty) return null;
		this.lastRev = message.rev;
		return eqEqual(message.eq, this.local()) ? null : adopt;
	}

	/** Session over: nothing more goes out. */
	stop(): void {
		this.throttle.cancel();
		this.pending = [];
	}

	private flush(): void {
		if (!this.pending.length && !this.settle) return;
		const message: MessageOf<'edit'> = { t: 'edit', seq: this.seq + 1, ops: this.pending };
		if (this.burst !== undefined) message.burst = this.burst;
		if (this.settle) message.settle = true;
		// A closed channel keeps them pending: dirty, and resent as a whole list on resync.
		if (!this.send(message)) return;
		this.seq++;
		this.pending = [];
		this.settle = false;
	}
}

// ── uniPEQ ───────────────────────────────────────────────────────────────────────────────────

export interface Change {
	by: Editor;
	burst?: string;
	/** A read from the device or a preset switch (`eqStore.open`). */
	fresh?: boolean;
}

export class AuthoritySync {
	private rev = 0;
	/** The last mGT `seq` applied, kept across channels for the session. */
	private ack = 0;
	private last: Change = { by: 'unipeq' };
	private fresh = false;
	private readonly throttle: Throttle;
	private readonly send: (message: MessageOf<'eq'>) => boolean;
	/** uniPEQ's list as it is now. */
	private readonly current: () => LinkEq;

	constructor(
		send: (message: MessageOf<'eq'>) => boolean,
		current: () => LinkEq,
		sendMs = TIMINGS.sendMs
	) {
		this.send = send;
		this.current = current;
		this.throttle = new Throttle(sendMs, () => this.broadcast());
	}

	/**
	 * An `edit` from mGT. `apply` applies the ops (or not, while uniPEQ can't edit) and says whether
	 * the list changed. It's called for an empty `settle` too, which writes. An `eq` follows either
	 * way: it acknowledges the edit, and puts mGT back when the ops were refused.
	 */
	receive(message: MessageOf<'edit'>, apply: (ops: EditOp[]) => boolean): void {
		this.ack = Math.max(this.ack, message.seq);
		const changed = apply(message.ops);
		if (changed) this.changed({ by: 'mgt', burst: message.burst });
		else this.throttle.request();
	}

	/** uniPEQ's list changed: an edit of its own, mGT's (through `receive`), or a device read. */
	changed(change: Change): void {
		this.rev++;
		this.last = change;
		// Sticky until sent: two changes in one window mustn't lose the undo barrier.
		this.fresh ||= change.fresh === true;
		this.throttle.request();
	}

	/** The full snapshot, now: after approval and on every `hello` (§4.6). */
	snapshot(): void {
		this.throttle.now();
	}

	stop(): void {
		this.throttle.cancel();
	}

	private broadcast(): void {
		const message: MessageOf<'eq'> = {
			t: 'eq',
			rev: this.rev,
			ack: this.ack,
			by: this.last.by,
			eq: this.current()
		};
		if (this.last.burst !== undefined) message.burst = this.last.burst;
		if (this.fresh) message.fresh = true;
		if (this.send(message)) this.fresh = false;
	}
}
