/**
 * Signaling for the modernGraphTool ↔ uniPEQ link. The Worker only routes a room's WebSocket to
 * its Durable Object; static assets (the Phase 0 probe page) are served before this runs.
 */
import { Room } from './room';

export { Room };

export interface Env {
	ROOMS: DurableObjectNamespace<Room>;
	/** Cloudflare Realtime TURN key. Both unset → rooms offer STUN only. */
	TURN_KEY_ID?: string;
	TURN_KEY_API_TOKEN?: string;
}

/**
 * Eight Crockford base32 characters (no I, L, O, U): short enough to type from another device's
 * screen. The room code only finds the room; it isn't the session's secret.
 */
const ROOM_PATH = /^\/api\/rooms\/([0-9A-HJKMNP-TV-Z]{8})$/;
/** A stable id per tab or app session, so a signaling reconnect isn't seen as a new peer. */
const PEER_ID = /^[0-9a-f-]{36}$/;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const room = ROOM_PATH.exec(url.pathname)?.[1];
		if (!room) return new Response('Not found', { status: 404 });
		if (request.headers.get('Upgrade') !== 'websocket')
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		if (!PEER_ID.test(url.searchParams.get('peer') ?? ''))
			return new Response('Missing or malformed peer id', { status: 400 });
		return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
	}
} satisfies ExportedHandler<Env>;
