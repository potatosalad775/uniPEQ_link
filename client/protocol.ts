/**
 * The link's wire protocol (docs/design.md §4): message types, guards, the room code and the
 * timings both apps share. No imports and no DOM, so the Worker uses it too.
 */

/** `[major, minor]`. Major: an existing message changed meaning. Minor: something was added. */
export const PROTO = [1, 0] as const;
export type Proto = readonly [major: number, minor: number];

export const CHANNEL_LABEL = 'peq-link';
/** Same limit as the signaling relay. The largest message, `device`, is a few KB. */
export const MAX_MESSAGE = 64 * 1024;

// ── Room code ────────────────────────────────────────────────────────────────────────────────

/**
 * Crockford base32 without I, L, O, U. Eight characters, 40 random bits: the code is the pairing's
 * only secret, which is enough because a room holds two peers, lives only while one is connected,
 * and uniPEQ asks before it accepts anything (design §2). Must match `public/probe/probe.js`.
 */
export const ROOM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function newRoomCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => ROOM_ALPHABET[b % 32]).join('');
}

/** `XXXX-XXXX`, as both apps show it. */
export function formatRoomCode(room: string): string {
	return `${room.slice(0, 4)}-${room.slice(4)}`;
}

/**
 * A typed code as the canonical one, or null: uppercase, I and L read as 1, O as 0, spaces and
 * dashes dropped. People copy codes off another screen, so the look-alikes are forgiven.
 */
export function normalizeRoomCode(input: string): string | null {
	const code = input
		.toUpperCase()
		.replace(/[\s-]+/g, '')
		.replace(/[IL]/g, '1')
		.replace(/O/g, '0');
	return ROOM_CODE.test(code) ? code : null;
}

/**
 * What uniPEQ's code field accepts: a code (joins `defaultServer`), a landing or App Link URL
 * (`https://<server>/l/<CODE>`), or the intent link's `unipeq://link?server=…&room=…`.
 */
export function parseRoomInput(
	input: string,
	defaultServer: string
): { server: string; room: string } | null {
	const text = input.trim();
	const room = normalizeRoomCode(text);
	if (room) return { server: defaultServer, room };
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol === 'unipeq:') {
		const server = url.searchParams.get('server');
		const code = normalizeRoomCode(url.searchParams.get('room') ?? '');
		return server && code && isServerUrl(server) ? { server: origin(server), room: code } : null;
	}
	const landing = /^\/l\/([^/]+)\/?$/.exec(url.pathname);
	const code = landing && normalizeRoomCode(decodeURIComponent(landing[1]));
	return code && isServerUrl(url.href) ? { server: url.origin, room: code } : null;
}

/** The QR code's target and the intent link's fallback (design §7.1). */
export function landingUrl(server: string, room: string): string {
	return `${origin(server)}/l/${room}`;
}

export const UNIPEQ_PACKAGE = 'kr.potatosalad775.unipeq';

/** mGT's "Open uniPEQ" button on Android (design §2.1). */
export function intentLink(server: string, room: string): string {
	const query = `server=${encodeURIComponent(origin(server))}&room=${room}`;
	const fallback = encodeURIComponent(landingUrl(server, room));
	return (
		`intent://link?${query}#Intent;scheme=unipeq;package=${UNIPEQ_PACKAGE};` +
		`S.browser_fallback_url=${fallback};end`
	);
}

function isServerUrl(href: string): boolean {
	try {
		const { protocol } = new URL(href);
		return protocol === 'https:' || protocol === 'http:';
	} catch {
		return false;
	}
}

function origin(server: string): string {
	return new URL(server).origin;
}

// ── Timings (design §4.7) ────────────────────────────────────────────────────────────────────

export interface Timings {
	/** mGT pings this often. Phase 0: every ping was answered through 75 min of deep Doze. */
	pingMs: number;
	/** Silence before mGT says "uniPEQ isn't answering": 2.5× the longest Doze gap measured. */
	stallMs: number;
	/** A command's `re` may wait on USB round trips in Doze and on a device saving. */
	commandMs: number;
	/** The grace period: silence (mGT) or silence while in the background (uniPEQ). */
	endMs: number;
	/** uniPEQ's wait for a rejoin after `away`: long enough for a reload. */
	awayMs: number;
	/** At most one `edit` or `eq` per this, latest wins. */
	sendMs: number;
	/** Keyboard nudges settle after this much idle time (mGT's auto-write delay). */
	settleMs: number;
	/** The signaling WebSocket's keepalive. */
	keepaliveMs: number;
	/** Signaling reconnect backoff, reset and retried at once when the page comes back. */
	backoffMs: number;
	backoffMaxMs: number;
}

export const TIMINGS: Timings = {
	pingMs: 5_000,
	stallMs: 15_000,
	commandMs: 20_000,
	endMs: 10 * 60_000,
	awayMs: 30_000,
	sendMs: 50,
	settleMs: 700,
	keepaliveMs: 25_000,
	backoffMs: 1_000,
	backoffMaxMs: 30_000
};

// ── EQ (eqcaps units: Hz, dB, RBJ Q) ─────────────────────────────────────────────────────────

/** The eqcaps v1 types. A device may hold others (`x-…`); they pass through as strings. */
export const FILTER_TYPES = ['PK', 'LSC', 'HSC', 'LPQ', 'HPQ', 'BP', 'NO', 'AP'] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

/** eqcaps' `Filter`. */
export interface Filter {
	type: FilterType | (string & {});
	freq: number;
	q: number;
	gain: number;
}

/** The shared list (design §4.3). */
export interface LinkEq {
	/** In band (slot) order. */
	filters: Filter[];
	/** The value in effect: derived while `autoPreamp` is on. */
	preamp: number;
	autoPreamp: boolean;
}

export type EditOp =
	/** Replace band `i`. Past the end of the list it's dropped: the list changed shape under it. */
	| { op: 'band'; i: number; filter: Filter }
	/** Replace the whole list. */
	| { op: 'list'; filters: Filter[] }
	/** A fixed preamp; turns Auto off. */
	| { op: 'preamp'; db: number }
	| { op: 'auto-preamp'; on: boolean };

export function filtersEqual(a: Filter, b: Filter): boolean {
	return a.type === b.type && a.freq === b.freq && a.q === b.q && a.gain === b.gain;
}

export function eqEqual(a: LinkEq, b: LinkEq): boolean {
	return (
		a.preamp === b.preamp &&
		a.autoPreamp === b.autoPreamp &&
		a.filters.length === b.filters.length &&
		a.filters.every((filter, i) => filtersEqual(filter, b.filters[i]))
	);
}

// ── Device and status (design §4.5) ──────────────────────────────────────────────────────────

/** mGT's `PlanChange`; uniPEQ's `push-plan.ts` is a copy of mGT's. */
export type PlanChange =
	| {
			kind: 'field';
			/** 1-based band number, as the band list shows it. */
			band: number;
			field: 'type' | 'freq' | 'q' | 'gain';
			wanted: number | string;
			written: number | string;
	  }
	| { kind: 'dropped'; band: number }
	| { kind: 'preamp'; wanted: number; written: number };

export interface LinkDevice {
	name: string;
	kind: 'hid' | 'serial' | 'ble' | 'demo';
	/** The full eqcaps profile, so mGT fits and bounds AutoEQ exactly as uniPEQ does. */
	profile: unknown;
	profileSource: 'device' | 'group' | 'guess' | 'demo';
	profileId: string | null;
	identity: unknown;
	/** mGT's `PeqCapabilities` subset, including `slots`. */
	capabilities: unknown;
}

export interface LinkStatus {
	connected: boolean;
	/** Still named after a disconnect. */
	knownDevice: string | null;
	/** uniPEQ's canEdit: connected and not waiting to reconnect. */
	editable: boolean;
	activeSlot: number | null;
	deviceSlot: number | null;
	eqEnabled: boolean | null;
	busy: 'read' | 'write' | 'switch' | 'connect' | null;
	inSync: boolean | null;
	unwritten: boolean;
	needsReconnect: boolean;
	auto: { on: boolean; pending: boolean; paused: boolean; stopped: boolean; clipRisk: boolean };
	/** `code` is an eqcaps BridgeError code. */
	failure: { op: string; code: string } | null;
	review: { rev: number; changes: PlanChange[]; clipRisk: boolean; infeasible: boolean } | null;
}

// ── Messages (design §4.3) ───────────────────────────────────────────────────────────────────

export type ByeReason = 'unlink' | 'denied' | 'version' | 'timeout' | 'replaced';
export type Editor = 'mgt' | 'unipeq' | 'device';
export type PauseCause = 'frozen' | 'hidden' | 'stopped';

export const COMMANDS = ['read', 'write', 'review', 'switch', 'fit', 'reconnect', 'auto-write'];
export type CommandName =
	'read' | 'write' | 'review' | 'switch' | 'fit' | 'reconnect' | 'auto-write';

export interface CommandArgs {
	read: undefined;
	write: undefined;
	/** If `rev` moved since the plan, uniPEQ re-plans instead of writing. */
	review: { rev: number; accept: boolean };
	/** `p<id>`, `on` or `off`. */
	switch: { value: string };
	fit: undefined;
	reconnect: undefined;
	'auto-write': { on: boolean };
}

export interface HelloMessage {
	t: 'hello';
	proto: Proto;
	app: 'mgt' | 'unipeq';
	version: string;
	/** mGT: the site's title, shown under the attested host in uniPEQ's dialog. */
	site?: string;
	/** mGT: the last `eq` it adopted, and whether it has edits uniPEQ never acknowledged. */
	lastRev?: number | null;
	dirty?: boolean;
}

export type Message =
	| HelloMessage
	| { t: 'approval'; state: 'pending' | 'approved' }
	| { t: 'bye'; reason: ByeReason; proto?: Proto }
	| { t: 'away' }
	| { t: 'ping'; n: number }
	| { t: 'pong'; n: number }
	| { t: 'edit'; seq: number; ops: EditOp[]; burst?: string; settle?: boolean }
	| {
			t: 'eq';
			rev: number;
			eq: LinkEq;
			/** The last mGT `seq` applied. */
			ack: number;
			by: Editor;
			burst?: string;
			/** A read from the device: an undo barrier. */
			fresh?: boolean;
	  }
	| ({ t: 'device' } & ({ device: null } | { device: LinkDevice }))
	| { t: 'status'; status: LinkStatus }
	| { t: 'cmd'; id: number; name: CommandName; args?: CommandArgs[CommandName] }
	| { t: 're'; id: number; ok: boolean; code?: string }
	| { t: 'notice'; kind: 'paused'; cause: PauseCause; ms: number };

export type MessageOf<T extends Message['t']> = Extract<Message, { t: T }>;

/**
 * A received frame as a message, or null when it isn't one this side knows. Unknown types and
 * unknown fields are ignored rather than refused, so a minor version can add both (§4.1).
 * Checks only what a handler would trip over; the peer is one of the two apps.
 */
export function parseMessage(text: unknown): Message | null {
	if (typeof text !== 'string' || text.length > MAX_MESSAGE) return null;
	let m: unknown;
	try {
		m = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(m)) return null;
	const ok = (() => {
		switch (m.t) {
			case 'hello':
				return isProto(m.proto) && (m.app === 'mgt' || m.app === 'unipeq');
			case 'approval':
				return m.state === 'pending' || m.state === 'approved';
			case 'bye':
				return typeof m.reason === 'string';
			case 'away':
				return true;
			case 'ping':
			case 'pong':
				return typeof m.n === 'number';
			case 'edit':
				return typeof m.seq === 'number' && Array.isArray(m.ops) && m.ops.every(isEditOp);
			case 'eq':
				return typeof m.rev === 'number' && typeof m.ack === 'number' && isEq(m.eq);
			case 'device':
				return m.device === null || isRecord(m.device);
			case 'status':
				return isRecord(m.status);
			case 'cmd':
				return typeof m.id === 'number' && typeof m.name === 'string';
			case 're':
				return typeof m.id === 'number' && typeof m.ok === 'boolean';
			case 'notice':
				return typeof m.kind === 'string' && typeof m.ms === 'number';
			default:
				return false;
		}
	})();
	return ok ? (m as unknown as Message) : null;
}

export function isProto(value: unknown): value is Proto {
	return (
		Array.isArray(value) &&
		value.length >= 2 &&
		Number.isInteger(value[0]) &&
		Number.isInteger(value[1])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilter(value: unknown): value is Filter {
	return (
		isRecord(value) &&
		typeof value.type === 'string' &&
		Number.isFinite(value.freq) &&
		Number.isFinite(value.q) &&
		Number.isFinite(value.gain)
	);
}

function isEq(value: unknown): value is LinkEq {
	return (
		isRecord(value) &&
		Array.isArray(value.filters) &&
		value.filters.every(isFilter) &&
		Number.isFinite(value.preamp) &&
		typeof value.autoPreamp === 'boolean'
	);
}

function isEditOp(value: unknown): value is EditOp {
	if (!isRecord(value)) return false;
	switch (value.op) {
		case 'band':
			return Number.isInteger(value.i) && (value.i as number) >= 0 && isFilter(value.filter);
		case 'list':
			return Array.isArray(value.filters) && value.filters.every(isFilter);
		case 'preamp':
			return Number.isFinite(value.db);
		case 'auto-preamp':
			return typeof value.on === 'boolean';
		default:
			// An op from a newer minor: kept, and the applier skips it.
			return typeof value.op === 'string';
	}
}
