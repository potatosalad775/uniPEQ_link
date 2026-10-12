/**
 * One link's transport: the signaling WebSocket, the RTCPeerConnection and its DataChannel, with
 * the rules Phase 0 fixed (docs/phase-0.md, design §4.7). It carries messages; what they mean is
 * `host.ts` and `joiner.ts`'s business.
 *
 * - Whoever sees `peer-joined` with a new peer id offers: a new id is a fresh page or app session.
 * - The same id again is a rejoin and changes nothing. The rejoining side sends `fresh` only if
 *   its own end is dead, and the other side then rebuilds as the offerer.
 * - On `failed`, the offerer restarts ICE and the answerer asks it to (`restart`).
 * - `peer-left` is advisory: the DataChannel may outlive a peer's signaling socket.
 * - Signaling reconnects with backoff, reset and retried at once when the page is visible again
 *   or back online: a phone browser loses its network ~5 s after going to the background.
 */
import {
	CHANNEL_LABEL,
	MAX_MESSAGE,
	parseMessage,
	TIMINGS,
	type Message,
	type Timings
} from './protocol.ts';

/** A peer as the room attests it. */
export interface Peer {
	id: string;
	/**
	 * The Origin of the peer's WebSocket upgrade. Browsers can't fake it; other native apps can,
	 * so it's a label for the approval dialog, not authentication.
	 */
	origin: string;
	userAgent: string;
	joinedAt: number;
}

export type SignalingState = 'connecting' | 'open' | 'closed';

export interface SessionEvents {
	signaling: SignalingState;
	/** The other peer: in `welcome`, or joining. `rejoin` when it's the same peer id again. */
	peer: { peer: Peer; rejoin: boolean };
	'peer-left': Peer;
	connection: RTCPeerConnectionState;
	/** The DataChannel opened: every open, including after a rebuild, starts with `hello`. */
	open: void;
	close: void;
	message: Message;
	/**
	 * Signaling can't go on: the room already had two peers, or another tab took this peer id
	 * over (a duplicated tab copies `sessionStorage`).
	 */
	ended: 'room-full' | 'elsewhere';
}

type Listener<T> = (value: T) => void;

/** A minimal typed event emitter. */
export class Emitter<Events> {
	private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

	/** Returns the unsubscribe. */
	on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
		let set = this.listeners.get(type);
		if (!set) this.listeners.set(type, (set = new Set()));
		set.add(listener as Listener<never>);
		return () => set.delete(listener as Listener<never>);
	}

	protected emit<K extends keyof Events>(
		type: K,
		...[value]: Events[K] extends void ? [] : [Events[K]]
	): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			try {
				(listener as Listener<Events[K]>)(value as Events[K]);
			} catch (error) {
				console.error(`peq-link: a '${String(type)}' listener threw`, error);
			}
		}
	}
}

export interface SessionOptions {
	/** The Worker's origin, e.g. `https://link.unipeq.com`. */
	server: string;
	room: string;
	/**
	 * Stable per tab or app session. Pass the saved one to resume after a reload: the room then
	 * replaces the old socket instead of announcing a new peer, and this side sends `fresh`.
	 */
	peerId?: string;
	/** Force the TURN relay (`iceTransportPolicy: 'relay'`), for testing. */
	relayOnly?: boolean;
	timings?: Timings;
}

type SignalData =
	| { description: RTCSessionDescriptionInit }
	| { candidate: RTCIceCandidateInit }
	| { fresh: true }
	| { restart: true };

export class LinkSession extends Emitter<SessionEvents> {
	readonly server: string;
	readonly room: string;
	readonly peerId: string;
	private readonly resumed: boolean;
	private readonly relayOnly: boolean;
	private readonly timings: Timings;

	private ws: WebSocket | null = null;
	private pc: RTCPeerConnection | null = null;
	private channel: RTCDataChannel | null = null;
	private iceServers: RTCIceServer[] = [];
	private offerer = false;
	private other: Peer | null = null;
	private stopped = false;
	private reconnectDelay: number;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly keepalive: ReturnType<typeof setInterval>;
	private signalingState: SignalingState = 'connecting';

	constructor({ server, room, peerId, relayOnly = false, timings = TIMINGS }: SessionOptions) {
		super();
		this.server = new URL(server).origin;
		this.room = room;
		this.peerId = peerId ?? crypto.randomUUID();
		this.resumed = peerId !== undefined;
		this.relayOnly = relayOnly;
		this.timings = timings;
		this.reconnectDelay = timings.backoffMs;
		this.keepalive = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping');
		}, timings.keepaliveMs);
		if (typeof document !== 'undefined')
			for (const type of LIFECYCLE) document.addEventListener(type, this.onLifecycle);
		if (typeof window !== 'undefined') window.addEventListener('online', this.reconnectNow);
		this.connectSignaling();
	}

	/** The other peer as last attested, or null before it joined. */
	get peer(): Peer | null {
		return this.other;
	}

	get signaling(): SignalingState {
		return this.signalingState;
	}

	get open(): boolean {
		return this.channel?.readyState === 'open';
	}

	/** For diagnostics (`getStats()`), and for tests that need to kill it. */
	get connection(): RTCPeerConnection | null {
		return this.pc;
	}

	/** False when the channel isn't open, or the message is too large: nothing was sent. */
	send(message: Message): boolean {
		if (this.channel?.readyState !== 'open') return false;
		const text = JSON.stringify(message);
		if (text.length > MAX_MESSAGE) {
			console.error(`peq-link: a '${message.t}' message over 64 KiB was not sent`);
			return false;
		}
		try {
			this.channel.send(text);
			return true;
		} catch {
			return false;
		}
	}

	/** Leaves the room. Send `bye` first: this doesn't tell the other side anything. */
	close(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
		clearInterval(this.keepalive);
		if (typeof document !== 'undefined')
			for (const type of LIFECYCLE) document.removeEventListener(type, this.onLifecycle);
		if (typeof window !== 'undefined') window.removeEventListener('online', this.reconnectNow);
		this.pc?.close();
		this.pc = null;
		this.ws?.close(1000, 'session ended');
	}

	/** Retries signaling now, not after the backoff. */
	readonly reconnectNow = (): void => {
		this.reconnectDelay = this.timings.backoffMs;
		if (this.stopped || this.reconnectTimer === null) return;
		clearTimeout(this.reconnectTimer);
		this.connectSignaling();
	};

	private readonly onLifecycle = (): void => {
		if (document.visibilityState === 'visible') this.reconnectNow();
	};

	// ── Signaling ────────────────────────────────────────────────────────────────────────────

	private connectSignaling(): void {
		this.reconnectTimer = null;
		const url = new URL(`/api/rooms/${this.room}`, this.server);
		url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
		url.searchParams.set('peer', this.peerId);
		const ws = new WebSocket(url);
		this.ws = ws;
		this.setSignaling('connecting');
		ws.onopen = () => {
			if (ws !== this.ws) return;
			this.reconnectDelay = this.timings.backoffMs;
			this.setSignaling('open');
		};
		ws.onmessage = ({ data }) => {
			if (ws !== this.ws || data === 'pong' || typeof data !== 'string') return;
			try {
				void this.onSignalingMessage(JSON.parse(data));
			} catch {
				// Not from the room.
			}
		};
		ws.onclose = ({ code }) => {
			if (ws !== this.ws) return;
			this.setSignaling('closed');
			if (this.stopped) return;
			// Replaced by a newer socket with this peer id: that one is the session now.
			if (code === 4002) return this.end('elsewhere');
			this.reconnectTimer = setTimeout(() => this.connectSignaling(), this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.timings.backoffMaxMs);
		};
	}

	private signal(data: SignalData): void {
		if (this.ws?.readyState === WebSocket.OPEN)
			this.ws.send(JSON.stringify({ type: 'signal', data }));
	}

	private async onSignalingMessage(message: {
		type: string;
		[key: string]: unknown;
	}): Promise<void> {
		switch (message.type) {
			case 'welcome': {
				this.iceServers = message.iceServers as RTCIceServer[];
				const [other] = message.peers as Peer[];
				if (!other) break;
				const rejoin = other.id === this.other?.id;
				this.other = other;
				this.emit('peer', { peer: other, rejoin });
				const state = this.pc?.connectionState;
				if (!this.pc) {
					// A resumed page has the old peer id, so the other side sees a rejoin and waits:
					// this side has to ask for a new connection. A new id gets an offer by itself.
					this.offerer = false;
					this.createPeerConnection();
					if (this.resumed) this.signal({ fresh: true });
				} else if (state === 'failed' || state === 'closed') {
					// An ICE restart can't carry a new DTLS fingerprint into the old connection, so
					// both ends start over.
					this.offerer = false;
					this.createPeerConnection();
					this.signal({ fresh: true });
				}
				break;
			}
			case 'peer-joined': {
				const peer = message.peer as Peer;
				// The same id again: its socket dropped and came back, and the channel may still be
				// up. It decides from its own `welcome` and sends `fresh` if its end is dead.
				if (peer.id === this.other?.id && this.pc) {
					this.other = peer;
					this.emit('peer', { peer, rejoin: true });
					break;
				}
				const rejoin = peer.id === this.other?.id;
				this.other = peer;
				this.emit('peer', { peer, rejoin });
				if (this.resumed && !this.pc) {
					// Resumed while the other side's socket was down: it still holds a connection to
					// this peer id, so it has to be asked to start over rather than be offered to.
					this.offerer = false;
					this.createPeerConnection();
					this.signal({ fresh: true });
					break;
				}
				this.offerer = true;
				this.createPeerConnection();
				break;
			}
			case 'peer-left':
				this.emit('peer-left', message.peer as Peer);
				break;
			case 'signal':
				await this.onSignal(message.data as SignalData);
				break;
			case 'error':
				if (message.code === 'room-full') this.end('room-full');
				break;
		}
	}

	private async onSignal(data: SignalData): Promise<void> {
		const pc = this.pc;
		try {
			if ('fresh' in data) {
				this.offerer = true;
				this.createPeerConnection();
			} else if (!pc) {
				// Nothing to apply it to yet; the offer that matters comes after a `fresh`.
			} else if ('description' in data) {
				await pc.setRemoteDescription(data.description);
				if (data.description.type === 'offer') {
					await pc.setLocalDescription();
					this.signal({ description: pc.localDescription!.toJSON() });
				}
			} else if ('candidate' in data) {
				await pc.addIceCandidate(data.candidate);
			} else if ('restart' in data && this.offerer) {
				pc.restartIce();
			}
		} catch (error) {
			console.warn('peq-link: signaling step failed', error);
		}
	}

	// ── Peer connection ──────────────────────────────────────────────────────────────────────

	private createPeerConnection(): void {
		this.pc?.close();
		const pc = new RTCPeerConnection({
			iceServers: this.iceServers,
			iceTransportPolicy: this.relayOnly ? 'relay' : 'all'
		});
		this.pc = pc;
		pc.onicecandidate = ({ candidate }) => {
			if (candidate && pc === this.pc) this.signal({ candidate: candidate.toJSON() });
		};
		pc.onconnectionstatechange = () => {
			if (pc !== this.pc) return;
			this.emit('connection', pc.connectionState);
			if (pc.connectionState !== 'failed') return;
			if (this.offerer) pc.restartIce();
			else this.signal({ restart: true });
		};
		if (this.offerer) {
			pc.onnegotiationneeded = async () => {
				try {
					await pc.setLocalDescription();
					if (pc === this.pc) this.signal({ description: pc.localDescription!.toJSON() });
				} catch (error) {
					console.warn('peq-link: offer failed', error);
				}
			};
		}

		// Negotiated on both sides with a fixed id, so neither waits for `ondatachannel`.
		const channel = pc.createDataChannel(CHANNEL_LABEL, { negotiated: true, id: 0, ordered: true });
		this.channel = channel;
		channel.onopen = () => {
			if (channel === this.channel) this.emit('open');
		};
		channel.onclose = () => {
			if (channel === this.channel) this.emit('close');
		};
		channel.onmessage = ({ data }) => {
			if (channel !== this.channel) return;
			const message = parseMessage(data);
			if (message) this.emit('message', message);
		};
	}

	private setSignaling(state: SignalingState): void {
		this.signalingState = state;
		this.emit('signaling', state);
	}

	private end(reason: 'room-full' | 'elsewhere'): void {
		this.close();
		this.emit('ended', reason);
	}
}

const LIFECYCLE = ['visibilitychange', 'pageshow', 'resume'];
