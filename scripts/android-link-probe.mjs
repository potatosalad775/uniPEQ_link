#!/usr/bin/env node
// Phase 0 driver for uniPEQ's side of the link probe (docs/phase-0.md). Injects public/probe.js
// into the running debug app's WebView over adb + the Chrome DevTools protocol, the same way
// uniPEQ's scripts/android-hid-spike.mjs runs its spike, then detaches.
//
//   node scripts/android-link-probe.mjs --server <worker origin> --room <code> [--relay]
//   node scripts/android-link-probe.mjs --server <worker origin> --arm    # join from the deep link
//   node scripts/android-link-probe.mjs --fgs --server <origin> …         # + foreground service
//   node scripts/android-link-probe.mjs --stop-fgs
//   node scripts/android-link-probe.mjs --dump results/<name>.json        # save uniPEQ's log
//   node scripts/android-link-probe.mjs --stop                            # stop it (after --dump)
//   … --watch      stay attached and print the probe's events (not for background runs)
//   … --serial <id>
//
// Freeze experiments (docs/phase-0.md, Q4):
//   … --lock                 the probe holds a Web Lock for the session
//   … --audio silent|quiet   the probe keeps an AudioContext playing
//   … --fgs --keep-visible   the overlay keeps the WebView reporting itself visible
//
// The foreground service and the deep link need the debug overlay (npm run overlay:apply).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ID = 'kr.potatosalad775.unipeq';
const SERVICE = `${APP_ID}/.LinkProbeService`;
const PORT = 9334;
const ROOM = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const EVAL_TIMEOUT_MS = 10000;

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const server = flag('server')?.replace(/\/+$/, '');
const room = flag('room')?.toUpperCase();
const dump = flag('dump');
const serial = flag('serial');
const audio = flag('audio');

if (audio && !['silent', 'quiet'].includes(audio)) fail('--audio must be silent or quiet');
if (has('keep-visible') && !has('fgs'))
	fail('--keep-visible goes with --fgs (the service applies it)');

if (room && !ROOM.test(room)) fail(`--room must be 8 characters of 0-9, A-Z without I, L, O, U`);
if ((room || has('arm') || has('fgs')) && !server) fail('--server <worker origin> is required');
if (server && !isOrigin(server))
	fail(
		`--server must be the Worker's origin, e.g. https://peq-link.example.workers.dev (got ${server}). ` +
			'The probe page shows the exact command for its room.'
	);
if (!room && !has('arm') && !dump && !has('stop') && !has('fgs') && !has('stop-fgs'))
	fail('Nothing to do: pass --room, --arm, --dump, --stop, --fgs or --stop-fgs');

const sdk =
	process.env.ANDROID_HOME ??
	process.env.ANDROID_SDK_ROOT ??
	join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const sdkAdb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const adbPath = existsSync(sdkAdb) ? sdkAdb : 'adb';
const adb = (...a) =>
	execFileSync(adbPath, [...(serial ? ['-s', serial] : []), ...a], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	}).trim();
/** `am stopservice` exits 255 even when it stopped the service; its output says what happened. */
const adbLoose = (...a) => {
	try {
		return adb(...a);
	} catch (error) {
		return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
	}
};

if (has('stop-fgs')) {
	console.log(adbLoose('shell', 'am', 'stopservice', '-n', SERVICE));
}
if (has('fgs')) {
	// Android 13+: without it the service still runs, but its notification is hidden.
	try {
		adb('shell', 'pm', 'grant', APP_ID, 'android.permission.POST_NOTIFICATIONS');
	} catch {
		// Older Android: no runtime permission to grant.
	}
	console.log(
		adb(
			'shell',
			'am',
			'start-foreground-service',
			'-n',
			SERVICE,
			'--es',
			'origin',
			server,
			'--ez',
			'keepVisible',
			String(has('keep-visible'))
		)
	);
}
if (!room && !has('arm') && !dump && !has('stop')) process.exit(0);

const pid = adb('shell', 'pidof', APP_ID);
if (!pid) fail(`${APP_ID} is not running: start the app first`);
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid.split(/\s+/)[0]}`);

const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = pages.find((p) => p.type === 'page');
if (!page) fail('No debuggable WebView page (is this a debug build?)');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = ({ data }) => {
	const msg = JSON.parse(data);
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	} else if (msg.method === 'Runtime.consoleAPICalled') {
		const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
		if (text.startsWith('[link-probe]')) console.log(text);
	}
};
const send = (method, params = {}) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	// A frozen app accepts the DevTools connection but runs nothing until it is thawed, so without
	// a timeout the driver would wait silently until uniPEQ next comes to the front.
	let timer;
	const frozen = new Promise((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`uniPEQ's WebView ran nothing for ${EVAL_TIMEOUT_MS / 1000} s: Android has most likely ` +
							'frozen the app in the background. Bring uniPEQ to the front, or start the ' +
							'foreground service in the same command (--fgs).'
					)
				),
			EVAL_TIMEOUT_MS
		);
	});
	const { result } = await Promise.race([
		send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
		frozen
	]).finally(() => clearTimeout(timer));
	if (result.exceptionDetails) {
		const { exception, text } = result.exceptionDetails;
		throw new Error(exception?.description ?? text);
	}
	return result.result.value;
};

try {
	if (dump) {
		const data = await evaluate(
			`window.__linkProbe ? JSON.stringify(window.__linkProbe.export(), null, 2) : null`
		);
		if (!data) throw new Error('No probe is running in the WebView');
		mkdirSync(dirname(dump), { recursive: true });
		writeFileSync(dump, data);
		console.log(`Saved ${dump}`);
	}
	if (has('stop')) {
		console.log(
			await evaluate(
				`window.__linkProbeArm?.remove(); window.__linkProbe?.stop(); ` +
					`window.__linkProbe ? 'Stopped the probe' : 'No probe was running'`
			)
		);
	}
	if (room || has('arm')) {
		if (has('watch')) await send('Runtime.enable');
		console.log(await evaluate(injection()));
		if (has('watch')) {
			console.log('Watching; Ctrl+C to stop (the probe keeps running in the app).');
			await new Promise(() => {});
		}
	}
} finally {
	ws.close();
	adb('forward', '--remove', `tcp:${PORT}`);
}

function injection() {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'probe.js'),
		'utf8'
	);
	const action = room
		? `return start(${JSON.stringify(room)}, ${JSON.stringify(server)});`
		: // --arm. A warm app gets the link through appUrlOpen. A cold start can't be armed in
			// advance, so only report the launch URL: Q6b checks that it carries the room.
			`window.__linkProbeArm?.remove();
			window.__linkProbeArm = await C.Plugins.App.addListener('appUrlOpen', ({ url }) => {
				console.log('[link-probe] appUrlOpen ' + url);
				const link = new URL(url);
				start(link.searchParams.get('room'), link.searchParams.get('server'));
			});
			const launch = await call('App', 'getLaunchUrl');
			return 'Armed for the deep link' + (launch?.url ? '; launch URL was ' + launch.url : '');`;
	return `(async () => {
		const C = window.Capacitor;
		if (!C?.isNativePlatform?.()) throw new Error('Not the native app');
		const call = (plugin, method, options = {}) =>
			C.Plugins?.[plugin]?.[method]
				? C.Plugins[plugin][method](options)
				: C.nativePromise(plugin, method, options);
		const url = URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: 'text/javascript' }));
		const { startProbe } = await import(url);
		// Every 10th heartbeat: a round trip through the Capacitor bridge into the Kotlin plugin.
		const extraStatus = async () => {
			const started = performance.now();
			const { devices } = await call('DeviceIo', 'list');
			return { deviceIoMs: Math.round(performance.now() - started), usbDevices: devices.length };
		};
		const start = (room, server) => {
			window.__linkProbe?.stop();
			window.__linkProbe = startProbe({
				server,
				room,
				label: 'uniPEQ WebView',
				relayOnly: ${has('relay')},
				holdLock: ${has('lock')},
				audio: ${JSON.stringify(audio ?? null)} ?? undefined,
				extraStatus,
				onEvent: (event) => console.log('[link-probe] ' + JSON.stringify(event))
			});
			return 'Joined room ' + room + '; detaching DevTools';
		};
		${action}
	})()`;
}

function isOrigin(value) {
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
	} catch {
		return false;
	}
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
