/**
 * Whether the other side is still there (design §3, §4.7).
 *
 * mGT decides for the link: WebRTC stays `connected` while uniPEQ's page is frozen, so only
 * answers count. uniPEQ only ends a session mGT abandoned, and lateness there is harmless (Doze
 * drifts its timers; the notification stays up a little longer).
 */
import { TIMINGS, type Timings } from './protocol.ts';

export type Liveness = 'alive' | 'stalled' | 'ended';

/** Page lifecycle events after which this page's own timers were not running. */
const RESUMED = ['visibilitychange', 'resume', 'pageshow'];

/** mGT: pings uniPEQ and turns silence into "stalled", then "ended". */
export class LivenessClock {
	private readonly timings: Timings;
	private readonly ping: (n: number) => void;
	private readonly onChange: (state: Liveness) => void;
	private n = 0;
	private heardAt = Date.now();
	private current: Liveness = 'alive';
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		ping: (n: number) => void,
		onChange: (state: Liveness) => void,
		timings: Timings = TIMINGS
	) {
		this.ping = ping;
		this.onChange = onChange;
		this.timings = timings;
	}

	get state(): Liveness {
		return this.current;
	}

	start(): void {
		if (this.timer !== null) return;
		this.heardAt = Date.now();
		this.timer = setInterval(() => this.tick(), this.timings.pingMs);
		if (typeof document !== 'undefined')
			for (const type of RESUMED) document.addEventListener(type, this.onResume);
		this.tick();
	}

	/** Any message from uniPEQ counts as alive. */
	heard(): void {
		this.heardAt = Date.now();
		this.set('alive');
	}

	/**
	 * mGT's own page is back. Time it spent hidden or frozen isn't uniPEQ's silence, so the clock
	 * restarts, and a ping goes now rather than at the next tick.
	 */
	resumed(): void {
		if (this.timer === null) return;
		this.heardAt = Date.now();
		this.tick();
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		if (typeof document !== 'undefined')
			for (const type of RESUMED) document.removeEventListener(type, this.onResume);
	}

	private readonly onResume = (): void => {
		if (document.visibilityState === 'visible') this.resumed();
	};

	private tick(): void {
		const silence = Date.now() - this.heardAt;
		if (silence >= this.timings.endMs) {
			this.set('ended');
			this.stop();
			return;
		}
		if (silence >= this.timings.stallMs) this.set('stalled');
		this.ping(++this.n);
	}

	private set(state: Liveness): void {
		if (state === this.current || this.current === 'ended') return;
		this.current = state;
		this.onChange(state);
	}
}

/**
 * uniPEQ: ends a session mGT abandoned. Silence counts only while uniPEQ isn't in front: while the
 * user is in uniPEQ, mGT's silence costs nothing. After `away` (mGT's page closed or reloading)
 * the wait is `awayMs` wherever uniPEQ is.
 */
export class GraceClock {
	private readonly timings: Timings;
	private readonly onExpire: () => void;
	private foreground: boolean;
	private awayAt: number | null = null;
	private heardAt = Date.now();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(onExpire: () => void, foreground = true, timings: Timings = TIMINGS) {
		this.onExpire = onExpire;
		this.foreground = foreground;
		this.timings = timings;
		this.arm();
	}

	heard(): void {
		this.heardAt = Date.now();
		this.awayAt = null;
		this.arm();
	}

	away(): void {
		this.awayAt = Date.now();
		this.arm();
	}

	/** From Capacitor's `appStateChange`, not `visibilityState`: keep-visible holds that at visible. */
	setForeground(foreground: boolean): void {
		this.foreground = foreground;
		// The background clock starts when uniPEQ leaves the front, not at mGT's last message.
		if (!foreground) this.heardAt = Math.max(this.heardAt, Date.now());
		this.arm();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	private deadline(): number {
		const away = this.awayAt === null ? Infinity : this.awayAt + this.timings.awayMs;
		const silent = this.foreground ? Infinity : this.heardAt + this.timings.endMs;
		return Math.min(away, silent);
	}

	private arm(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		if (this.stopped) return;
		const deadline = this.deadline();
		if (deadline === Infinity) return;
		// Re-checked when it fires: a timer can wake early or late, but the clock decides.
		this.timer = setTimeout(
			() => {
				this.timer = null;
				if (Date.now() >= this.deadline()) {
					this.stop();
					this.onExpire();
				} else this.arm();
			},
			Math.max(0, deadline - Date.now())
		);
	}
}
