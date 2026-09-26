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

    expect(hlc.tick(undefined)).toBe(`2026-09-14T11:30:00.000000Z#0000000000#${DEVICE}`);
  });

  it('bumps the counter when the clock has not moved', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const a = hlc.tick(undefined);
    const b = hlc.tick(undefined);

    expect(parseVersion(b)!.counter).toBe(1);
    expect(compareVersion(a, b)).toBe(-1);
  });

  it('stays monotonic when the wall clock jumps backwards', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    const before = hlc.tick(undefined);
    clock.wall -= 3_600_000;

    const after = hlc.tick(undefined);
    expect(compareVersion(before, after)).toBe(-1);
    expect(instantOf(after)).toBe(instantOf(before));
  });

  it('resets the counter once the clock passes the last token', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.tick(undefined);
    hlc.tick(undefined);
    clock.advance(1);

    expect(parseVersion(hlc.tick(undefined))!.counter).toBe(0);
  });

  it('applies the measured offset to the wall clock', () => {
    const clock = new FakeClock(T0 - 90_000); // device runs 90 s slow
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0), 0);

    expect(hlc.offsetMs).toBe(90_000);
    expect(instantOf(hlc.tick(undefined))).toBe('2026-09-14T11:30:00.000000Z');
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
    expect(instantOf(hlc.tick(undefined))).toBe('2026-09-14T11:31:00.000000Z');
  });

  it('still caps when the wall has run ahead of monotonic time by exactly the clamp', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock, clampMs: 60_000 });
    hlc.measure(iso(T0), 2_000); // the midpoint puts the server 1 s ahead of the sample
    clock.wall += 60_000;

    expect(hlc.fresh).toBe(true);
    expect(instantOf(hlc.tick(undefined))).toBe('2026-09-14T11:31:00.000000Z');
  });

  it('trusts the wall clock after a sleep longer than the clamp, so a later edit outranks an earlier one', () => {
    const clockA = new FakeClock();
    const a = new Hlc({ deviceId: DEVICE, clock: clockA });
    a.measure(iso(T0), 0);
    clockA.sleep(HOUR);
    const later = a.tick(undefined); // offline, one hour after the last Status

    const clockB = new FakeClock(T0 + HOUR / 2);
    const b = new Hlc({ deviceId: OTHER, clock: clockB });
    b.measure(iso(T0 + HOUR / 2), 0);
    const earlier = b.tick(undefined);

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

    const edit = phone.tick(undefined);
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
    expect(instantOf(hlc.tick(undefined))).toBe('2026-09-15T11:30:00.000000Z');
  });

  it('carries into the next microsecond when the counter is exhausted', () => {
    const clock = new FakeClock();
    const micros = BigInt(T0) * 1000n;
    const hlc = new Hlc({ deviceId: DEVICE, clock, state: { micros, counter: 9_999_999_999 } });

    const next = hlc.tick(undefined);
    expect(next).toBe(`2026-09-14T11:30:00.000001Z#0000000000#${DEVICE}`);
  });

  it('runs on the wall clock plus the restored offset before any measurement', () => {
    const clock = new FakeClock(T0 - 5_000);
    const hlc = new Hlc({ deviceId: DEVICE, clock, offsetMs: 5_000 });

    expect(hlc.anchored).toBe(false);
    expect(instantOf(hlc.tick(undefined))).toBe('2026-09-14T11:30:00.000000Z');
  });

  it('mints above the base it is handed, even when the clock is behind it', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.measure(iso(T0), 0);
    const base = `${iso(T0 + 4 * 60_000)}#0000000003#${OTHER}`; // another device, its clock 4 min ahead

    const edit = hlc.tick(base);
    expect(edit).toBe(`2026-09-14T11:34:00.000000Z#0000000004#${DEVICE}`);
    expect(compareVersion(base, edit)).toBe(-1);
  });

  it('refuses to mint without being handed the base, so the facet floor cannot be forgotten', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const untyped = hlc as unknown as { tick(): string };

    expect(() => untyped.tick()).toThrow(TypeError);
  });

  it('throws on a base that is not canonical', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    expect(() => hlc.tick('2026-09-14T11:30:00Z')).toThrow(VersionError);
  });

  it('never mints below the Status sample plus monotonic time since it when the wall clock is corrected backwards', () => {
    const clockA = new FakeClock(T0 + 10 * 60_000); // A's wall runs 10 min fast
    const a = new Hlc({ deviceId: DEVICE, clock: clockA });
    a.measure(iso(T0), 0);
    clockA.wall -= 10 * 60_000; // automatic time corrects the wall mid-session
    clockA.advance(5 * 60_000);
    const later = a.tick(undefined); // A edits at true T0 + 5 min

    const b = new Hlc({ deviceId: OTHER, clock: new FakeClock(T0 + 2 * 60_000) });
    b.measure(iso(T0 + 2 * 60_000), 0);
    const earlier = b.tick(undefined); // B edits at true T0 + 2 min

    expect(a.fresh).toBe(true);
    expect(instantOf(later)).toBe('2026-09-14T11:35:00.000000Z');
    expect(compareVersion(earlier, later)).toBe(-1);
  });
});

describe('Hlc.observe', () => {
  it('makes the next tick beat an observed remote token', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const remote = `2026-09-14T11:30:02.000000Z#0000000004#${OTHER}`;
    hlc.observe(remote);

    const mine = hlc.tick(undefined);
    expect(compareVersion(remote, mine)).toBe(-1);
    expect(parseVersion(mine)!.counter).toBe(5);
  });

  it('makes the next tick beat an observed bare instant', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const remote = '2026-09-14T11:30:02.000000Z';
    hlc.observe(remote);

    expect(compareVersion(remote, hlc.tick(undefined))).toBe(-1);
  });

  it('raises the counter for an observed token at the current instant', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    const first = hlc.tick(undefined);
    const remote = `${instantOf(first)}#0000000042#${OTHER}`;
    hlc.observe(remote);

    expect(compareVersion(remote, hlc.tick(undefined))).toBe(-1);
  });

  it('ignores an older token', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.tick(undefined);
    hlc.observe('2020-01-01T00:00:00.000000Z');

    expect(parseVersion(hlc.tick(undefined))!.counter).toBe(1);
  });

  it('makes the next tick beat an observed token past the cap, so an edit is never minted below its base', () => {
    // The server accepts up to server_now + 5 min, and a Status sample lags true time by its down-leg.
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0 - 300), 600);
    const base = `${iso(T0 + MAX_FUTURE_SKEW_MS - 100)}#0000000003#${OTHER}`;
    hlc.observe(base);

    expect(compareVersion(base, hlc.tick(undefined))).toBe(-1);
  });

  it('folds a far-future token unclamped: bounding feed tokens is the server\'s job', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.measure(iso(T0), 0);
    const token = `2099-01-01T00:00:00.000000Z#0000000001#${SERVER_DEVICE_ID}`;
    hlc.observe(token);

    expect(compareVersion(token, hlc.tick(undefined))).toBe(-1);
  });

  it('carries 1 us past the cap after a token at the cap with an exhausted counter, because order outranks the bound', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.measure(iso(T0), 0);
    const atCap = `${iso(T0 + MAX_FUTURE_SKEW_MS)}#${MAX_HLC_COUNTER}#${OTHER}`;
    hlc.observe(atCap);

    const next = hlc.tick(undefined);
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
    session1.tick(undefined);
    const snap = session1.snapshot();

    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock, state: snap, offsetMs: 0 });
    hlc.measure(iso(T0), 0);
    expect(instantOf(hlc.tick(undefined))).toBe('2026-09-15T11:30:00.000000Z'); // REJECTED version_future

    expect(hlc.rebase()).toBe(true);
    expect(instantOf(hlc.tick(undefined))).toBe('2026-09-14T11:30:00.000000Z');
  });

  it('recovers from an offline tick on a clock a year ahead, re-minting above the base', () => {
    const clock = new FakeClock(T0 + 365 * DAY);
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    expect(instantOf(hlc.tick(undefined))).toBe('2027-09-14T11:30:00.000000Z');

    hlc.measure(iso(T0), 0);
    hlc.rebase();
    const base = `${iso(T0 - 60_000)}#0000000002#${OTHER}`;
    const reminted = hlc.tick(base);

    expect(instantOf(reminted)).toBe('2026-09-14T11:30:00.000000Z');
    expect(compareVersion(base, reminted)).toBe(-1);
  });

  it('leaves a clock that is not ahead untouched', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    hlc.measure(iso(T0), 0);
    const before = hlc.tick(undefined);

    expect(hlc.rebase()).toBe(false);
    expect(compareVersion(before, hlc.tick(undefined))).toBe(-1);
  });

  it('needs a Status sample first', () => {
    expect(() => new Hlc({ deviceId: DEVICE, clock: new FakeClock() }).rebase()).toThrow(/Status/);
  });

  it('keeps an edit on another facet above that facet\'s version after a rebase lowered the clock', () => {
    const bound = (trueNow: number) => BigInt(trueNow + MAX_FUTURE_SKEW_MS) * 1000n;
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0), 0);
    clock.wall += 4 * 60_000; // a jump under the clamp: the edit on F is accepted
    const f1 = hlc.tick(undefined);
    expect(parseVersion(f1)!.micros <= bound(T0)).toBe(true);
    clock.wall += 2 * 60_000; // the anchor goes stale: the edit on G is REJECTED version_future
    expect(parseVersion(hlc.tick(undefined))!.micros > bound(T0)).toBe(true);

    hlc.measure(iso(T0), 0);
    expect(hlc.rebase()).toBe(true);
    const g = hlc.tick(undefined);
    clock.advance(60_000);
    const f2 = hlc.tick(f1); // one minute later the user edits F again

    expect(compareVersion(g, f1)).toBe(-1); // the rebase put the clock below F
    expect(compareVersion(f1, f2)).toBe(-1);
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
    const last = a.tick(undefined);
    a.tick(undefined);
    const snap = a.snapshot();
    clock.wall -= 60_000;

    const b = new Hlc({ deviceId: DEVICE, clock, state: snap, offsetMs: snap.offsetMs });
    expect(compareVersion(last, b.tick(undefined))).toBe(-1);
    expect(snap.counter).toBe(1);
    expect(snap.offsetMs).toBe(1_000);
  });

  it('defaults to the real clocks', () => {
    const before = Date.now();
    const hlc = new Hlc({ deviceId: DEVICE });
    const minted = parseVersion(hlc.tick(undefined))!;
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
  | { kind: 'tick'; facet: number; up: number; down: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'wallJump'; ms: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'measure'; up: number; down: number }
  | { kind: 'observe'; facet: number; ahead: number; counter: number; fold: boolean }
  | { kind: 'rebase' };

const FACETS = 3;
const facetA = fc.integer({ min: 0, max: FACETS - 1 });
const leg = fc.integer({ min: 1, max: 3_000 });
/** A down-leg may round to 0 ms; then a fresh cap has no slack below the server's bound. */
const downLeg = fc.integer({ min: 0, max: 3_000 });
/** Round-trip legs of up to ~7 min each way, often asymmetric (congested con Wi-Fi): the midpoint offset can be minutes off. */
const longLeg = fc.oneof(leg, fc.integer({ min: 1, max: 400_000 }));
const longDownLeg = fc.oneof(downLeg, fc.integer({ min: 0, max: 400_000 }));
/** Gaps just under the clamp, where the fresh-anchor cap decides whether a tick is accepted, and the clamp itself. */
const nearClamp = fc.oneof(fc.integer({ min: MAX_FUTURE_SKEW_MS - 200_000, max: MAX_FUTURE_SKEW_MS }), fc.constant(MAX_FUTURE_SKEW_MS));
const tickA = fc.record({ kind: fc.constant('tick' as const), facet: facetA, up: leg, down: downLeg });
const tickL = fc.record({ kind: fc.constant('tick' as const), facet: facetA, up: longLeg, down: longDownLeg });
const advanceA = fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 2 * HOUR }) });
const wallJumpA = fc.record({ kind: fc.constant('wallJump' as const), ms: fc.integer({ min: -2 * HOUR, max: 2 * HOUR }) });
const jumpNearA = fc.record({
  kind: fc.constant('wallJump' as const),
  ms: fc.oneof(nearClamp, nearClamp.map((ms) => -ms), fc.integer({ min: -2 * HOUR, max: 2 * HOUR })),
});
const sleepA = fc.record({ kind: fc.constant('sleep' as const), ms: fc.integer({ min: 0, max: DAY }) });
const sleepNearA = fc.record({ kind: fc.constant('sleep' as const), ms: fc.oneof(nearClamp, fc.integer({ min: 0, max: DAY })) });
const measureA = fc.record({ kind: fc.constant('measure' as const), up: leg, down: downLeg });
const measureL = fc.record({ kind: fc.constant('measure' as const), up: longLeg, down: longDownLeg });
const rebaseA = fc.constant({ kind: 'rebase' } as const);
const counterA = fc.integer({ min: 0, max: MAX_HLC_COUNTER });
/** Another device's write as the server accepted it (never past server_now + 5 min); the client may or may not fold it into its clock. */
const feedObserveA = fc.record({
  kind: fc.constant('observe' as const),
  facet: facetA,
  ahead: fc.integer({ min: -HOUR, max: MAX_FUTURE_SKEW_MS }),
  counter: counterA,
  fold: fc.boolean(),
});
/** Any canonical token at all, far future included. */
const anyObserveA = fc.record({
  kind: fc.constant('observe' as const),
  facet: facetA,
  ahead: fc.integer({ min: -DAY, max: 3650 * DAY }),
  counter: counterA,
  fold: fc.boolean(),
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
/** Each facet's version on the server at the start: absent, or another device's write accepted at T0. */
const heldA = fc.array(
  fc.option(fc.record({ ahead: fc.integer({ min: -DAY, max: MAX_FUTURE_SKEW_MS }), counter: counterA }), { nil: undefined }),
  { minLength: FACETS, maxLength: FACETS },
);

const clampMicros = BigInt(MAX_FUTURE_SKEW_MS) * 1000n;
const CAP_DECIDED_MIN = 100;
const token = (ms: number, counter: number, device = OTHER) => `${iso(ms)}#${String(counter).padStart(10, '0')}#${device}`;
const micros = (v: string) => parseVersion(v)!.micros;

class World {
  truth = T0; // the server's clock, which is true time
  readonly clock: FakeClock;
  readonly hlc: Hlc;
  lastRtt = 0;
  private sample: { truth: number; wall: number; mono: number } | undefined;

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
    this.sample = { truth: sampled, wall: this.clock.wall, mono: this.clock.mono };
  }

  remote(ahead: number, counter: number) { return token(this.truth + ahead, counter); }

  /** The server's version_future bound right now. */
  bound() { return BigInt(this.truth) * 1000n + clampMicros; }

  /** The Status sample plus the monotonic time since it: a lower bound on the server's clock. */
  floor() { return BigInt(this.sample!.truth + this.clock.mono - this.sample!.mono) * 1000n; }

  /** The Hlc's wall plus offset, before any cap or floor. */
  estimate() { return BigInt(Math.floor((this.clock.wall + this.hlc.offsetMs) * 1000)); }

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

const above = (floor: string | undefined, v: string) => floor === undefined || compareVersion(floor, v) === -1;
const max = (a: string | undefined, b: string) => (above(a, b) ? b : a);

describe('Hlc properties', () => {
  it('orders every tick above its base and, since the last rebase, above every earlier tick and observed token, from any restored state', () => {
    fc.assert(
      fc.property(
        restoredState,
        restoredOffset,
        drift,
        fc.array(fc.oneof(tickA, tickA, advanceA, wallJumpA, sleepA, measureA, anyObserveA, rebaseA), { maxLength: 60, size: 'max' }),
        (state, offsetMs, d, actions) => {
          const w = new World(d, state, offsetMs);
          const local: (string | undefined)[] = new Array(FACETS).fill(undefined);
          let floor: string | undefined;
          for (const a of actions) {
            if (a.kind === 'tick') {
              const v = w.hlc.tick(local[a.facet]);
              if (!above(floor, v) || !above(local[a.facet], v)) return false;
              floor = local[a.facet] = v;
            } else if (a.kind === 'observe') {
              // A Delta event lands in the facet; folding it into the clock is optional.
              const t = w.remote(a.ahead, a.counter);
              local[a.facet] = max(local[a.facet], t);
              if (a.fold) { w.hlc.observe(t); floor = max(floor, t); }
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

  it('once anchored and rebased: a fresh tick is never rejected, one rebase recovers any rejection, and an edit on any facet lands above that facet\'s version', () => {
    let capDecided = 0;
    fc.assert(
      fc.property(
        restoredState,
        restoredOffset,
        drift,
        heldA,
        fc.array(fc.oneof(tickL, advanceA, jumpNearA, sleepNearA), { maxLength: 10, size: 'max' }),
        longLeg,
        longDownLeg,
        fc.array(fc.oneof(tickL, tickL, advanceA, jumpNearA, sleepNearA, measureL, feedObserveA), { minLength: 1, maxLength: 60, size: 'max' }),
        (state, offsetMs, d, held, offline, up0, down0, online) => {
          const w = new World(d, state, offsetMs);
          // Each facet's version on the server, and on the client (they differ only by an unpushed offline edit).
          const server = held.map((h) => (h === undefined ? undefined : token(T0 + h.ahead, h.counter)));
          const local = [...server];
          const pending = new Map<number, { up: number; down: number }>();
          // The highest instant minted or restored before the first Status: only it can
          // push a fresh tick past the bound, and only while it is itself past it.
          let poison = state?.micros;

          for (const a of offline) {
            if (a.kind === 'tick') {
              const v = w.hlc.tick(local[a.facet]);
              if (!above(local[a.facet], v)) return false;
              local[a.facet] = v;
              pending.set(a.facet, a);
              if (poison === undefined || micros(v) > poison) poison = micros(v);
            } else {
              w.move(a);
            }
          }

          w.measure(up0, down0); // sign-in always passes a Status probe first
          const accepted = (v: string) => micros(v) <= w.bound();
          // An exhausted counter carries 1 us past a token at the bound; nothing else lands there.
          const carried = (v: string) => micros(v) === w.bound() + 1n && parseVersion(v)!.counter === 0;
          // REJECTED version_future: fresh Status, rebase, adopt `current`, re-mint on it.
          const recover = (f: number, up: number, down: number) => {
            w.measure(up, down);
            w.hlc.rebase();
            poison = undefined;
            local[f] = server[f];
            const v = w.hlc.tick(local[f]);
            if (!accepted(v) || !above(server[f], v)) return false;
            server[f] = local[f] = v;
            return true;
          };

          for (const [f, legs] of pending) {
            if (accepted(local[f]!)) server[f] = local[f];
            else if (!recover(f, legs.up, legs.down)) return false;
          }

          for (const a of online) {
            if (a.kind === 'tick') {
              const fresh = w.fresh();
              const poisoned = poison !== undefined && poison > w.bound();
              if (fresh && !poisoned && w.estimate() > w.bound()) capDecided++;
              const v = w.hlc.tick(local[a.facet]);
              if (!above(local[a.facet], v)) return false; // STALE: the edit lost to its own base
              if (accepted(v)) {
                server[a.facet] = local[a.facet] = v;
              } else {
                if (fresh && !poisoned && !carried(v)) return false;
                if (!recover(a.facet, a.up, a.down)) return false;
              }
            } else if (a.kind === 'observe') {
              // Another device's write: the server keeps it only above its own version.
              const t = w.remote(a.ahead, a.counter);
              if (above(server[a.facet], t)) {
                server[a.facet] = local[a.facet] = t;
                if (a.fold) w.hlc.observe(t);
              }
            } else {
              w.move(a);
            }
          }
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
    // Not vacuous: in some ticks only the cap kept a fresh anchor's tick inside the bound.
    expect(capDecided).toBeGreaterThan(CAP_DECIDED_MIN);
  });

  it('once anchored, never mints below the Status sample plus the monotonic time since it, whatever the wall clock does', () => {
    fc.assert(
      fc.property(
        restoredState,
        restoredOffset,
        drift,
        longLeg,
        longDownLeg,
        fc.array(fc.oneof(tickA, tickA, advanceA, wallJumpA, jumpNearA, sleepNearA, measureL, feedObserveA, rebaseA), { minLength: 1, maxLength: 60, size: 'max' }),
        (state, offsetMs, d, up, down, actions) => {
          const w = new World(d, state, offsetMs);
          w.measure(up, down);
          for (const a of actions) {
            if (a.kind === 'tick') {
              if (micros(w.hlc.tick(undefined)) < w.floor()) return false;
            } else if (a.kind === 'observe') {
              w.hlc.observe(w.remote(a.ahead, a.counter));
            } else if (a.kind === 'rebase') {
              w.hlc.rebase();
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
        downLeg,
        fc.array(fc.oneof(tickA, tickA, advanceA, sleepA, measureA, feedObserveA), { minLength: 1, maxLength: 60, size: 'max' }),
        (d, up, down, actions) => {
          const w = new World(d);
          w.measure(up, down);
          for (const a of actions) {
            if (a.kind === 'tick') {
              if (micros(w.hlc.tick(undefined)) < BigInt(w.truth - w.lastRtt) * 1000n) return false;
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
