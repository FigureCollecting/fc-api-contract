// A hybrid logical clock that mints SyncEvent.version tokens (sync.proto rule 5).
// Invariants: every tick is strictly greater than the previous one and than
// every observed token; once anchored by a Status sample, no tick or observed
// token moves the clock past server-now plus the clamp.
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
  /** How far past the server's clock a token may run. Defaults to MAX_FUTURE_SKEW_MS. */
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
  private readonly clampMicros: bigint;
  private micros: bigint;
  private counter: number;
  private offset: number;
  // The latest server sample and the monotonic reading when it arrived. The
  // sample is a LOWER bound on the server's clock at arrival, so the cap it
  // yields never exceeds true server-now plus the clamp.
  private anchor: { serverMicros: bigint; monoMs: number } | undefined;

  constructor(opts: HlcOptions) {
    this.deviceId = normaliseDeviceId(opts.deviceId);
    this.clock = opts.clock ?? systemClock;
    const clampMs = opts.clampMs ?? MAX_FUTURE_SKEW_MS;
    if (!Number.isFinite(clampMs) || clampMs < 0) throw new RangeError(`clampMs must be >= 0: ${clampMs}`);
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
   * Record a Status sample. Call it as the response arrives, with the round
   * trip measured on a monotonic clock; the offset is taken at the midpoint.
   */
  measure(serverNowIso: string, rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) throw new RangeError(`rttMs must be >= 0: ${rttMs}`);
    const serverMicros = instantToMicros(serverNowIso);
    const wall = this.clock.wallMs();
    this.offset = Number(serverMicros / 1000n) + rttMs / 2 - wall;
    this.anchor = { serverMicros, monoMs: this.clock.monoMs() };
  }

  /** Mint the version for a local write. */
  tick(): string {
    let physical = toMicros(this.clock.wallMs() + this.offset);
    const cap = this.cap();
    if (cap !== undefined && physical > cap) physical = cap;
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

  /** Fold in a token seen from elsewhere (a Delta event, a base version) so the next tick beats it. */
  observe(version: string): void {
    const parsed = parseVersion(version);
    if (parsed === undefined) throw new VersionError(`not a canonical version: ${JSON.stringify(version)}`);
    let micros = parsed.micros;
    let counter = parsed.counter ?? 0;
    const cap = this.cap();
    if (cap !== undefined && micros >= cap) {
      micros = cap;
      counter = 0;
    }
    if (micros > this.micros) {
      this.micros = micros;
      this.counter = counter;
    } else if (micros === this.micros && counter > this.counter) {
      this.counter = counter;
    }
  }

  /** State to persist (sync_meta) so a reload continues monotonically. */
  snapshot(): HlcState & { offsetMs: number } {
    return { micros: this.micros, counter: this.counter, offsetMs: this.offset };
  }

  private cap(): bigint | undefined {
    if (this.anchor === undefined) return undefined;
    return this.anchor.serverMicros + toMicros(this.clock.monoMs() - this.anchor.monoMs) + this.clampMicros;
  }

  private format(): string {
    return `${microsToInstant(this.micros)}#${String(this.counter).padStart(10, '0')}#${this.deviceId}`;
  }
}
