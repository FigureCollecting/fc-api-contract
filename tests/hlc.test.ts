import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Hlc, MAX_FUTURE_SKEW_MS, VersionError, compareVersion, parseVersion } from '../src/index.js';
import { microsToInstant } from '../src/version.js';

const DEVICE = '0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
const OTHER = '9c1e3a5b7d9f1b3d5f7a9c1e3b5d7f9a';
const T0 = Date.parse('2026-09-14T11:30:00.000Z');

/** A clock the test drives: `wall` is what Date.now would say, `mono` what performance.now would. */
class FakeClock {
  wall: number;
  mono = 1_000;
  constructor(wall = T0) { this.wall = wall; }
  wallMs = () => this.wall;
  monoMs = () => this.mono;
  advance(ms: number) { this.wall += ms; this.mono += ms; }
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

  it('clamps to the server sample plus elapsed monotonic time plus the clamp after a forward wall jump', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock, clampMs: 60_000 });
    hlc.measure(iso(T0), 0);
    clock.wall += 86_400_000; // the device clock is set a day ahead; mono does not move

    expect(instantOf(hlc.tick())).toBe('2026-09-14T11:31:00.000000Z');
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

  it('never adopts a token past the clamp, so one bad clock cannot drag every device forward', () => {
    const clock = new FakeClock();
    const hlc = new Hlc({ deviceId: DEVICE, clock });
    hlc.measure(iso(T0), 0);
    hlc.observe(`2027-01-01T00:00:00.000000Z#0000000000#${OTHER}`);

    const limit = iso(T0 + MAX_FUTURE_SKEW_MS);
    expect(compareVersion(instantOf(hlc.tick()), limit)).toBe(0);
  });

  it('throws on a token that is not canonical', () => {
    const hlc = new Hlc({ deviceId: DEVICE, clock: new FakeClock() });
    expect(() => hlc.observe('2026-09-14T11:30:00Z')).toThrow(VersionError);
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
// The property. A model of real time drives three clocks: the server's (truth),
// the device wall clock (drifts and jumps both ways) and the device monotonic
// clock (never jumps; may stall while the device sleeps). Every tick must be
// strictly greater than the last and never past true server-now plus the clamp.
// ---------------------------------------------------------------------------
type Action =
  | { kind: 'tick' }
  | { kind: 'advance'; ms: number }
  | { kind: 'wallJump'; ms: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'measure'; up: number; down: number }
  | { kind: 'observe'; ahead: number; counter: number };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ kind: 'tick' } as const) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 5_000 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('wallJump' as const), ms: fc.integer({ min: -7_200_000, max: 7_200_000 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('sleep' as const), ms: fc.integer({ min: 0, max: 600_000 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('measure' as const), up: fc.integer({ min: 0, max: 3_000 }), down: fc.integer({ min: 0, max: 3_000 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('observe' as const), ahead: fc.integer({ min: -3_600_000, max: MAX_FUTURE_SKEW_MS }), counter: fc.integer({ min: 0, max: 9_999_999_999 }) }) },
);

describe('Hlc property', () => {
  it('ticks strictly monotonically and never past server-now plus the clamp, over 10,000 runs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -86_400_000, max: 86_400_000 }), // initial device clock error
        fc.array(action, { minLength: 1, maxLength: 60 }),
        (initialDrift, actions) => {
          let server = T0; // true time, which is also the server's clock
          const clock = new FakeClock(T0 + initialDrift);
          const hlc = new Hlc({ deviceId: DEVICE, clock });
          const clampMicros = BigInt(MAX_FUTURE_SKEW_MS) * 1000n;

          // Sign-in always passes a Status probe first, so a session starts anchored.
          const measure = (up: number, down: number) => {
            server += up; clock.advance(up);
            const sampled = server;
            server += down; clock.advance(down);
            hlc.measure(iso(sampled), up + down);
          };
          measure(20, 20);

          let last: string | undefined;
          for (const a of actions) {
            switch (a.kind) {
              case 'advance': server += a.ms; clock.advance(a.ms); break;
              case 'wallJump': clock.wall += a.ms; break;
              case 'sleep': server += a.ms; clock.wall += a.ms; break; // mono stalls
              case 'measure': measure(a.up, a.down); break;
              case 'observe': {
                const remote = `${iso(server + a.ahead)}#${String(a.counter).padStart(10, '0')}#${OTHER}`;
                hlc.observe(remote);
                break;
              }
              case 'tick': {
                const v = hlc.tick();
                if (last !== undefined && compareVersion(last, v) !== -1) return false;
                if (parseVersion(v)!.micros > BigInt(server) * 1000n + clampMicros) return false;
                last = v;
                break;
              }
            }
          }
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
