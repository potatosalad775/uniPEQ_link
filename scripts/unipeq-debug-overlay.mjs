#!/usr/bin/env node
// Copies android-debug/ into uniPEQ's debug source set (android/app/src/debug), or removes it.
// Gradle merges that source set into debug builds only, so the Phase 0 foreground service and
// deep link never reach a release, and uniPEQ's tracked files stay untouched.
//
//   node scripts/unipeq-debug-overlay.mjs apply|remove [--unipeq ../uniPEQ]

import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command] = process.argv.slice(2);
const i = process.argv.indexOf('--unipeq');
const unipeq = resolve(i >= 0 ? process.argv[i + 1] : join(root, '..', 'uniPEQ'));
const target = join(unipeq, 'android', 'app', 'src', 'debug');
/** Marks the directory as ours, so `remove` never deletes a debug source set uniPEQ grows later. */
const marker = join(target, '.peq-link-probe');

if (!existsSync(join(unipeq, 'capacitor.config.ts'))) fail(`Not a uniPEQ checkout: ${unipeq}`);

if (command === 'apply') {
	if (existsSync(target) && !existsSync(marker))
		fail(`${target} already exists and isn't the probe overlay; merge by hand.`);
	cpSync(join(root, 'android-debug'), target, { recursive: true });
	writeFileSync(marker, 'Phase 0 link probe overlay from uniPEQ_link. Do not commit.\n');
	console.log(`Applied to ${target}`);
	console.log('Next, in uniPEQ: npm run android. Remove with: npm run overlay:remove');
} else if (command === 'remove') {
	if (!existsSync(target)) console.log('Nothing to remove.');
	else if (!existsSync(marker)) fail(`${target} isn't the probe overlay; leaving it alone.`);
	else {
		rmSync(target, { recursive: true });
		console.log(`Removed ${target}. Rebuild uniPEQ (npm run android) to drop it from the app.`);
	}
} else fail('Usage: unipeq-debug-overlay.mjs apply|remove [--unipeq <path>]');

function fail(message) {
	console.error(message);
	process.exit(1);
}
