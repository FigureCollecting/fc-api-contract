import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Hlc,
  MAX_FUTURE_SKEW_MS,
  MAX_HLC_COUNTER,
  SERVER_DEVICE_ID,
  VersionError,
  compareVersion,
  parseVersion,
  type HlcState,
} from '../src/index.js';
import { microsToInstant } from '../src/version.js';

const DEVICE = '0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
const OTHER = '9c1e3a5b7d9f1b3d5f7a9c1e3b5d7f9a';
const T0 = Date.parse('2026-09-14T11:30:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A clock the test drives: `wall` is what Date.now would say, `mono` what performance.now would. */
class FakeClock {
  wall: number;
  mono = 1_000;
  constructor(wall = T0) { this.wall = wall; }
  wallMs = () => this.wall;
  monoMs = () => this.mono;
  advance(ms: number) { this.wall += ms; this.mono += ms; }
  /** The device sleeps: the wall clock keeps time, performance.now stalls. */
  sleep(ms: number) { this.wall += ms; }
}

const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '000Z');
const instantOf = (v: string) => parseVersion(v)!.instant;

describe('Hlc.tick', () => {
  it('mints a device-suffixed token at the anchored instant', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0), 0);

    expect(hlc.tick()).toBe(`2026-09-14T11:30:00.000000Z#0000000000#${DEVICE}`);
  });

  it('bumps the counter when the clock has not moved', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const a = hlc.tick();
    const b = hlc.tick();

    expect(parseVersion(b)!.counter).toBe(1);
    expect(compareVersion(a, b)).toBe(-1);
  });

  it('stays monotonic when the wall clock jumps backwards', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    const before = hlc.tick();
    clock.wall -= 3_600_000;

    const after = hlc.tick();
    expect(compareVersion(before, after)).toBe(-1);
    expect(instantOf(after)).toBe(instantOf(before));
  });

  it('resets the counter once the clock passes the last token', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.tick();
    hlc.tick();
    clock.advance(1);

    expect(parseVersion(hlc.tick())!.counter).toBe(0);
  });

  it('applies the measured offset to the wall clock', () => {
    const clock = new FakeClock(T0 - 90_000); // device runs 90 s slow
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0), 0);

    expect(hlc.offsetMs).toBe(90_000);
    expect(instantOf(hlc.tick())).toBe('2026-09-14T11:30:00.000000Z');
  });

  it('takes the offset at the midpoint of the round trip', () => {
    const clock = new FakeClock(T0);
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0 - 400), 1_000); // sampled 400 ms ago by our wall, half of a 1 s trip is 500 ms

    expect(hlc.offsetMs).toBe(100);
  });

  it('caps a fresh anchor at the sample plus elapsed monotonic time plus the clamp when the round trip makes the offset suspect', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock, clampMs: 60_000 });
    hlc.measure(iso(T0), 180_000); // a 3-minute round trip: the midpoint may be off by 90 s

    expect(hlc.offsetMs).toBe(90_000);
    expect(hlc.fresh).toBe(true);
    expect(instantOf(hlc.tick())).toBe('2026-09-14T11:31:00.000000Z');
  });

  it('trusts the wall clock after a sleep longer than the clamp, so a later edit outranks an earlier one', () => {
    const clockA = new FakeClock();
    const a = new Hlc({ deviceId: DEVICE, clock: clockA });
    a.measure(iso(T0), 0);
    clockA.sleep(HOUR);
    const later = a.tick(); // offline, one hour after the last Status

    const clockB = new FakeClock(T0 + HOUR / 2);
    const b = new Hlc({ deviceId: OTHER, clock: clockB });
    b.measure(iso(T0 + HOUR / 2), 0);
    const earlier = b.tick();

    expect(a.fresh).toBe(false);
    expect(instantOf(later)).toBe('2026-09-14T12:30:00.000000Z');
    expect(compareVersion(earlier, later)).toBe(-1);
  });

  it('orders an edit made after an overnight sleep above an import dated that morning', () => {
    const evening = Date.parse('2026-09-25T20:00:00.000Z');
    const clock = new FakeClock(evening);
    const phone = new Hlc({ deviceId: DEVICE, clock });
    phone.measure(iso(evening), 0);
    clock.sleep(18 * HOUR);

    const edit = phone.tick();
    const importVersion = `2026-09-26T00:00:00.000000Z#0000000001#${SERVER_DEVICE_ID}`;
    expect(instantOf(edit)).toBe('2026-09-26T14:00:00.000000Z');
    expect(compareVersion(importVersion, edit)).toBe(-1);
  });

  it('follows a forward wall jump past the clamp; the server rejects that as version_future', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock, clampMs: 60_000 });
    hlc.measure(iso(T0), 0);
    clock.wall += DAY; // the device clock is set a day ahead; mono does not move

    expect(hlc.fresh).toBe(false);
    expect(instantOf(hlc.tick())).toBe('2026-09-15T11:30:00.000000Z');
  });

  it('carries into the next microsecond when the counter is exhausted', () => {
    const clock = new FakeClock();
    const micros = BigInt(T0) * 1000n;
    const hlc = new Hlc({ deviceId: DEVICE, clock, state: { micros, counter: 9_999_999_999 } });

    const next = hlc.tick();
    expect(next).toBe(`2026-09-14T11:30:00.000001Z#0000000000#${DEVICE}`);
  });

  it('runs on the wall clock plus the restored offset before any measurement', () => {
    const clock = new FakeClock(T0 - 5_000);
    const hlc = new Hlc({ deviceId: DEVICE, clock, offsetMs: 5_000 });

    expect(hlc.anchored).toBe(false);
    expect(instantOf(hlc.tick())).toBe('2026-09-14T11:30:00.000000Z');
  });
});

describe('Hlc.observe', () => {
  it('makes the next tick beat an observed remote token', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const remote = `2026-09-14T11:30:02.000000Z#0000000004#${OTHER}`;
    hlc.observe(remote);

    const mine = hlc.tick();
    expect(compareVersion(remote, mine)).toBe(-1);
    expect(parseVersion(mine)!.counter).toBe(5);
  });

  it('makes the next tick beat an observed bare instant', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const remote = '2026-09-14T11:30:02.000000Z';
    hlc.observe(remote);

    expect(compareVersion(remote, hlc.tick())).toBe(-1);
  });

  it('raises the counter for an observed token at the current instant', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const first = hlc.tick();
    const remote = `${instantOf(first)}#0000000042#${OTHER}`;
    hlc.observe(remote);

    expect(compareVersion(remote, hlc.tick())).toBe(-1);
  });

  it('ignores an older token', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.tick();
    hlc.observe('2020-01-01T00:00:00.000000Z');

    expect(parseVersion(hlc.tick())!.counter).toBe(1);
  });

  it('makes the next tick beat an observed token past the cap, so an edit is never minted below its base', () => {
    // The server accepts up to server_now + 5 min, and a Status sample lags true time by its down-leg.
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0 - 300), 600);
    const base = `${iso(T0 + MAX_FUTURE_SKEW_MS - 100)}#0000000003#${OTHER}`;
    hlc.observe(base);

    expect(compareVersion(base, hlc.tick())).toBe(-1);
  });

  it('folds a far-future token unclamped: bounding feed tokens is the server\'s job', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.measure(iso(T0), 0);
    const token = `2099-01-01T00:00:00.000000Z#0000000001#${SERVER_DEVICE_ID}`;
    hlc.observe(token);

    expect(compareVersion(token, hlc.tick())).toBe(-1);
  });

  it('carries 1 us past the cap after a token at the cap with an exhausted counter, because order outranks the bound', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.measure(iso(T0), 0);
    const atCap = `${iso(T0 + MAX_FUTURE_SKEW_MS)}#${MAX_HLC_COUNTER}#${OTHER}`;
    hlc.observe(atCap);

    const next = hlc.tick();
    expect(next).toBe(`2026-09-14T11:35:00.000001Z#0000000000#${DEVICE}`);
    expect(compareVersion(atCap, next)).toBe(-1);
  });

  it('throws on a token that is not canonical', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    expect(() => hlc.observe('2026-09-14T11:30:00Z')).toThrow(VersionError);
  });
});

describe('Hlc.fresh', () => {
  it('holds from a Status sample until the wall clock runs ahead of monotonic time by more than the clamp', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock, clampMs: 60_000 });
    expect(hlc.fresh).toBe(false);

    hlc.measure(iso(T0), 0);
    expect(hlc.fresh).toBe(true);
    clock.advance(HOUR);
    expect(hlc.fresh).toBe(true);
    clock.sleep(60_000);
    expect(hlc.fresh).toBe(true);
    clock.sleep(1);
    expect(hlc.fresh).toBe(false);
    clock.wall -= HOUR; // a backward jump is no forward gap
    expect(hlc.fresh).toBe(true);
    clock.sleep(2 * HOUR);
    hlc.measure(iso(T0 + 3 * HOUR), 0);
    expect(hlc.fresh).toBe(true);
  });
});

describe('Hlc.rebase', () => {
  it('lowers a restored clock that ran ahead onto the anchored present', () => {
    const session1 = new Hlc({ deviceId: DEVICE, clock: new FakeClock(T0 + DAY) }); // offline, clock a day ahead
    session1.tick();
    const snap = session1.snapshot();

    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock, state: snap, offsetMs: 0 });
    hlc.measure(iso(T0), 0);
    expect(instantOf(hlc.tick())).toBe('2026-09-15T11:30:00.000000Z'); // REJECTED version_future

    expect(hlc.rebase()).toBe(true);
    expect(instantOf(hlc.tick())).toBe('2026-09-14T11:30:00.000000Z');
  });

  it('recovers from an offline tick on a clock a year ahead, re-minting above the base', () => {
    const clock = new FakeClock(T0 + 365 * DAY);
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    expect(instantOf(hlc.tick())).toBe('2027-09-14T11:30:00.000000Z');

    hlc.measure(iso(T0), 0);
    hlc.rebase();
    const base = `${iso(T0 - 60_000)}#0000000002#${OTHER}`;
    hlc.observe(base);
    const reminted = hlc.tick();

    expect(instantOf(reminted)).toBe('2026-09-14T11:30:00.000000Z');
    expect(compareVersion(base, reminted)).toBe(-1);
  });

  it('leaves a clock that is not ahead untouched', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.measure(iso(T0), 0);
    const before = hlc.tick();

    expect(hlc.rebase()).toBe(false);
    expect(compareVersion(before, hlc.tick())).toBe(-1);
  });

  it('needs a Status sample first', () => {
    expect(() => new Hlc({ deviceId: DEVICE, clock: new FakeClock() }).rebase()).toThrow(/Status/);
  });
});

describe('Hlc construction and state', () => {
  it('normalises a dashed device id', () => {
    const hlc = new Hlc({ deviceId: '0F3A5C7E-9B1D-2F4A-6C8E-0B2D4F6A8C0E', clock: new FakeClock() });
    expect(hlc.deviceId).toBe(DEVICE);
  });

  it('rejects a bad device id, clamp or measurement', () => {
    expect(() => new Hlc({ deviceId: 'nope' })).toThrow(VersionError);
    expect(() => new Hlc({ deviceId: DEVICE, clampMs: -1 })).toThrow(RangeError);
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    expect(() => hlc.measure(iso(T0), -1)).toThrow(RangeError);
    expect(() => hlc.measure(iso(T0), Number.NaN)).toThrow(RangeError);
    expect(() => hlc.measure('2026-09-14T11:30:00Z', 10)).toThrow(VersionError);
  });

  it('continues monotonically from a snapshot', () => {
    const clock = new FakeClock();
    const a = new Hlc({ deviceId: DEVICE, clock });
    a.measure(iso(T0 + 1_000), 0);
    const last = a.tick();
    a.tick();
    const snap = a.snapshot();
    clock.wall -= 60_000;

    const b = new Hlc({ deviceId: DEVICE, clock, state: snap, offsetMs: snap.offsetMs });
    expect(compareVersion(last, b.tick())).toBe(-1);
    expect(snap.counter).toBe(1);
    expect(snap.offsetMs).toBe(1_000);
  });

  it('defaults to the real clocks', () => {
    const before = Date.now();
    const hlc = new Hlc({ deviceId: DEVICE });
    const minted = parseVersion(hlc.tick())!;
    hlc.measure(microsToInstant(BigInt(Date.now()) * 1000n), 0);

    expect(Number(minted.micros / 1000n)).toBeGreaterThanOrEqual(before);
    expect(hlc.anchored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The properties. A model of real time drives three clocks: the server's
// (truth), the device wall clock (drifts and jumps both ways) and the device
// monotonic clock (never jumps; stalls while the device sleeps).
// ---------------------------------------------------------------------------
type Action =
  | { kind: 'tick'; up: number; down: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'wallJump'; ms: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'measure'; up: number; down: number }
  | { kind: 'observe'; ahead: number; counter: number }
  | { kind: 'rebase' };

const leg = fc.integer({ min: 1, max: 3_000 });
const tickA = fc.record({ kind: fc.constant('tick' as const), up: leg, down: leg });
const advanceA = fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 2 * HOUR }) });
const wallJumpA = fc.record({ kind: fc.constant('wallJump' as const), ms: fc.integer({ min: -2 * HOUR, max: 2 * HOUR }) });
const sleepA = fc.record({ kind: fc.constant('sleep' as const), ms: fc.integer({ min: 0, max: DAY }) });
const measureA = fc.record({ kind: fc.constant('measure' as const), up: leg, down: leg });
const rebaseA = fc.constant({ kind: 'rebase' } as const);
const counterA = fc.integer({ min: 0, max: MAX_HLC_COUNTER });
/** Another device's write, as the server accepted it (never past server_now + 5 min). */
const feedObserveA = fc.record({
  kind: fc.constant('observe' as const),
  ahead: fc.integer({ min: -HOUR, max: MAX_FUTURE_SKEW_MS }),
  counter: counterA,
});
/** Any canonical token at all, far future included. */
const anyObserveA = fc.record({
  kind: fc.constant('observe' as const),
  ahead: fc.integer({ min: -DAY, max: 3650 * DAY }),
  counter: counterA,
});

const restoredState: fc.Arbitrary<HlcState | undefined> = fc.option(
  fc.record({
    micros: fc.bigInt({ min: BigInt(T0 - 2 * DAY) * 1000n, max: BigInt(T0 + 2 * DAY) * 1000n }),
    counter: counterA,
  }),
  { nil: undefined },
);
const restoredOffset = fc.option(fc.integer({ min: -DAY, max: DAY }), { nil: undefined });
const drift = fc.integer({ min: -DAY, max: DAY });

const clampMicros = BigInt(MAX_FUTURE_SKEW_MS) * 1000n;

class World {
  truth = T0; // the server's clock, which is true time
  readonly clock: FakeClock;
  readonly hlc: Hlc;
  lastRtt = 0;
  private sample: { wall: number; mono: number } | undefined;

  constructor(drift: number, state?: HlcState, offsetMs?: number) {
    this.clock = new FakeClock(T0 + drift);
    this.hlc = new Hlc({ deviceId: DEVICE, clock: this.clock, state, offsetMs });
  }

  advance(ms: number) { this.truth += ms; this.clock.advance(ms); }
  sleep(ms: number) { this.truth += ms; this.clock.sleep(ms); }

  /** A Status round trip: the server samples its clock after the up-leg. */
  measure(up: number, down: number) {
    this.advance(up);
    const sampled = this.truth;
    this.advance(down);
    this.hlc.measure(iso(sampled), up + down);
    this.lastRtt = up + down;
    this.sample = { wall: this.clock.wall, mono: this.clock.mono };
  }

  remote(ahead: number, counter: number) {
    return `${iso(this.truth + ahead)}#${String(counter).padStart(10, '0')}#${OTHER}`;
  }

  /** The server's version_future bound right now. */
  bound() { return BigInt(this.truth) * 1000n + clampMicros; }

  /** The contract's freshness: since the sample, the wall has not run ahead of monotonic time by more than the clamp. */
  fresh() {
    const s = this.sample;
    return s !== undefined && this.clock.wall - s.wall - (this.clock.mono - s.mono) <= MAX_FUTURE_SKEW_MS;
  }

  move(a: Action) {
    switch (a.kind) {
      case 'advance': this.advance(a.ms); break;
      case 'wallJump': this.clock.wall += a.ms; break;
      case 'sleep': this.sleep(a.ms); break;
      case 'measure': this.measure(a.up, a.down); break;
      default: break;
    }
  }
}

const max = (a: string | undefined, b: string) => (a === undefined || compareVersion(a, b) < 0 ? b : a);

describe('Hlc properties', () => {
  it('orders every tick above the previous one and every token observed since the last rebase, from any restored state', () => {
    fc.assert(
      fc.property(
        restoredState,
        restoredOffset,
        drift,
        fc.array(fc.oneof(tickA, tickA, advanceA, wallJumpA, sleepA, measureA, anyObserveA, rebaseA), { maxLength: 60, size: 'max' }),
        (state, offsetMs, d, actions) => {
          const w = new World(d, state, offsetMs);
          let floor: string | undefined;
          for (const a of actions) {
            if (a.kind === 'tick') {
              const v = w.hlc.tick();
              if (floor !== undefined && compareVersion(floor, v) !== -1) return false;
              floor = v;
            } else if (a.kind === 'observe') {
              const t = w.remote(a.ahead, a.counter);
              w.hlc.observe(t);
              floor = max(floor, t);
            } else if (a.kind === 'rebase') {
              if (w.hlc.anchored && w.hlc.rebase()) floor = undefined;
            } else {
              w.move(a);
            }
          }
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('once anchored and rebased, is never rejected while fresh, and one rebase always recovers a rejection', () => {
    fc.assert(
      fc.property(
        restoredState,
        restoredOffset,
        drift,
        fc.array(fc.oneof(tickA, advanceA, wallJumpA, sleepA, feedObserveA), { maxLength: 10, size: 'max' }),
        fc.array(fc.oneof(tickA, tickA, advanceA, wallJumpA, sleepA, measureA, feedObserveA), { minLength: 1, maxLength: 60, size: 'max' }),
        (state, offsetMs, d, offline, online) => {
          const w = new World(d, state, offsetMs);
          let base: string | undefined; // the facet's version on the server
          const see = (t: string) => { w.hlc.observe(t); base = max(base, t); };

          // Offline launch: edits are minted but cannot be pushed yet.
          let poisoned = state !== undefined;
          for (const a of offline) {
            if (a.kind === 'tick') { w.hlc.tick(); poisoned = true; }
            else if (a.kind === 'observe') see(w.remote(a.ahead, a.counter));
            else w.move(a);
          }

          w.measure(20, 20); // sign-in always passes a Status probe first
          const accepted = (v: string) => parseVersion(v)!.micros <= w.bound();
          // An exhausted counter carries 1 us past a token at the bound; nothing else lands there.
          const carried = (v: string) => parseVersion(v)!.micros === w.bound() + 1n && parseVersion(v)!.counter === 0;

          for (const a of online) {
            if (a.kind === 'tick') {
              const fresh = w.fresh();
              let v = w.hlc.tick();
              if (!accepted(v)) {
                if (fresh && !poisoned && !carried(v)) return false;
                // REJECTED version_future: fresh Status, rebase, re-observe the base, re-mint.
                w.measure(a.up, a.down);
                w.hlc.rebase();
                if (base !== undefined) w.hlc.observe(base);
                v = w.hlc.tick();
                if (!accepted(v)) return false;
                poisoned = false;
              }
              if (base !== undefined && compareVersion(base, v) !== -1) return false;
              base = v;
            } else if (a.kind === 'observe') {
              see(w.remote(a.ahead, a.counter));
            } else {
              w.move(a);
            }
          }
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('never clamps an honest clock: across sleeps of any length, a tick is at least true-now minus the round trip', () => {
    fc.assert(
      fc.property(
        drift,
        leg,
        leg,
        fc.array(fc.oneof(tickA, tickA, advanceA, sleepA, measureA, feedObserveA), { minLength: 1, maxLength: 60, size: 'max' }),
        (d, up, down, actions) => {
          const w = new World(d);
          w.measure(up, down);
          for (const a of actions) {
            if (a.kind === 'tick') {
              if (parseVersion(w.hlc.tick())!.micros < BigInt(w.truth - w.lastRtt) * 1000n) return false;
            } else if (a.kind === 'observe') {
              w.hlc.observe(w.remote(a.ahead, a.counter));
            } else {
              w.move(a);
            }
          }
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
