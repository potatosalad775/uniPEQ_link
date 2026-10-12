/**
 * Phase 0 link probe (docs/phase-0.md): one WebRTC DataChannel between two peers through the
 * signaling Worker, with heartbeats and pings that show what backgrounding does to each side.
 *
 * Plain JS with no imports, because the same file runs in the probe page and, injected by
 * scripts/android-link-probe.mjs, inside uniPEQ's WebView.
 */

/** Crockford base32 without I, L, O, U. Must match ROOM_PATH in src/worker.ts. */
const ROOM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HEARTBEAT_MS = 1000;
const PING_MS = 5000;
const PING_LOST_MS = 10000;
const STATS_MS = 10000;
const KEEPALIVE_MS = 25000;
/** A heartbeat later than this is logged as a gap. */
const GAP_LOG_MS = 2500;
/** Every Nth heartbeat carries `extraStatus()` (uniPEQ: a DeviceIo round trip). */
const STATUS_EVERY = 10;

export function newRoomCode() {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => ROOM_ALPHABET[b % 32]).join('');
}

/**
 * @param {object} options
 * @param {string} options.server   Worker origin, e.g. https://peq-link.example.workers.dev
 * @param {string} options.room     Room code
 * @param {string} [options.label]  Shown in the log, e.g. 'uniPEQ WebView'
 * @param {boolean} [options.relayOnly] Force the TURN relay (iceTransportPolicy 'relay')
 * @param {boolean} [options.holdLock] Freeze experiment: hold a Web Lock for the whole session
 * @param {'silent' | 'quiet'} [options.audio] Freeze experiment: keep an AudioContext playing
 * @param {() => Promise<object>} [options.extraStatus]
 * @param {(event: object) => void} [options.onEvent]
 */
export function startProbe({
	server,
	room,
	label = 'probe',
	relayOnly = false,
	holdLock = false,
	audio,
	extraStatus,
	onEvent
}) {
	const peerId = crypto.randomUUID();
	const startedAt = Date.now();
	/** @type {object[]} */
	const events = [];
	const emit = (kind, data = {}) => {
		const event = { t: Date.now() - startedAt, at: new Date().toISOString(), kind, ...data };
		events.push(event);
		onEvent?.(event);
	};

	const state = {
		signaling: 'connecting',
		connection: 'new',
		channel: 'closed',
		pair: null,
		peer: null,
		peerVisibility: null,
		openedAfterMs: null
	};
	const hb = { sent: 0, received: 0, lastAt: 0, maxGap: 0, gapsOverLog: 0 };
	const rtts = [];
	const pending = new Map();
	let pingsLost = 0;
	let ws = null;
	let pc = null;
	let channel = null;
	let iceServers = [];
	let offerer = false;
	let stopped = false;
	let roomFull = false;
	let reconnectDelay = 1000;
	let reconnectTimer = null;
	let replaced = false;
	const timers = [];

	// ── Signaling ────────────────────────────────────────────────────────────────────────────

	function connectSignaling() {
		reconnectTimer = null;
		const url = new URL(`/api/rooms/${room}`, server);
		url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
		url.searchParams.set('peer', peerId);
		ws = new WebSocket(url);
		state.signaling = 'connecting';
		ws.onopen = () => {
			state.signaling = 'open';
			reconnectDelay = 1000;
			emit('signaling-open');
		};
		ws.onmessage = ({ data }) => {
			if (data === 'pong') return;
			onSignalingMessage(JSON.parse(data));
		};
		ws.onclose = ({ code, reason }) => {
			state.signaling = 'closed';
			emit('signaling-closed', { code, reason });
			// Replaced by a newer socket, or turned away from a full room: reconnecting can't help.
			if (code === 4002) replaced = true;
			if (stopped || roomFull || replaced) return;
			reconnectTimer = setTimeout(connectSignaling, reconnectDelay);
			reconnectDelay = Math.min(reconnectDelay * 2, 30000);
		};
	}

	/**
	 * Back on screen or back online: retry now, not after the backoff. A phone browser loses its
	 * network about 5 s after going to the background, so the backoff has usually grown to 30 s by
	 * the time the user returns.
	 */
	function reconnectNow() {
		reconnectDelay = 1000;
		if (stopped || roomFull || replaced || reconnectTimer === null) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
		connectSignaling();
	}

	function signal(data) {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', data }));
	}

	async function onSignalingMessage(message) {
		switch (message.type) {
			case 'welcome': {
				iceServers = message.iceServers;
				const relays = iceServers.filter((s) => [s.urls].flat().some((u) => u.startsWith('turn')));
				emit('welcome', {
					self: message.self,
					peers: message.peers,
					turn: relays.length > 0
				});
				if (message.peers.length) {
					state.peer = message.peers[0];
					// A signaling reconnect with the channel still up changes nothing. A dead one is
					// rebuilt, and the offerer has to start over too: an ICE restart can't carry a
					// new DTLS fingerprint into its old connection.
					if (!pc) {
						offerer = false;
						createPeerConnection();
					} else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
						offerer = false;
						createPeerConnection();
						signal({ fresh: true });
					}
				}
				break;
			}
			case 'peer-joined':
				// The same peer id again: its signaling socket dropped and came back, and the channel
				// may still be up. It decides from its `welcome` and sends `fresh` if its side is dead.
				// Rebuilding here would tear down a working channel, and would race its `fresh`.
				if (message.peer.id === state.peer?.id && pc) {
					emit('peer-rejoined', { peer: message.peer });
					break;
				}
				// A new peer id means a fresh page or app session: its old connection is gone.
				state.peer = message.peer;
				emit('peer-joined', { peer: message.peer });
				offerer = true;
				createPeerConnection();
				break;
			case 'peer-left':
				// Advisory only: the DataChannel may outlive the peer's signaling socket.
				emit('peer-left', { peer: message.peer });
				break;
			case 'signal':
				await onSignal(message.data);
				break;
			case 'error':
				emit('signaling-error', { code: message.code });
				if (message.code === 'room-full') {
					roomFull = true;
					ws.close(1000, 'room full');
				}
				break;
		}
	}

	async function onSignal(data) {
		try {
			if (data.description) {
				await pc.setRemoteDescription(data.description);
				if (data.description.type === 'offer') {
					await pc.setLocalDescription();
					signal({ description: pc.localDescription });
				}
			} else if (data.candidate) {
				await pc.addIceCandidate(data.candidate);
			} else if (data.fresh) {
				emit('pc-rebuild', { requestedBy: 'peer' });
				offerer = true;
				createPeerConnection();
			} else if (data.restart && offerer) {
				emit('ice-restart', { requestedBy: 'peer' });
				pc.restartIce();
			}
		} catch (error) {
			emit('signal-error', { error: String(error) });
		}
	}

	// ── Peer connection ──────────────────────────────────────────────────────────────────────

	function createPeerConnection() {
		pc?.close();
		const connection = new RTCPeerConnection({
			iceServers,
			iceTransportPolicy: relayOnly ? 'relay' : 'all'
		});
		pc = connection;
		state.pair = null;
		const createdAt = Date.now();
		emit('pc-created', { offerer, relayOnly });

		connection.onicecandidate = ({ candidate }) => {
			if (candidate) signal({ candidate });
		};
		connection.onconnectionstatechange = () => {
			if (connection !== pc) return;
			state.connection = connection.connectionState;
			emit('connection-state', { state: connection.connectionState });
			if (connection.connectionState === 'failed') {
				if (offerer) {
					emit('ice-restart', { requestedBy: 'self' });
					connection.restartIce();
				} else signal({ restart: true });
			}
		};
		if (offerer) {
			connection.onnegotiationneeded = async () => {
				try {
					await connection.setLocalDescription();
					signal({ description: connection.localDescription });
				} catch (error) {
					emit('signal-error', { error: String(error) });
				}
			};
		}

		// Negotiated on both sides with a fixed id, so neither waits for `ondatachannel`.
		channel = connection.createDataChannel('probe', { negotiated: true, id: 0, ordered: true });
		channel.onopen = () => {
			state.channel = 'open';
			state.openedAfterMs = Date.now() - createdAt;
			hb.lastAt = Date.now();
			emit('channel-open', { afterMs: state.openedAfterMs });
			void readPair();
		};
		channel.onclose = () => {
			state.channel = 'closed';
			emit('channel-closed');
		};
		channel.onmessage = ({ data }) => onChannelMessage(JSON.parse(data));
	}

	function send(message) {
		if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
	}

	function onChannelMessage(message) {
		const now = Date.now();
		switch (message.t) {
			case 'hb': {
				hb.received++;
				const gap = now - hb.lastAt;
				hb.lastAt = now;
				if (gap > hb.maxGap) hb.maxGap = gap;
				if (gap > GAP_LOG_MS) {
					hb.gapsOverLog++;
					emit('hb-gap', { gapMs: gap, seq: message.seq, peerVisibility: message.vis });
				}
				if (message.vis !== state.peerVisibility) {
					state.peerVisibility = message.vis;
					emit('peer-visibility', { visibility: message.vis });
				}
				if (message.status) emit('peer-status', { status: message.status });
				break;
			}
			case 'ping':
				// Answered from the event handler, never a timer: this is what shows whether
				// incoming messages still reach a hidden page.
				send({ t: 'pong', id: message.id });
				break;
			case 'pong': {
				const sentAt = pending.get(message.id);
				if (sentAt === undefined) break;
				pending.delete(message.id);
				const rtt = now - sentAt;
				rtts.push(rtt);
				if (rtt > 1000) emit('slow-pong', { rttMs: rtt });
				break;
			}
		}
	}

	async function readPair() {
		if (!pc) return;
		try {
			const stats = await pc.getStats();
			let transport;
			stats.forEach((s) => {
				if (s.type === 'transport' && s.selectedCandidatePairId) transport = s;
			});
			const pair =
				stats.get(transport?.selectedCandidatePairId) ??
				[...stats.values()].find((s) => s.type === 'candidate-pair' && s.nominated);
			if (!pair) return;
			const local = stats.get(pair.localCandidateId);
			const remote = stats.get(pair.remoteCandidateId);
			const summary = {
				local: local?.candidateType,
				remote: remote?.candidateType,
				protocol: local?.protocol,
				relayProtocol: local?.relayProtocol,
				rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null
			};
			const key = `${summary.local}/${summary.remote}/${summary.protocol}/${summary.relayProtocol}`;
			if (key !== state.pair?.key) emit('pair', summary);
			state.pair = { key, ...summary };
		} catch (error) {
			emit('stats-error', { error: String(error) });
		}
	}

	// ── Timers and lifecycle ─────────────────────────────────────────────────────────────────

	timers.push(
		setInterval(async () => {
			if (channel?.readyState !== 'open') return;
			hb.sent++;
			const message = { t: 'hb', seq: hb.sent, at: Date.now(), vis: visibility() };
			if (extraStatus && hb.sent % STATUS_EVERY === 0) {
				try {
					message.status = await extraStatus();
				} catch (error) {
					message.status = { error: String(error) };
				}
			}
			send(message);
		}, HEARTBEAT_MS),
		setInterval(() => {
			const now = Date.now();
			for (const [id, sentAt] of pending) {
				if (now - sentAt > PING_LOST_MS) {
					pending.delete(id);
					pingsLost++;
					emit('ping-lost', { id });
				}
			}
			if (channel?.readyState !== 'open') return;
			const id = crypto.randomUUID();
			pending.set(id, now);
			send({ t: 'ping', id });
		}, PING_MS),
		setInterval(() => {
			if (channel?.readyState === 'open') void readPair();
		}, STATS_MS),
		setInterval(() => {
			if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
		}, KEEPALIVE_MS)
	);

	const lifecycle = ['visibilitychange', 'freeze', 'resume', 'pagehide', 'pageshow'];
	const onLifecycle = (event) => {
		emit('lifecycle', { event: event.type, visibility: visibility() });
		if (visibility() === 'visible') reconnectNow();
	};
	const onNetwork = (event) => {
		emit('network', { event: event.type });
		if (event.type === 'online') reconnectNow();
	};
	if (typeof document !== 'undefined')
		for (const type of lifecycle) document.addEventListener(type, onLifecycle);
	if (typeof window !== 'undefined')
		for (const type of ['online', 'offline']) window.addEventListener(type, onNetwork);

	// ── Freeze experiments (docs/phase-0.md, Q4) ─────────────────────────────────────────────
	// Things Chrome's own tab freezing spares. Whether WebView's freeze does too is the question.

	let releaseLock = null;
	if (holdLock) {
		if (navigator.locks) {
			void navigator.locks.request(
				`link-probe-${peerId}`,
				() => new Promise((resolve) => (releaseLock = resolve))
			);
		} else emit('experiment-error', { holdLock: 'navigator.locks is unavailable' });
	}
	let audioContext = null;
	if (audio) {
		try {
			audioContext = new AudioContext();
			// 'silent' plays zeros; 'quiet' is a 20 Hz tone at -60 dBFS, above the -72 dBFS level
			// Chromium treats as audible but far below anything a listener would notice.
			const oscillator = new OscillatorNode(audioContext, { frequency: 20 });
			const gain = new GainNode(audioContext, { gain: audio === 'quiet' ? 0.001 : 0 });
			oscillator.connect(gain).connect(audioContext.destination);
			oscillator.start();
			void audioContext
				.resume()
				.then(() => emit('experiment', { audio, state: audioContext.state }))
				.catch((error) => emit('experiment-error', { audio: String(error) }));
		} catch (error) {
			emit('experiment-error', { audio: String(error) });
		}
	}

	emit('start', {
		label,
		room,
		server,
		peerId,
		relayOnly,
		holdLock,
		audio: audio ?? null,
		userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null
	});
	connectSignaling();

	// ── Results ──────────────────────────────────────────────────────────────────────────────

	function summary() {
		const sorted = [...rtts].sort((a, b) => a - b);
		const pct = (p) =>
			sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
		return {
			label,
			room,
			runningForS: Math.round((Date.now() - startedAt) / 1000),
			...state,
			heartbeats: { ...hb, sinceLastMs: hb.lastAt ? Date.now() - hb.lastAt : null },
			pings: {
				answered: rtts.length,
				lost: pingsLost,
				outstanding: pending.size,
				rttP50Ms: pct(0.5),
				rttP95Ms: pct(0.95),
				rttMaxMs: sorted.at(-1) ?? null
			}
		};
	}

	return {
		summary,
		events,
		export: () => ({ summary: summary(), events }),
		stop() {
			stopped = true;
			clearTimeout(reconnectTimer);
			for (const timer of timers) clearInterval(timer);
			if (typeof document !== 'undefined')
				for (const type of lifecycle) document.removeEventListener(type, onLifecycle);
			if (typeof window !== 'undefined')
				for (const type of ['online', 'offline']) window.removeEventListener(type, onNetwork);
			pc?.close();
			ws?.close(1000, 'stopped');
			releaseLock?.();
			void audioContext?.close();
			emit('stop');
		}
	};
}

function visibility() {
	return typeof document !== 'undefined' ? document.visibilityState : 'n/a';
}
