/**
 * uniPEQ's side of the link (design §2.3, §4, §5.2): joins the room the user picked, asks for
 * approval, then owns the shared list. Nothing mGT sends touches the device until the user
 * approves.
 *
 *   joining → approval (dialog) → linked ⇄ waiting (for mGT) → ended
 *
 * Device work runs in the handler of the message that asked for it (`edit` with `settle`, `cmd`),
 * never behind a timer: messages wake the CPU in Doze, timers drift (Phase 0 consequence 2).
 */
import { GraceClock } from './liveness.ts';
import {
	COMMANDS,
	PROTO,
	TIMINGS,
	type ByeReason,
	type CommandArgs,
	type CommandName,
	type EditOp,
	type LinkDevice,
	type LinkEq,
	type LinkStatus,
	type Message,
	type PauseCause,
	type Proto,
	type Timings
} from './protocol.ts';
import type { CommandResult, Ended, EndReason } from './host.ts';
import { Emitter, LinkSession, type Peer } from './session.ts';
import { AuthoritySync, type Change } from './sync.ts';

export type JoinerState = 'joining' | 'approval' | 'linked' | 'waiting' | 'ended';

export interface ApprovalRequest {
	/** mGT's attested peer: show `new URL(host.origin).host`, never mGT's own claim. */
	host: Peer;
	/** The site title from mGT's `hello`, once it arrived: secondary text. */
	site?: string;
	/**
	 * The server, when it isn't uniPEQ's default: the dialog adds "via <host>", because only the
	 * default server's attestation is trusted.
	 */
	via?: string;
}

export interface JoinerEvents {
	state: JoinerState;
	/** Show (or update) "Link with <host>?". Again with `site` once mGT's `hello` arrives. */
	request: ApprovalRequest;
	ended: Ended;
}

export interface JoinerHandlers {
	eq(): LinkEq;
	device(): LinkDevice | null;
	status(): LinkStatus;
	/**
	 * mGT's ops, to apply through the EQ store as one undo step per `burst` (coalesce key
	 * `link:<burst>`). Returns whether the list changed; while uniPEQ can't edit, apply nothing and
	 * return false. On `settle`, write now if auto-write is on, in this call (design §4.4).
	 */
	edit(ops: EditOp[], meta: { burst?: string; settle: boolean }): boolean;
	/** Holds a wake lock while it touches the device (design §5.2). */
	command<N extends CommandName>(name: N, args: CommandArgs[N]): Promise<CommandResult>;
}

export interface JoinerOptions {
	server: string;
	room: string;
	/** uniPEQ's version, for mGT's "update" message. */
	version: string;
	handlers: JoinerHandlers;
	/** uniPEQ's default server. Another one is named in the dialog. */
	defaultServer?: string;
	/** Whether uniPEQ is in front (Capacitor's `appStateChange`). Default true. */
	foreground?: boolean;
	timings?: Timings;
	/** For tests. */
	proto?: Proto;
	relayOnly?: boolean;
}

/** Messages answered before approval. Everything else gets `approval: pending`. */
const BEFORE_APPROVAL = new Set(['hello', 'ping', 'bye', 'away']);
/** How long a denial waits for the channel to say so, before leaving anyway. */
const DENY_WAIT_MS = 10_000;

export class JoinerLink extends Emitter<JoinerEvents> {
	readonly session: LinkSession;
	private readonly options: JoinerOptions;
	private readonly timings: Timings;
	private readonly proto: Proto;
	private readonly sync: AuthoritySync;
	private current: JoinerState = 'joining';
	private host: Peer | null = null;
	private site: string | undefined;
	/** The mGT peer id the user approved: the session's key, kept across rejoins and reloads. */
	private approvedId: string | null = null;
	private denied = false;
	private grace: GraceClock | null = null;
	private foreground: boolean;
	private silence: ReturnType<typeof setTimeout> | null = null;

	constructor(options: JoinerOptions) {
		super();
		this.options = options;
		this.timings = options.timings ?? TIMINGS;
		this.proto = options.proto ?? PROTO;
		this.foreground = options.foreground ?? true;
		this.session = new LinkSession({
			server: options.server,
			room: options.room,
			relayOnly: options.relayOnly,
			timings: this.timings
		});
		this.sync = new AuthoritySync(
			(m) => this.session.send(m),
			() => options.handlers.eq(),
			this.timings.sendMs
		);
		this.session.on('peer', ({ peer }) => this.onHost(peer));
		this.session.on('open', () => this.onOpen());
		this.session.on('message', (message) => this.onMessage(message));
		this.session.on('ended', (reason) => this.end(reason, 'self'));
	}

	get state(): JoinerState {
		return this.current;
	}

	get approved(): boolean {
		return this.host !== null && this.approvedId === this.host.id;
	}

	/** The user approved. Kept until the channel opens if it isn't open yet. */
	approve(): void {
		if (!this.host || this.current === 'ended') return;
		this.approvedId = this.host.id;
		this.grace?.stop();
		this.grace = new GraceClock(() => this.end('timeout', 'self'), this.foreground, this.timings);
		this.setState('linked');
		if (this.session.open) this.sendApproved();
		this.watchSilence();
	}

	/** "Don't link": tells mGT, then leaves the room. */
	deny(): void {
		if (this.current === 'ended') return;
		this.denied = true;
		if (this.session.open) this.end('denied', 'self');
		else setTimeout(() => this.end('denied', 'self'), DENY_WAIT_MS);
	}

	/** Unlink, or `replaced` when the user accepted another link. */
	close(reason: ByeReason = 'unlink'): void {
		this.end(reason, 'self');
	}

	/** uniPEQ's list changed: its own edit, or a device read (`fresh`). Not for mGT's edits. */
	changed(change: Change): void {
		if (this.approved) this.sync.changed(change);
	}

	sendDevice(): void {
		if (this.approved) this.session.send({ t: 'device', device: this.options.handlers.device() });
	}

	sendStatus(): void {
		if (this.approved) this.session.send({ t: 'status', status: this.options.handlers.status() });
	}

	/** The self-check saw a pause (design §5.3). */
	notice(cause: PauseCause, ms: number): void {
		if (this.approved) this.session.send({ t: 'notice', kind: 'paused', cause, ms });
	}

	/** From Capacitor's `appStateChange`: mGT's silence only counts while uniPEQ is in the back. */
	setForeground(foreground: boolean): void {
		this.foreground = foreground;
		this.grace?.setForeground(foreground);
	}

	private onHost(peer: Peer): void {
		const isNew = peer.id !== this.host?.id;
		this.host = peer;
		if (!isNew || this.current === 'ended') return;
		// A new peer id is a new session: a new tab, or mGT's storage gone. Ask again.
		this.site = undefined;
		if (this.approvedId !== null) {
			this.grace?.stop();
			this.grace = null;
			this.sync.stop();
		}
		this.setState('approval');
		this.emit('request', this.request());
	}

	private onOpen(): void {
		this.session.send({
			t: 'hello',
			proto: this.proto,
			app: 'unipeq',
			version: this.options.version
		});
		if (this.denied) this.end('denied', 'self');
	}

	private onMessage(message: Message): void {
		if (this.current === 'ended') return;
		if (this.approved) {
			this.grace?.heard();
			this.watchSilence();
		}
		if (!this.approved && !BEFORE_APPROVAL.has(message.t)) {
			this.session.send({ t: 'approval', state: 'pending' });
			return;
		}
		switch (message.t) {
			case 'hello':
				if (message.proto[0] !== this.proto[0]) {
					this.end('version', 'self', message.proto);
					return;
				}
				if (message.site !== this.site) {
					this.site = message.site;
					if (!this.approved) this.emit('request', this.request());
				}
				if (this.approved) this.sendApproved();
				else this.session.send({ t: 'approval', state: 'pending' });
				break;
			case 'ping':
				// From the handler, never a timer: this is what tells mGT uniPEQ is alive.
				this.session.send({ t: 'pong', n: message.n });
				break;
			case 'bye':
				this.end(message.reason, 'peer', message.proto);
				break;
			case 'away':
				this.grace?.away();
				break;
			case 'edit':
				this.sync.receive(message, (ops) =>
					this.options.handlers.edit(ops, {
						burst: message.burst,
						settle: message.settle === true
					})
				);
				break;
			case 'cmd':
				void this.onCommand(message.id, message.name, message.args);
				break;
		}
	}

	private async onCommand(id: number, name: CommandName, args: unknown): Promise<void> {
		let result: CommandResult;
		if (!COMMANDS.includes(name)) result = { ok: false, code: 'unsupported' };
		else {
			try {
				result = await this.options.handlers.command(name, args as CommandArgs[CommandName]);
			} catch (error) {
				console.error(`peq-link: command '${name}' threw`, error);
				result = { ok: false, code: 'failed' };
			}
		}
		this.session.send({ t: 're', id, ...result });
	}

	/** Approval, then the full snapshot: every message from uniPEQ is one, so a resync is a resend. */
	private sendApproved(): void {
		this.session.send({ t: 'approval', state: 'approved' });
		this.sendDevice();
		this.sendStatus();
		this.sync.snapshot();
	}

	/** "Waiting for modernGraphTool" after `stallMs` without a message. Display only. */
	private watchSilence(): void {
		if (this.silence !== null) clearTimeout(this.silence);
		if (this.current === 'waiting') this.setState('linked');
		this.silence = setTimeout(() => {
			this.silence = null;
			if (this.current === 'linked') this.setState('waiting');
		}, this.timings.stallMs);
	}

	private request(): ApprovalRequest {
		const request: ApprovalRequest = { host: this.host! };
		if (this.site) request.site = this.site;
		const server = new URL(this.options.server).origin;
		const fallback = this.options.defaultServer;
		if (fallback && new URL(fallback).origin !== server) request.via = new URL(server).host;
		return request;
	}

	private end(reason: EndReason, by: 'self' | 'peer', peerProto?: Proto): void {
		if (this.current === 'ended') return;
		if (by === 'self' && reason !== 'room-full' && reason !== 'elsewhere') {
			const bye: Message = { t: 'bye', reason };
			if (reason === 'version') bye.proto = this.proto;
			this.session.send(bye);
		}
		this.grace?.stop();
		this.sync.stop();
		if (this.silence !== null) clearTimeout(this.silence);
		setTimeout(() => this.session.close(), 100);
		this.setState('ended');
		this.emit('ended', peerProto ? { reason, by, peerProto } : { reason, by });
	}

	private setState(state: JoinerState): void {
		if (state === this.current) return;
		this.current = state;
		this.emit('state', state);
	}
}

export function startJoiner(options: JoinerOptions): JoinerLink {
	return new JoinerLink(options);
}
