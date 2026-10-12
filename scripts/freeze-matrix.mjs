#!/usr/bin/env node
// Q4 freeze experiments back to back (docs/phase-0.md). For each variant a headless desktop
// Chromium hosts a room on the Worker, the script opens uniPEQ, joins it through the driver with
// the foreground service on and presses Home; after --seconds the host's summary and uniPEQ's own
// probe events (read from logcat, where Capacitor copies the WebView console) say whether the
// page froze.
//
//   node scripts/freeze-matrix.mjs --server <worker origin> [--seconds 150] [--only a,b]
//     [--screen-off] [--doze] [--serial id]
//
// --screen-off turns the screen off after Home and wakes it at the end of each run (it stays
// locked). Under a lock screen uniPEQ can't come to the front to thaw a page an earlier variant
// froze, so run keep-visible after the others, or alone.
//
// --doze (implies --screen-off) tells Android the charger is unplugged and forces deep Doze for
// the run, then resets both. Without it a phone on a charger never dozes (deviceidle stays ACTIVE
// while charging), and a natural deep Doze takes about an hour of unplugged, still, screen-off time.
//
// Before running: phone unlocked, screen timeout longer than --seconds (each run records whether
// the screen stayed on). Don't touch the phone or run the driver until it finishes.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const APP_ID = 'kr.potatosalad775.unipeq';

const VARIANTS = {
	baseline: [],
	lock: ['--lock'],
	'audio-silent': ['--audio', 'silent'],
	'audio-quiet': ['--audio', 'quiet'],
	'keep-visible': ['--keep-visible']
};

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const server = flag('server')?.replace(/\/+$/, '');
// The freeze has come anywhere from 18 s to 58 s after going hidden.
const seconds = Number(flag('seconds') ?? 150);
const serial = flag('serial');
const only = flag('only')?.split(',');
const doze = args.includes('--doze');
const screenOff = doze || args.includes('--screen-off');
if (!server) fail('--server <worker origin> is required');
const names = only ?? Object.keys(VARIANTS);
for (const name of names) if (!VARIANTS[name]) fail(`Unknown variant ${name}`);

const sdk =
	process.env.ANDROID_HOME ??
	process.env.ANDROID_SDK_ROOT ??
	join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const sdkAdb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const adbPath = existsSync(sdkAdb) ? sdkAdb : 'adb';
const adb = (...a) =>
	execFileSync(adbPath, [...(serial ? ['-s', serial] : []), ...a], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 256 * 1024 * 1024
	}).trim();
const drive = (...a) => {
	try {
		return execFileSync(
			'node',
			['scripts/android-link-probe.mjs', ...(serial ? ['--serial', serial] : []), ...a],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
		).trim();
	} catch (error) {
		return `FAILED: ${`${error.stdout ?? ''}${error.stderr ?? ''}`.trim()}`;
	}
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch();
const results = [];
try {
	for (const name of names) {
		// Every variant starts the same way, as a user would: uniPEQ in front, the link joined
		// while it's visible, then Home. Bringing it to the front also thaws a page an earlier
		// variant left frozen; a frozen page queues the driver's injection instead of running it.
		adb('shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`);
		await sleep(2500);

		const deviceStart = Number(adb('shell', 'date', '+%s'));
		const page = await browser.newPage();
		await page.goto(server);
		await page.click('#create');
		const room = await page.textContent('#code');
		console.log(`\n[${name}] room ${room}`);
		const joined = drive('--server', server, '--room', room, '--fgs', ...VARIANTS[name]);
		console.log(joined);
		await sleep(2000);
		adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
		// Unplug before the screen goes off: a (faked) unplug wakes the screen on Samsung.
		if (doze) adb('shell', 'dumpsys', 'battery', 'unplug');
		if (screenOff) {
			await sleep(1000);
			adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
			await sleep(1000);
		}
		if (doze) adb('shell', 'dumpsys', 'deviceidle', 'force-idle', 'deep');
		const screenAtStart = wakefulness();
		const idleAtStart = idleState();

		await sleep(seconds * 1000);
		const screenAtEnd = wakefulness();
		const idleAtEnd = idleState();
		if (doze) undoze();
		if (screenOff) adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
		const host = await page.evaluate(() => window.__linkProbe.summary());
		// When heartbeats started arriving late, in host seconds, to line up with Doze's stages.
		const gapsAtS = await page.evaluate(() =>
			window.__linkProbe
				.export()
				.events.filter((e) => e.kind === 'hb-gap')
				.map((e) => Math.round(e.t / 1000))
		);
		const unipeq = probeEvents(deviceStart);
		const overlay = overlayLog(deviceStart);
		console.log(drive('--stop', '--stop-fgs'));
		await page.close();

		const hidden = unipeq.find(
			(e) => e.kind === 'lifecycle' && e.event === 'visibilitychange' && e.visibility === 'hidden'
		);
		const freeze = unipeq.find((e) => e.kind === 'lifecycle' && e.event === 'freeze');
		// No channel means uniPEQ never joined: the run says nothing about freezing.
		const valid = host.openedAfterMs !== null;
		const result = {
			variant: name,
			room,
			valid,
			froze: valid ? Boolean(freeze) : null,
			frozeAfterHiddenS: freeze && hidden ? Math.round((freeze.t - hidden.t) / 100) / 10 : null,
			uniPeqVisibility: host.peerVisibility,
			heartbeatsReceived: host.heartbeats.received,
			heartbeatsExpected: Math.max(
				0,
				Math.floor(host.runningForS - (host.openedAfterMs ?? 0) / 1000) - 1
			),
			pingsAnswered: host.pings.answered,
			pingsLost: host.pings.lost,
			maxGapMs: host.heartbeats.maxGap,
			gapsOver2_5s: gapsAtS.length,
			firstGapAtS: gapsAtS[0] ?? null,
			rttMs: { p50: host.pings.rttP50Ms, p95: host.pings.rttP95Ms, max: host.pings.rttMaxMs },
			screen: { start: screenAtStart, end: screenAtEnd },
			idle: { start: idleAtStart, end: idleAtEnd },
			experiments: unipeq.filter((e) => e.kind.startsWith('experiment')),
			overlay,
			driver: joined
		};
		results.push(result);
		console.log(
			`[${name}] ` +
				(valid
					? `froze: ${result.froze ? `yes, ${result.frozeAfterHiddenS} s after hidden` : 'no'} · `
					: 'INVALID: uniPEQ never joined · ') +
				`heartbeats ${result.heartbeatsReceived}/${result.heartbeatsExpected} · ` +
				`pings ${result.pingsAnswered} answered, ${result.pingsLost} lost, ` +
				`RTT p95 ${result.rttMs.p95} ms · ` +
				`uniPEQ visibility ${result.uniPeqVisibility} · screen ${screenAtStart}→${screenAtEnd} · ` +
				`doze ${idleAtStart.deep}→${idleAtEnd.deep}`
		);
		if (result.experiments.length) console.log(`[${name}] ${JSON.stringify(result.experiments)}`);
		if (overlay.length) console.log(`[${name}] overlay: ${overlay.join(' | ')}`);
		await sleep(3000);
	}
} finally {
	// A crash mid-run mustn't leave the phone thinking it's unplugged and stuck in Doze.
	if (doze) undoze();
	await browser.close();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = `results/freeze-matrix-${stamp}.json`;
writeFileSync(file, JSON.stringify({ server, seconds, results }, null, 2));
console.log(`\nSaved ${file}`);

/** uniPEQ's probe events since `since` (device epoch seconds), from Capacitor's console bridge. */
function probeEvents(since) {
	return logcat(since)
		.filter(({ text }) => text.includes('[link-probe] {'))
		.map(({ text }) => {
			try {
				return JSON.parse(text.slice(text.indexOf('[link-probe] {') + 13));
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function overlayLog(since) {
	return logcat(since)
		.filter(({ text }) => / LinkProbe\s*:/.test(text))
		.map(({ text }) => text.slice(text.indexOf('LinkProbe')).trim());
}

function logcat(since) {
	return adb('logcat', '-d', '-v', 'epoch')
		.split('\n')
		.map((line) => ({ epoch: Number.parseFloat(line), text: line }))
		.filter(({ epoch }) => epoch >= since);
}

/**
 * Doze (deviceidle) state, which is not the screen's 'Dozing': that one only means the screen is
 * off with the always-on display drawing. Deep IDLE is when Android restricts network and timers.
 */
function idleState() {
	const get = (what) => adb('shell', 'dumpsys', 'deviceidle', 'get', what);
	return { deep: get('deep'), light: get('light'), charging: get('charging') === 'true' };
}

function undoze() {
	try {
		adb('shell', 'dumpsys', 'deviceidle', 'unforce');
		adb('shell', 'dumpsys', 'battery', 'reset');
	} catch (error) {
		console.error(`Couldn't reset Doze: ${error.message}`);
	}
}

/** 'Awake', 'Asleep' or 'Dozing' (screen off, always-on display drawing), from dumpsys power. */
function wakefulness() {
	return /mWakefulness=([A-Za-z]+)/.exec(adb('shell', 'dumpsys', 'power'))?.[1] ?? 'unknown';
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
