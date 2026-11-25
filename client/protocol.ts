/**
 * The link's wire protocol (docs/design.md §4): message types, guards, the room code and the
 * timings both apps share. No imports and no DOM, so the Worker uses it too.
 */

/** `[major, minor]`. Major: an existing message changed meaning. Minor: something was added. */
export const PROTO = [1, 3] as const;
export type Proto = readonly [major: number, minor: number];

/**
 * The minor both sides have, given the same major: what was added after it stays unused (design
 * §4.2). `HostLink.minor` and `JoinerLink.minor` hold it for the session.
 */
export function sharedMinor(mine: Proto, theirs: Proto): number {
	return Math.min(mine[1], theirs[1]);
}

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
 * The query parameter that carries mGT's launch token on the links mGT opens itself (design
 * §2.4). The QR code and the landing page's own links never carry it.
 */
export const LAUNCH_PARAM = 'from';
const LAUNCH_TOKEN = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** A launch token: 80 random bits, in the room code's alphabet so it needs no escaping. */
export function newLaunchToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => ROOM_ALPHABET[b % 32]).join('');
}

function launchOf(url: URL): { launch?: string } {
	const token = url.searchParams.get(LAUNCH_PARAM);
	return token && LAUNCH_TOKEN.test(token) ? { launch: token } : {};
}

/**
 * What uniPEQ's code field accepts: a code (joins `defaultServer`), a landing or App Link URL
 * (`https://<server>/l/<CODE>`), or the intent link's `unipeq://link?server=…&room=…`.
 * `launch` is the token of a link mGT opened itself, to hand to `startJoiner` (design §2.4).
 */
export function parseRoomInput(
	input: string,
	defaultServer: string
): { server: string; room: string; launch?: string } | null {
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
		return server && code && isServerUrl(server)
			? { server: origin(server), room: code, ...launchOf(url) }
			: null;
	}
	const landing = /^\/l\/([^/]+)\/?$/.exec(url.pathname);
	const code = landing && normalizeRoomCode(decodeURIComponent(landing[1]));
	return code && isServerUrl(url.href)
		? { server: url.origin, room: code, ...launchOf(url) }
		: null;
}

/** The QR code's target and the intent link's fallback (design §7.1). */
export function landingUrl(server: string, room: string): string {
	return `${origin(server)}/l/${room}`;
}

/**
 * mGT's "Open uniPEQ" button on Android (design §2.1). No `package=`: the Play and GitHub builds
 * are separate apps (`kr.potatosalad775.unipeq`, `….sideload`), and naming one sends a phone with
 * the other to the fallback. `launch` is mGT's token (design §2.4); the fallback never carries it.
 */
export function intentLink(server: string, room: string, launch?: string): string {
	const from = launch ? `&${LAUNCH_PARAM}=${launch}` : '';
	const query = `server=${encodeURIComponent(origin(server))}&room=${room}${from}`;
	const fallback = encodeURIComponent(landingUrl(server, room));
	return `intent://link?${query}#Intent;scheme=unipeq;S.browser_fallback_url=${fallback};end`;
}

/**
 * uniPEQ on the web. Its GitHub Pages address, which GitHub redirects, query and all, to a custom
 * domain once one is set up, so links made with it keep working.
 */
export const WEB_APP = 'https://potatosalad775.github.io/uniPEQ/';

/** The query parameter uniPEQ on the web joins from. It holds anything `parseRoomInput` accepts. */
export const WEB_LINK_PARAM = 'link';

/**
 * mGT's "Open uniPEQ" off Android: uniPEQ on the web, joining the room as it opens (design §2.2).
 * It carries the landing URL, so the server travels with the code. `launch` is mGT's token (design
 * §2.4), carried on that landing URL.
 */
export function webLink(server: string, room: string, app = WEB_APP, launch?: string): string {
	const url = new URL(app);
	const landing = new URL(landingUrl(server, room));
	if (launch) landing.searchParams.set(LAUNCH_PARAM, launch);
	url.searchParams.set(WEB_LINK_PARAM, landing.href);
	return url.href;
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

export type Channel = 'left' | 'right';

/** One channel's list and preamp. */
export interface LinkChannel {
	/** In band (slot) order. */
	filters: Filter[];
	/** The value in effect: derived while `autoPreamp` is on. */
	preamp: number;
	autoPreamp: boolean;
}

/** The shared list (design §4.3). */
export interface LinkEq extends LinkChannel {
	/**
	 * Proto 1.3. The channels are apart: this is the right one's, and the fields above are the
	 * left's, as in eqcaps' `PullResult`. Absent while one list drives both. Never sent to an mGT
	 * before 1.3, which gets the one list its edits land on.
	 */
	right?: LinkChannel;
}

/**
 * `ch` is proto 1.3. Without it an op sets both channels, apart or not. With it the op sets that
 * channel, and is dropped while the channels aren't apart: the EQ changed shape under it.
 */
export type EditOp =
	/** Replace band `i`. Past the end of the list it's dropped: the list changed shape under it. */
	| { op: 'band'; i: number; filter: Filter; ch?: Channel }
	/** Replace the whole list. */
	| { op: 'list'; filters: Filter[]; ch?: Channel }
	/** A fixed preamp; turns Auto off. */
	| { op: 'preamp'; db: number; ch?: Channel }
	| { op: 'auto-preamp'; on: boolean; ch?: Channel }
	/**
	 * Proto 1.3. `apart: true` sets the channels apart, the right starting as a copy of the left;
	 * uniPEQ refuses it for a device that can't drive them apart. `apart: false` makes `keep`'s list
	 * (default left) both channels'. Either is a no-op when the channels are that way already.
	 */
	| { op: 'channels'; apart: boolean; keep?: Channel };

export function filtersEqual(a: Filter, b: Filter): boolean {
	return a.type === b.type && a.freq === b.freq && a.q === b.q && a.gain === b.gain;
}

function channelsEqual(a: LinkChannel, b: LinkChannel): boolean {
	return (
		a.preamp === b.preamp &&
		a.autoPreamp === b.autoPreamp &&
		a.filters.length === b.filters.length &&
		a.filters.every((filter, i) => filtersEqual(filter, b.filters[i]))
	);
}

/** Apart with equal channels isn't one list for both: linking is an edit of its own. */
export function eqEqual(a: LinkEq, b: LinkEq): boolean {
	if (!channelsEqual(a, b)) return false;
	if (!a.right || !b.right) return a.right === b.right;
	return channelsEqual(a.right, b.right);
}

// ── Device and status (design §4.5) ──────────────────────────────────────────────────────────

/**
 * mGT's `PlanChange`; uniPEQ's `push-plan.ts` is a copy of mGT's. `channel` is proto 1.3: the
 * channel the change is in, on a write that sends the channels apart; absent when it's in both.
 */
export type PlanChange = (
	| {
			kind: 'field';
			/** 1-based band number, as the band list shows it. */
			band: number;
			field: 'type' | 'freq' | 'q' | 'gain';
			wanted: number | string;
			written: number | string;
	  }
	| { kind: 'dropped'; band: number }
	| { kind: 'preamp'; wanted: number; written: number }
) & { channel?: Channel };

/** eqcaps' `Slot`: a preset, by the device's own number. */
export interface LinkSlot {
	id: number;
	name: string;
	bypass?: boolean;
	writable?: boolean;
}

export interface LinkDevice {
	name: string;
	kind: 'hid' | 'serial' | 'ble' | 'demo';
	/**
	 * The full eqcaps profile, so mGT fits and bounds AutoEQ exactly as uniPEQ does. Of the EQ the
	 * device is viewed as (`eq`), as eqcaps' `eqProfile` gives it.
	 */
	profile: unknown;
	profileSource: 'device' | 'group' | 'guess' | 'demo';
	profileId: string | null;
	identity: unknown;
	/**
	 * mGT's `PeqCapabilities` subset, including `slots`: for a device that keeps a list of presets,
	 * the room it has, and `status.slots` is the list. From proto 1.3 also eqcaps' `controls`,
	 * `eqs`, `perChannel`, `listsSlots`, `editsSlots` and `readsBandCount`, where a missing key
	 * reads as "can't".
	 */
	capabilities: unknown;
	/**
	 * Proto 1.3. The id of the EQ the device is viewed as, among `capabilities.eqs`; null for its
	 * own. Changed by the `eq` command, which brings a new `device` and a `fresh` list.
	 */
	eq?: string | null;
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
	/** `control` and `preset` are proto 1.3: an mGT before it is sent null for them. */
	busy: 'read' | 'write' | 'switch' | 'connect' | 'control' | 'preset' | null;
	inSync: boolean | null;
	unwritten: boolean;
	needsReconnect: boolean;
	auto: { on: boolean; pending: boolean; paused: boolean; stopped: boolean; clipRisk: boolean };
	/** `code` is an eqcaps BridgeError code. */
	failure: { op: string; code: string } | null;
	review: { rev: number; changes: PlanChange[]; clipRisk: boolean; infeasible: boolean } | null;
	/**
	 * Proto 1.1. uniPEQ shows the volume warning: nothing is written to this device until the user
	 * answers it, on either side (`consent`). Absent from a 1.0 uniPEQ.
	 */
	consent?: boolean;
	/**
	 * Proto 1.3. The presets as they are now, under the device's own names, for a device that keeps
	 * a list (`capabilities.listsSlots`): `activeSlot` and `deviceSlot` are ids in it. Absent
	 * elsewhere, where `capabilities.slots` is the list.
	 */
	slots?: LinkSlot[];
	/**
	 * Proto 1.3. The device is on no preset: its EQ changed since one was loaded. `deviceSlot` is
	 * null then, as it is when the device can't say.
	 */
	unsaved?: boolean;
	/** Proto 1.3. The EQs in `capabilities.eqs` the device's mode lacks now, by id. */
	absentEqs?: string[];
	/**
	 * Proto 1.3. Each of `capabilities.controls` by id, in the device's own numbers; null for one
	 * the device lacks now (its firmware, its mode, another control's value).
	 */
	controls?: Record<string, number | null>;
}

/**
 * `status` as an mGT on `minor` knows it: a value a later minor added to an existing field falls
 * back to what that mGT shows for "none". New fields need nothing, since they are ignored.
 */
export function statusFor(status: LinkStatus, minor: number): LinkStatus {
	const late = status.busy === 'control' || status.busy === 'preset';
	return minor < 3 && late ? { ...status, busy: null } : status;
}

// ── Messages (design §4.3) ───────────────────────────────────────────────────────────────────

export type ByeReason = 'unlink' | 'denied' | 'version' | 'timeout' | 'replaced';
export type Editor = 'mgt' | 'unipeq' | 'device';
export type PauseCause = 'frozen' | 'hidden' | 'stopped';

export type CommandName =
	| 'read'
	| 'write'
	| 'review'
	| 'switch'
	| 'fit'
	| 'reconnect'
	| 'auto-write'
	| 'consent'
	| 'eq'
	| 'control'
	| 'preset-create'
	| 'preset-rename'
	| 'preset-delete';

/**
 * The minor each command came with. mGT doesn't send one uniPEQ's minor lacks: `command` answers
 * `unsupported` itself, which is also what an older uniPEQ would say.
 */
export const COMMAND_MINOR: Record<CommandName, number> = {
	read: 0,
	write: 0,
	review: 0,
	switch: 0,
	fit: 0,
	reconnect: 0,
	'auto-write': 0,
	consent: 1,
	eq: 3,
	control: 3,
	'preset-create': 3,
	'preset-rename': 3,
	'preset-delete': 3
};
export const COMMANDS: readonly string[] = Object.keys(COMMAND_MINOR);

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
	/**
	 * Proto 1.1: the volume warning's answer. `accept` lets uniPEQ write to this device; `quiet`
	 * also turns the warning off for later connections (uniPEQ's setting, kept in one place).
	 */
	consent: { accept: boolean; quiet?: boolean };
	/**
	 * Proto 1.3: views the device as another of `capabilities.eqs`, null for its own, and reads it.
	 * A new `device` and a `fresh` list follow.
	 */
	eq: { id: string | null };
	/**
	 * Proto 1.3: writes one of `capabilities.controls`, in the device's own numbers. The value
	 * arrives in `status.controls`; a control that makes the device reconnect sets `needsReconnect`.
	 */
	control: { id: string; value: number };
	/**
	 * Proto 1.3, for a device with `capabilities.editsSlots`. The list arrives in `status.slots`.
	 * A new preset is empty and goes after the last; without `name` the device names it.
	 */
	'preset-create': { name?: string };
	/** Refused (`invalid-request`) when the device can't store `name`, rather than shortened. */
	'preset-rename': { slot: number; name: string };
	/** The presets after it move down by one, so every id mGT holds is stale until `status`. */
	'preset-delete': { slot: number };
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
	/**
	 * uniPEQ, proto 1.2: the launch token of the link it was opened by, when that link carried one.
	 * mGT puts its token only on the links it opens itself, so a match means uniPEQ runs on the
	 * machine mGT does (design §2.4).
	 */
	launch?: string;
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

function isChannelEq(value: unknown): value is LinkChannel {
	return (
		isRecord(value) &&
		Array.isArray(value.filters) &&
		value.filters.every(isFilter) &&
		Number.isFinite(value.preamp) &&
		typeof value.autoPreamp === 'boolean'
	);
}

function isEq(value: unknown): value is LinkEq {
	if (!isRecord(value)) return false;
	return isChannelEq(value) && (value.right === undefined || isChannelEq(value.right));
}

function isEditOp(value: unknown): value is EditOp {
	if (!isRecord(value)) return false;
	// An op for a channel this side can't name would land on both, so it isn't kept.
	if (value.ch !== undefined && value.ch !== 'left' && value.ch !== 'right') return false;
	switch (value.op) {
		case 'channels':
			return (
				typeof value.apart === 'boolean' &&
				(value.keep === undefined || value.keep === 'left' || value.keep === 'right')
			);
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
