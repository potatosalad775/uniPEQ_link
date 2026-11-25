// In-page harness for the smoke test's protocol run: mGT and uniPEQ with a fake device, on the
// reference client (bundled as the `PeqLink` global by scripts/smoke.mjs). Plain JS, no imports.
/* global PeqLink */

const pk = (freq, gain = 0) => ({ type: 'PK', freq, q: 1, gain });

/** mGT: `local` is its list, adopted lists replace it. Returns the room code. */
window.setupHost = (server, { resume = false, eq, proto, timings } = {}) => {
	const state = {
		eq: eq ?? { filters: [pk(100), pk(200), pk(300)], preamp: 0, autoPreamp: false },
		hello: null,
		states: [],
		adopted: [],
		device: undefined,
		status: undefined,
		ended: null
	};
	const options = {
		server,
		version: 'smoke',
		site: 'Smoke Graph',
		local: () => state.eq,
		proto,
		timings: timings && { ...PeqLink.TIMINGS, ...timings }
	};
	const link = (resume && PeqLink.resumeHost(options)) || PeqLink.startHost(options);
	link.on('state', (s) => state.states.push(s));
	// `minor` is read inside the event: it must already be set when `hello` is announced.
	link.on('hello', (h) => (state.hello = { proto: h.proto, minor: link.minor }));
	link.on('eq', (adopt) => {
		state.eq = adopt.eq;
		state.adopted.push({ by: adopt.by, initial: adopt.initial, fresh: adopt.fresh });
	});
	link.on('device', (d) => (state.device = d));
	link.on('status', (s) => (state.status = s));
	link.on('ended', (e) => (state.ended = e));
	window.fake = {
		link,
		state,
		edit(ops, options) {
			state.eq = PeqLink.applyOps(state.eq, ops);
			link.edit(ops, options);
		},
		replaceAll(eq) {
			state.eq = eq;
			link.replaceAll(eq);
		}
	};
	return link.room;
};

/**
 * uniPEQ with a fake device that counts writes. `eq` may carry `right` (channels apart). It
 * records the ops it received (`ops`), the commands that reached its handler (`commands`) and
 * keeps the device's `controls` and `busy`, which its status reports.
 */
window.setupJoiner = (server, room, { eq, proto, timings, foreground = true } = {}) => {
	const state = {
		eq: eq ?? {
			filters: [pk(1000, 1), pk(2000, 2), pk(3000, 3), pk(4000, 4)],
			preamp: -4,
			autoPreamp: false
		},
		applied: 0,
		writes: 0,
		ops: [],
		commands: [],
		controls: {},
		busy: null,
		hello: null,
		requests: [],
		states: [],
		ended: null
	};
	const link = PeqLink.startJoiner({
		server,
		room,
		version: 'smoke',
		foreground,
		proto,
		timings: timings && { ...PeqLink.TIMINGS, ...timings },
		handlers: {
			eq: () => state.eq,
			device: () => ({
				name: 'Smoke DAC',
				kind: 'demo',
				profile: {},
				profileSource: 'demo',
				profileId: null,
				identity: null,
				capabilities: { slots: [] }
			}),
			status: () => ({
				connected: true,
				knownDevice: 'Smoke DAC',
				editable: true,
				activeSlot: null,
				deviceSlot: null,
				eqEnabled: true,
				busy: state.busy,
				controls: state.controls,
				inSync: true,
				unwritten: false,
				needsReconnect: false,
				auto: { on: true, pending: false, paused: false, stopped: false, clipRisk: false },
				failure: null,
				review: null
			}),
			edit(ops, { settle }) {
				state.applied += ops.length;
				state.ops.push(...ops);
				const next = PeqLink.applyOps(state.eq, ops);
				const changed = !PeqLink.eqEqual(next, state.eq);
				state.eq = next;
				// Auto-write: in this handler, never behind a timer.
				if (settle) state.writes++;
				return changed;
			},
			async command(name, args) {
				state.commands.push(name);
				if (name === 'write') state.writes++;
				if (name === 'control') {
					state.controls = { ...state.controls, [args.id]: args.value };
					// A command's effect arrives in `status`, which uniPEQ sends itself.
					link.sendStatus();
				}
				return { ok: true };
			}
		}
	});
	link.on('request', (r) => state.requests.push(r));
	link.on('state', (s) => state.states.push(s));
	link.on('hello', (h) => (state.hello = { proto: h.proto, minor: link.minor }));
	link.on('ended', (e) => (state.ended = e));
	window.fake = {
		link,
		state,
		edit(ops) {
			state.eq = PeqLink.applyOps(state.eq, ops);
			link.changed({ by: 'unipeq' });
		},
		/** The device is busy with `busy` (or not): status goes out. */
		busy(busy) {
			state.busy = busy;
			link.sendStatus();
		}
	};
};
