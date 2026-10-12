// mGT's silence clock and uniPEQ's grace clock (design §3, §4.7), with mocked timers.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { GraceClock, LivenessClock, type Liveness } from '../client/liveness.ts';
import { TIMINGS } from '../client/protocol.ts';

beforeEach(() =>
	mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
);
afterEach(() => mock.timers.reset());

describe('LivenessClock', () => {
	it('pings, stalls after 15 s of silence, ends after 10 min', () => {
		const pings: number[] = [];
		const states: Liveness[] = [];
		const clock = new LivenessClock(
			(n) => pings.push(n),
			(s) => states.push(s)
		);
		clock.start();
		assert.deepEqual(pings, [1]);
		mock.timers.tick(TIMINGS.stallMs);
		assert.deepEqual(states, ['stalled']);
		clock.heard();
		assert.deepEqual(states, ['stalled', 'alive']);
		for (let t = 0; t < TIMINGS.endMs; t += TIMINGS.pingMs) mock.timers.tick(TIMINGS.pingMs);
		assert.deepEqual(states, ['stalled', 'alive', 'stalled', 'ended']);
		const sent = pings.length;
		mock.timers.tick(60_000);
		assert.equal(pings.length, sent, 'no pings after the end');
	});

	it("doesn't count mGT's own time away as silence", () => {
		const states: Liveness[] = [];
		const clock = new LivenessClock(
			() => {},
			(s) => states.push(s)
		);
		clock.start();
		mock.timers.tick(TIMINGS.stallMs - 1000);
		clock.resumed();
		mock.timers.tick(TIMINGS.stallMs - 1000);
		assert.deepEqual(states, []);
		clock.stop();
	});
});

describe('GraceClock', () => {
	it("doesn't run while uniPEQ is in front", () => {
		let expired = false;
		new GraceClock(() => (expired = true), true);
		mock.timers.tick(TIMINGS.endMs * 3);
		assert.equal(expired, false);
	});

	it('ends after the grace period in the background, counted from leaving the front', () => {
		let expired = false;
		const clock = new GraceClock(() => (expired = true), true);
		mock.timers.tick(TIMINGS.endMs);
		clock.setForeground(false);
		mock.timers.tick(TIMINGS.endMs - 1000);
		assert.equal(expired, false);
		clock.heard();
		mock.timers.tick(TIMINGS.endMs - 1000);
		assert.equal(expired, false);
		mock.timers.tick(1000);
		assert.equal(expired, true);
	});

	it('ends 30 s after away wherever uniPEQ is, unless mGT comes back', () => {
		let expired = 0;
		const clock = new GraceClock(() => expired++, true);
		clock.away();
		mock.timers.tick(TIMINGS.awayMs - 1);
		clock.heard();
		mock.timers.tick(TIMINGS.awayMs);
		assert.equal(expired, 0);
		clock.away();
		mock.timers.tick(TIMINGS.awayMs);
		assert.equal(expired, 1);
	});
});
