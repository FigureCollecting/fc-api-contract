// Mints SyncEvent.version tokens: a tick beats its base and every tick and token since the last rebase,
// and once anchored is >= sample + monotonic elapsed. The bound and its assumptions: sync.proto rule 5.
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
   * run ahead of monotonic time before the anchor goes stale. Must equal MAX_FUTURE_SKEW_MS:
   * a smaller clamp lets the server APPLY ticks past the bound, a larger one lets a fresh
   * tick be REJECTED. An option only so a server skew change stays one constant.
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
  // arrived. The sample is a LOWER bound on the server's clock at arrival, so,
  // assuming monotonic time keeps server rate, the cap it yields never exceeds
  // true server-now plus the clamp.
  private anchor: { serverMicros: bigint; wallMs: number; monoMs: number } | undefined;

  constructor(opts: HlcOptions) {
    this.deviceId = normaliseDeviceId(opts.deviceId);
    this.clock = opts.clock ?? systemClock;
    const clampMs = opts.clampMs ?? MAX_FUTURE_SKEW_MS;
    if (clampMs !== MAX_FUTURE_SKEW_MS) {
      throw new RangeError(
        `clampMs must equal MAX_FUTURE_SKEW_MS (${MAX_FUTURE_SKEW_MS}), the server's version_future skew: ${clampMs}`,
      );
    }
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

  /**
   * Mint the version for a local write on a facet whose current local version
   * is `base` (undefined when the client holds none). Required, because after
   * rebase() only the base keeps the edit above what the client already holds.
   */
  tick(base: string | undefined): string {
    if (arguments.length === 0) throw new TypeError("tick needs the facet's local version: pass undefined when there is none");
    if (base !== undefined) this.observe(base);
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
   * Fold in a token seen from elsewhere (a Delta event) so the next tick
   * beats it. Never clamped: clamping here would mint an edit below its base.
   * Every version the server emits, in Delta or as `current`, is at most
   * server_now + 5 minutes when emitted: a pushed one by the check order, and
   * every server write, the import and server-owned facets included, at most
   * server_now. The Hlc folds tokens unclamped, so the bound depends on this.
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
   * or observed while a clock ran ahead. Call it after each session's first
   * Status (a no-op when the clock is not ahead). After a Push is REJECTED
   * version_future, take a fresh Status (measure), rebase, adopt `current`,
   * then re-mint with tick(base). After any rebase, re-mint every unpushed
   * edit past the new present (above snapshot()), on its facet's server
   * version with tick(base); a later edit on that facet takes the re-minted
   * version as its base. An edit pushed but not yet answered is not
   * re-minted in place: its retry carries the same client_id, and it is
   * re-minted only if that answer is REJECTED. Until it
   * is answered, later ticks on that facet, and through the clock every later
   * tick, may pass the bound (server-now + clamp), which holds while fresh and
   * every earlier edit minted past the bound has been answered, or re-minted
   * after a rebase if unpushed, and re-minted if REJECTED version_future or
   * dropped, after a rebase if past the fresh Status sample, for any other
   * code.
   * Returns whether the state moved.
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

  // Wall plus offset, floored at sample + elapsed monotonic time (a lower bound on server time whatever
  // the wall does, assuming monotonic time keeps server rate) and capped at floor + clamp while the
  // anchor is fresh. A larger forward gap is a sleep or a wall jump; trust the wall.
  private physical(): bigint {
    const wall = this.clock.wallMs();
    const estimate = toMicros(wall + this.offset);
    const a = this.anchor;
    if (a === undefined) return estimate;
    const floor = a.serverMicros + toMicros(this.clock.monoMs() - a.monoMs);
    if (estimate < floor) return floor;
    if (this.forwardGapMs(a, wall) > this.clampMs) return estimate;
    const cap = floor + this.clampMicros;
    return estimate > cap ? cap : estimate;
  }

  private forwardGapMs(a: { wallMs: number; monoMs: number }, wall: number): number {
    return wall - a.wallMs - (this.clock.monoMs() - a.monoMs);
  }

  private format(): string {
    return `${microsToInstant(this.micros)}#${String(this.counter).padStart(10, '0')}#${this.deviceId}`;
  }
}
