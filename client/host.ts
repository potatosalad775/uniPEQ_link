/**
 * mGT's side of the link (design §4, §6.4): hosts the room, sends edits and commands, decides
 * whether uniPEQ is alive, and resumes the session after a reload.
 *
 *   waiting (code shown) → connecting → approval → linked ⇄ stalled → ended
 */
import { LivenessClock } from './liveness.ts';
import {
	PROTO,
	TIMINGS,
	newRoomCode,
	type ByeReason,
	type CommandArgs,
	type CommandName,
	type EditOp,
	type LinkDevice,
	type LinkEq,
	type LinkStatus,
	type Message,
	type MessageOf,
	type PauseCause,
	type Proto,
	type Timings
} from './protocol.ts';
import { Emitter, LinkSession, type Peer } from './session.ts';
import { HostSync, replaceOps, type Adopt, type EditOptions } from './sync.ts';

export type HostState = 'waiting' | 'connecting' | 'approval' | 'linked' | 'stalled' | 'ended';

/** `room-full` and `elsewhere` come from signaling (`SessionEvents['ended']`). */
export type EndReason = ByeReason | 'room-full' | 'elsewhere';

export interface Ended {
	reason: EndReason;
	/** Who ended it: this side, or the other side's `bye`. */
	by: 'self' | 'peer';
	/** The other side's `proto`, when the reason is `version`. */
	peerProto?: Proto;
}

export interface CommandResult {
	ok: boolean;
	/** uniPEQ's code (an eqcaps BridgeError code, `unsupported`, …), or `timeout`, `not-linked`. */
	code?: string;
}

export interface HostEvents {
	state: HostState;
	/** uniPEQ's attested peer. */
	peer: Peer;
	/** uniPEQ's `hello`: its app version and proto. */
	hello: MessageOf<'hello'>;
	/** A list to adopt. `initial` is the session's first, which may need the user (design §6.3). */
	eq: Adopt;
	device: LinkDevice | null;
	status: LinkStatus;
	/** uniPEQ was paused by Android for `ms`. */
	notice: { cause: PauseCause; ms: number };
	ended: Ended;
}

/** What survives a reload in `sessionStorage` (design §4.6). */
interface Saved {
	server: string;
	room: string;
	peerId: string;
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface HostOptions {
	/** The Worker's origin. */
	server: string;
	/** mGT's version, for uniPEQ's "update" message. */
	version: string;
	/** The site's title, shown under the attested host in uniPEQ's dialog. */
	site?: string;
	/** mGT's list as it is now. */
	local: () => LinkEq;
	/** Where the session survives a reload. Default `sessionStorage`; null to not keep it. */
	storage?: SessionStore | null;
	timings?: Timings;
	/** For tests. */
	proto?: Proto;
	relayOnly?: boolean;
}

const STORAGE_KEY = 'peq-link:host';

export class HostLink extends Emitter<HostEvents> {
	readonly session: LinkSession;
	/** Rejoined after a reload: uniPEQ's list is adopted without asking (design §4.6). */
	readonly resumed: boolean;
	private readonly options: HostOptions;
	private readonly timings: Timings;
	private readonly proto: Proto;
	private readonly storage: SessionStore | null;
	private readonly sync: HostSync;
	private readonly liveness: LivenessClock;
	private current: HostState = 'waiting';
	private approved = false;
	private latestDevice: LinkDevice | null = null;
	private latestStatus: LinkStatus | null = null;
	private nextCommand = 1;
	private readonly commands = new Map<
		number,
		{ resolve: (result: CommandResult) => void; timer: ReturnType<typeof setTimeout> }
	>();

	/** Use `startHost` or `resumeHost`. */
	constructor(options: HostOptions, room: string, peerId?: string) {
		super();
		this.options = options;
		this.timings = options.timings ?? TIMINGS;
		this.proto = options.proto ?? PROTO;
		this.storage = options.storage === undefined ? defaultStorage() : options.storage;
		this.resumed = peerId !== undefined;
		this.session = new LinkSession({
			server: options.server,
			room,
			peerId,
			relayOnly: options.relayOnly,
			timings: this.timings
		});
		this.sync = new HostSync((m) => this.session.send(m), options.local, this.timings.sendMs);
		this.liveness = new LivenessClock(
			(n) => this.session.send({ t: 'ping', n }),
			(state) => {
				if (state === 'ended') this.end('timeout', 'self');
				else if (state === 'stalled' && this.current === 'linked') this.setState('stalled');
				else if (state === 'alive' && this.current === 'stalled') this.setState('linked');
			},
			this.timings
		);
		this.save();

		this.session.on('peer', ({ peer, rejoin }) => {
			if (!rejoin && this.current === 'waiting') this.setState('connecting');
			this.emit('peer', peer);
		});
		this.session.on('open', () => this.onOpen());
		this.session.on('message', (message) => this.onMessage(message));
		this.session.on('ended', (reason) => this.end(reason, 'self'));
		if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
	}

	get room(): string {
		return this.session.room;
	}

	get server(): string {
		return this.session.server;
	}

	get state(): HostState {
		return this.current;
	}

	get device(): LinkDevice | null {
		return this.latestDevice;
	}

	get status(): LinkStatus | null {
		return this.latestStatus;
	}

	/** Edits uniPEQ hasn't acknowledged. */
	get dirty(): boolean {
		return this.sync.dirty;
	}

	/**
	 * mGT's own edit, already applied locally. Ignored until uniPEQ approved: the session's first
	 * list comes from uniPEQ (or from `replaceAll`, when the user picks this side's).
	 */
	edit(ops: EditOp[], options?: EditOptions): void {
		if (this.current === 'linked' || this.current === 'stalled') this.sync.edit(ops, options);
	}

	/** Sends `eq` over whole, settled: "Send this EQ to uniPEQ", AutoEQ, a loaded preset. */
	replaceAll(eq: LinkEq): void {
		this.edit(replaceOps(eq), { settle: true });
	}

	/** Effects arrive as `eq`, `status` and `device`, not in the result. */
	command<N extends CommandName>(
		name: N,
		...[args]: CommandArgs[N] extends undefined ? [] : [CommandArgs[N]]
	): Promise<CommandResult> {
		if (this.current !== 'linked' && this.current !== 'stalled')
			return Promise.resolve({ ok: false, code: 'not-linked' });
		const id = this.nextCommand++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.commands.delete(id);
				resolve({ ok: false, code: 'timeout' });
			}, this.timings.commandMs);
			this.commands.set(id, { resolve, timer });
			const message: Message = { t: 'cmd', id, name };
			if (args !== undefined) message.args = args;
			// Not sent (channel down): the timeout answers, as for a lost answer.
			this.session.send(message);
		});
	}

	/** Ends the session on both sides. */
	unlink(): void {
		this.end('unlink', 'self');
	}

	private onOpen(): void {
		this.sync.beginResync();
		this.session.send({
			t: 'hello',
			proto: this.proto,
			app: 'mgt',
			version: this.options.version,
			...(this.options.site ? { site: this.options.site } : {}),
			...this.sync.helloFields()
		});
		this.liveness.start();
	}

	private onMessage(message: Message): void {
		if (this.current === 'ended') return;
		this.liveness.heard();
		switch (message.t) {
			case 'hello':
				if (message.proto[0] !== this.proto[0]) {
					this.end('version', 'self', message.proto);
					return;
				}
				this.emit('hello', message);
				break;
			case 'approval':
				this.approved = message.state === 'approved';
				if (this.approved) {
					if (this.current !== 'linked') this.setState('linked');
				} else this.setState('approval');
				break;
			case 'bye':
				this.end(message.reason, 'peer', message.proto);
				break;
			case 'eq': {
				if (!this.approved) break;
				const adopt = this.sync.receive(message);
				if (adopt) this.emit('eq', this.resumed ? { ...adopt, initial: false } : adopt);
				break;
			}
			case 'device':
				this.latestDevice = message.device;
				this.emit('device', message.device);
				break;
			case 'status':
				this.latestStatus = message.status;
				this.emit('status', message.status);
				break;
			case 're': {
				const pending = this.commands.get(message.id);
				if (!pending) break;
				this.commands.delete(message.id);
				clearTimeout(pending.timer);
				pending.resolve(message.code ? { ok: message.ok, code: message.code } : { ok: message.ok });
				break;
			}
			case 'notice':
				if (message.kind === 'paused')
					this.emit('notice', { cause: message.cause, ms: message.ms });
				break;
		}
	}

	/**
	 * Best effort: uniPEQ then waits `awayMs` for a rejoin. `pagehide` can't tell a reload from a
	 * close, so this never sends `bye`.
	 */
	private readonly onPageHide = (): void => {
		if (this.current !== 'ended') this.session.send({ t: 'away' });
	};

	private end(reason: EndReason, by: 'self' | 'peer', peerProto?: Proto): void {
		if (this.current === 'ended') return;
		if (by === 'self' && reason !== 'room-full' && reason !== 'elsewhere') {
			const bye: Message = { t: 'bye', reason };
			if (reason === 'version') bye.proto = this.proto;
			this.session.send(bye);
		}
		this.liveness.stop();
		this.sync.stop();
		for (const { resolve, timer } of this.commands.values()) {
			clearTimeout(timer);
			resolve({ ok: false, code: 'not-linked' });
		}
		this.commands.clear();
		if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
		// Another tab took this session over: its storage entry is its own now.
		if (reason !== 'elsewhere') this.storage?.removeItem(STORAGE_KEY);
		// Let the `bye` leave before the connection goes.
		setTimeout(() => this.session.close(), 100);
		this.setState('ended');
		this.emit('ended', peerProto ? { reason, by, peerProto } : { reason, by });
	}

	private setState(state: HostState): void {
		if (state === this.current) return;
		this.current = state;
		this.emit('state', state);
	}

	private save(): void {
		const saved: Saved = { server: this.server, room: this.room, peerId: this.session.peerId };
		try {
			this.storage?.setItem(STORAGE_KEY, JSON.stringify(saved));
		} catch {
			// Storage full or blocked: the session just won't survive a reload.
		}
	}
}

/** A new room, with a new code. */
export function startHost(options: HostOptions): HostLink {
	return new HostLink(options, newRoomCode());
}

/**
 * The session this tab had before a reload, or null. It rejoins with the same peer id, so the room
 * replaces the old socket, uniPEQ keeps its approval, and the channel is rebuilt (design §4.6).
 */
export function resumeHost(options: HostOptions): HostLink | null {
	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	let saved: Saved | null = null;
	try {
		saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
	} catch {
		return null;
	}
	if (!saved || saved.server !== new URL(options.server).origin) return null;
	return new HostLink(options, saved.room, saved.peerId);
}

function defaultStorage(): SessionStore | null {
	try {
		return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
	} catch {
		return null;
	}
}
