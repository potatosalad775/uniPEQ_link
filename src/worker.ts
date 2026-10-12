/**
 * Signaling for the modernGraphTool ↔ uniPEQ link. The Worker routes a room's WebSocket to its
 * Durable Object and serves the landing page. Static assets (`/.well-known/assetlinks.json`, the
 * Phase 0 probe at `/probe/`) are served before this runs.
 */
import { normalizeRoomCode, ROOM_CODE } from '../client/protocol';
import { landingPage } from './landing';
import { Room } from './room';

export { Room };

export interface Env {
	ROOMS: DurableObjectNamespace<Room>;
	/** Cloudflare Realtime TURN key. Both unset → rooms offer STUN only. */
	TURN_KEY_ID?: string;
	TURN_KEY_API_TOKEN?: string;
}

/** The room code's rules live in client/protocol.ts, which both apps install. */
const ROOM_PATH = /^\/api\/rooms\/([^/]+)$/;
/** Loose on purpose: a hand-typed `/l/abcd-efgh` is redirected to the canonical code. */
const LANDING_PATH = /^\/l\/([^/]{8,12})\/?$/;
/** A stable id per tab or app session, so a signaling reconnect isn't seen as a new peer. */
const PEER_ID = /^[0-9a-f-]{36}$/;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		const landing = LANDING_PATH.exec(url.pathname)?.[1];
		if (landing !== undefined) {
			const room = normalizeRoomCode(decodeURIComponent(landing));
			if (!room) return new Response('Not a link code', { status: 404 });
			if (url.pathname !== `/l/${room}`) return Response.redirect(`${url.origin}/l/${room}`, 301);
			return landingPage(url.origin, room);
		}

		const room = ROOM_PATH.exec(url.pathname)?.[1];
		if (!room || !ROOM_CODE.test(room)) return new Response('Not found', { status: 404 });
		if (request.headers.get('Upgrade') !== 'websocket')
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		if (!PEER_ID.test(url.searchParams.get('peer') ?? ''))
			return new Response('Missing or malformed peer id', { status: 400 });
		return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
	}
} satisfies ExportedHandler<Env>;
