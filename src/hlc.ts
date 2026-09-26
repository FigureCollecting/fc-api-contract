// A hybrid logical clock that mints SyncEvent.version tokens (sync.proto rule 5).
// Invariants: every tick is strictly greater than the previous one and than
// every token observed since the last rebase. Once anchored and rebased, a
// tick passes true server-now plus the clamp only while the anchor is stale
// (a sleep or a forward wall jump), or by 1 us when an exhausted counter
// carries; the server's version_future check plus rebase() recovers either.
import {
  MAX_FUTURE_SKEW_MS,
  MAX_HLC_COUNTER,
  VersionError,
  instantToMicros,
  microsToInstant,
  normaliseDeviceId,
  parseVersion,
} from './version.js';

export interface HlcClock {
  /** Wall-clock milliseconds since the epoch (Date.now). May jump either way. */
  wallMs(): number;
  /** Monotonic milliseconds (performance.now). Never jumps; may stall while the device sleeps. */
  monoMs(): number;
}

export interface HlcState {
  /** Microseconds of the last token issued or observed. */
  micros: bigint;
  counter: number;
}

export interface HlcOptions {
  deviceId: string;
  clock?: HlcClock;
  /**
   * How far past the server's clock a fresh tick may run, and how far the wall may
   * run ahead of monotonic time before the anchor goes stale. Defaults to MAX_FUTURE_SKEW_MS.
   */
  clampMs?: number;
  /** Restored from storage so ticks stay monotonic across reloads. */
  state?: HlcState;
  /** The last measured server offset, restored from storage. */
  offsetMs?: number;
}

const systemClock: HlcClock = {
  wallMs: () => Date.now(),
  monoMs: () => performance.now(),
};

const toMicros = (ms: number): bigint => BigInt(Math.floor(ms * 1000));

export class Hlc {
  readonly deviceId: string;
  private readonly clock: HlcClock;
  private readonly clampMs: number;
  private readonly clampMicros: bigint;
  private micros: bigint;
  private counter: number;
  private offset: number;
  // The latest server sample and the wall and monotonic readings when it
  // arrived. The sample is a LOWER bound on the server's clock at arrival, so
  // the cap it yields never exceeds true server-now plus the clamp.
  private anchor: { serverMicros: bigint; wallMs: number; monoMs: number } | undefined;

  constructor(opts: HlcOptions) {
    this.deviceId = normaliseDeviceId(opts.deviceId);
    this.clock = opts.clock ?? systemClock;
    const clampMs = opts.clampMs ?? MAX_FUTURE_SKEW_MS;
    if (!Number.isFinite(clampMs) || clampMs < 0) throw new RangeError(`clampMs must be >= 0: ${clampMs}`);
    this.clampMs = clampMs;
    this.clampMicros = toMicros(clampMs);
    this.micros = opts.state?.micros ?? 0n;
    this.counter = opts.state?.counter ?? 0;
    this.offset = opts.offsetMs ?? 0;
  }

  /** The measured server offset in ms (server minus wall). */
  get offsetMs(): number {
    return this.offset;
  }

  /** Whether a Status sample has been taken in this session. Unanchored ticks are not clamped. */
  get anchored(): boolean {
    return this.anchor !== undefined;
  }

  /**
   * Anchored, and since the sample the wall clock has not run ahead of
   * monotonic time by more than the clamp. Only a fresh anchor caps ticks.
   */
  get fresh(): boolean {
    return this.anchor !== undefined && this.forwardGapMs(this.anchor, this.clock.wallMs()) <= this.clampMs;
  }

  /**
   * Record a Status sample. Call it as the response arrives, with the round
   * trip measured on a monotonic clock; the offset is taken at the midpoint.
   */
  measure(serverNowIso: string, rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) throw new RangeError(`rttMs must be >= 0: ${rttMs}`);
    const serverMicros = instantToMicros(serverNowIso);
    const wall = this.clock.wallMs();
    this.offset = Number(serverMicros / 1000n) + rttMs / 2 - wall;
    this.anchor = { serverMicros, wallMs: wall, monoMs: this.clock.monoMs() };
  }

  /** Mint the version for a local write. */
  tick(): string {
    const physical = this.physical();
    if (physical > this.micros) {
      this.micros = physical;
      this.counter = 0;
    } else if (this.counter === MAX_HLC_COUNTER) {
      this.micros += 1n;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return this.format();
  }

  /**
   * Fold in a token seen from elsewhere (a Delta event, a base version) so the
   * next tick beats it. Never clamped: the server bounds every token on the
   * feed, and clamping here would mint an edit below its base.
   */
  observe(version: string): void {
    const parsed = parseVersion(version);
    if (parsed === undefined) throw new VersionError(`not a canonical version: ${JSON.stringify(version)}`);
    const { micros } = parsed;
    const counter = parsed.counter ?? 0;
    if (micros > this.micros) {
      this.micros = micros;
      this.counter = counter;
    } else if (micros === this.micros && counter > this.counter) {
      this.counter = counter;
    }
  }

  /**
   * Drop whatever the clock holds beyond the anchored present: tokens minted
   * or observed while a clock ran ahead. After a Push is REJECTED
   * version_future, take a fresh Status (measure), rebase, re-observe each
   * pending edit's base version, then re-mint it. Returns whether the state moved.
   */
  rebase(): boolean {
    if (this.anchor === undefined) throw new Error('rebase needs a Status sample: call measure() first');
    const now = this.physical();
    if (this.micros <= now) return false;
    this.micros = now;
    this.counter = 0;
    return true;
  }

  /** State to persist (sync_meta) so a reload continues monotonically. */
  snapshot(): HlcState & { offsetMs: number } {
    return { micros: this.micros, counter: this.counter, offsetMs: this.offset };
  }

  // Wall plus offset, capped at sample + elapsed monotonic time + clamp while
  // the anchor is fresh. A larger forward gap is a sleep (monotonic time
  // stalls) or a wall jump; two clocks cannot tell which, so trust the wall.
  private physical(): bigint {
    const wall = this.clock.wallMs();
    const estimate = toMicros(wall + this.offset);
    const a = this.anchor;
    if (a === undefined || this.forwardGapMs(a, wall) > this.clampMs) return estimate;
    const cap = a.serverMicros + toMicros(this.clock.monoMs() - a.monoMs) + this.clampMicros;
    return estimate > cap ? cap : estimate;
  }

  private forwardGapMs(a: { wallMs: number; monoMs: number }, wall: number): number {
    return wall - a.wallMs - (this.clock.monoMs() - a.monoMs);
  }

  private format(): string {
    return `${microsToInstant(this.micros)}#${String(this.counter).padStart(10, '0')}#${this.deviceId}`;
  }
}
