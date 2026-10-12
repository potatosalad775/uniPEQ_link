/**
 * One link session's signaling room: at most two peers, and nothing but WebRTC setup passes
 * through it. EQ traffic never touches the server; it goes over the DataChannel.
 *
 * Uses the hibernation API, so an idle room (the normal state once the DataChannel is open)
 * costs nothing while its sockets stay connected. Nothing is stored: a room exists while a peer
 * is connected to it.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './worker';

interface Peer {
	id: string;
	/**
	 * The Origin header of the peer's WebSocket upgrade. A browser can't fake it, so this is what
	 * uniPEQ shows as "Link with <origin>?". Other native apps can, so it's a label for the
	 * approval dialog, not proof of who is asking.
	 */
	origin: string;
	userAgent: string;
	joinedAt: number;
}

const MAX_PEERS = 2;
const MAX_MESSAGE = 64 * 1024;
/** Long enough for any realistic session; ICE restarts reuse the same credentials. */
const TURN_TTL_S = 12 * 60 * 60;

type IceServer = { urls: string | string[]; username?: string; credential?: string };

export class Room extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Client keepalives are answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	async fetch(request: Request): Promise<Response> {
		const id = new URL(request.url).searchParams.get('peer')!;
		const [client, server] = Object.values(new WebSocketPair());

		// The same peer reconnecting (a dropped socket, a tab coming back) replaces its old socket
		// and stays the same peer: the DataChannel may well still be up.
		const sockets = this.sockets();
		const stale = sockets.filter((ws) => peerOf(ws)!.id === id);
		const others = sockets.filter((ws) => peerOf(ws)!.id !== id);
		if (new Set(others.map((ws) => peerOf(ws)!.id)).size >= MAX_PEERS) {
			// Upgraded rather than refused, so the client gets a reason it can show. Not a
			// hibernatable socket: it never joins the room. A close before the handshake completes
			// is dropped, so the client is told by message and closes itself.
			server.accept();
			server.send(JSON.stringify({ type: 'error', code: 'room-full' }));
			return new Response(null, { status: 101, webSocket: client });
		}
		this.ctx.acceptWebSocket(server);

		const peer: Peer = {
			id,
			origin: request.headers.get('Origin') ?? '',
			userAgent: request.headers.get('User-Agent') ?? '',
			joinedAt: Date.now()
		};
		server.serializeAttachment(peer);
		for (const ws of stale) ws.close(4002, 'replaced by a newer connection');

		server.send(
			JSON.stringify({
				type: 'welcome',
				self: peer,
				peers: others.map(peerOf),
				iceServers: await this.iceServers()
			})
		);
		if (!stale.length) broadcast(others, { type: 'peer-joined', peer });
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string' || message.length > MAX_MESSAGE) {
			ws.close(1009, 'expected a JSON text message under 64 KiB');
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			ws.close(1007, 'invalid JSON');
			return;
		}
		// Only setup traffic is relayed, and the server never reads inside `data`.
		if (!isRecord(parsed) || parsed.type !== 'signal' || !('data' in parsed)) return;
		const from = peerOf(ws);
		if (!from) return;
		broadcast(this.others(ws, from.id), { type: 'signal', from: from.id, data: parsed.data });
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.leave(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.leave(ws);
	}

	private leave(ws: WebSocket): void {
		const peer = peerOf(ws);
		if (!peer) return;
		// A replaced socket closing isn't the peer leaving.
		const stillHere = this.sockets().some((other) => other !== ws && peerOf(other)!.id === peer.id);
		if (!stillHere) broadcast(this.others(ws, peer.id), { type: 'peer-left', peer });
	}

	/** Joined sockets: accepted, given a peer, and not closing. */
	private sockets(): WebSocket[] {
		return this.ctx
			.getWebSockets()
			.filter((ws) => ws.readyState === WebSocket.OPEN && peerOf(ws) !== null);
	}

	private others(ws: WebSocket, id: string): WebSocket[] {
		return this.sockets().filter((other) => other !== ws && peerOf(other)!.id !== id);
	}

	private async iceServers(): Promise<IceServer[]> {
		const stun: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
		const { TURN_KEY_ID, TURN_KEY_API_TOKEN } = this.env;
		if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) return stun;
		try {
			const response = await fetch(
				`https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({ ttl: TURN_TTL_S })
				}
			);
			if (!response.ok) throw new Error(`TURN credentials: HTTP ${response.status}`);
			const { iceServers } = (await response.json()) as { iceServers: IceServer[] };
			// Browsers block port 53, and a URL that times out stalls gathering.
			return iceServers.map((server) => ({
				...server,
				urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url))
			}));
		} catch (error) {
			console.error('TURN credentials unavailable, offering STUN only', error);
			return stun;
		}
	}
}

function peerOf(ws: WebSocket): Peer | null {
	return (ws.deserializeAttachment() as Peer | null) ?? null;
}

function broadcast(sockets: WebSocket[], message: object): void {
	const text = JSON.stringify(message);
	for (const ws of sockets) {
		try {
			ws.send(text);
		} catch {
			// Already closing; its own close event tells the others.
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
