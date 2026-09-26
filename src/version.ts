// The SyncEvent.version grammar (sync.proto rule 5) and its one comparator.
// Every segment is fixed-width ASCII, so for a token that parses, bytewise
// order IS version order; compareVersion refuses anything that does not parse.

/** The device id the server writes user facets under (the MFC import). Sorts below every real device. */
export const SERVER_DEVICE_ID = '00000000000000000000000000000000';

/** A pushed version whose instant is later than server_now plus this is REJECTED (version_future). */
export const MAX_FUTURE_SKEW_MS = 300_000;

/** The largest value the 10-digit counter segment can hold. */
export const MAX_HLC_COUNTER = 9_999_999_999;

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionError';
  }
}

export interface ParsedVersion {
  /** The canonical instant segment. */
  instant: string;
  /** Microseconds since the epoch. */
  micros: bigint;
  /** null for a bare instant. */
  counter: number | null;
  /** 32 lowercase hex; null for a bare instant. */
  deviceId: string | null;
}

const VERSION_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z(?:#(\d{10})#([0-9a-f]{32}))?$/;

// Lenient input for canonicalInstant: ISO-8601 or PostgreSQL's text output,
// any offset up to ±18:00, 0 to 6 fractional digits.
const LOOSE_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

const DEVICE_RE = /^[0-9a-f]{32}$/;
const DASHED_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
};

/** Epoch micros for calendar fields, or undefined when the fields name no real instant. */
function fieldsToMicros(y: number, mo: number, d: number, h: number, mi: number, s: number, frac: string): bigint | undefined {
  if (h > 23 || mi > 59 || s > 59) return undefined;
  // setUTCFullYear, not Date.UTC: the latter maps years 0-99 to 1900-1999.
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return BigInt(dt.getTime()) * 1000n + BigInt(frac.padEnd(6, '0'));
}

/** Render epoch micros as a canonical instant. */
export function microsToInstant(micros: bigint): string {
  const ms = floorDiv(micros, 1000n);
  const sub = micros - ms * 1000n;
  const d = new Date(Number(ms));
  const year = d.getUTCFullYear();
  if (Number.isNaN(year) || year < 0 || year > 9999) {
    throw new VersionError(`instant out of range: ${micros} micros`);
  }
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(year, 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.` +
    `${p(d.getUTCMilliseconds(), 3)}${String(sub).padStart(3, '0')}Z`
  );
}

/** Epoch micros of a canonical instant. */
export function instantToMicros(instant: string): bigint {
  const parsed = parseVersion(instant);
  if (parsed === undefined || parsed.counter !== null) {
    throw new VersionError(`not a canonical instant: ${JSON.stringify(instant)}`);
  }
  return parsed.micros;
}

/** Parse a version token strictly; undefined when it is not in the grammar. */
export function parseVersion(version: string): ParsedVersion | undefined {
  const m = VERSION_RE.exec(version);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s, frac, counter, device] = m as unknown as string[];
  const micros = fieldsToMicros(+y!, +mo!, +d!, +h!, +mi!, +s!, frac!);
  if (micros === undefined) return undefined;
  return {
    instant: version.slice(0, 27),
    micros,
    counter: counter === undefined ? null : Number(counter),
    deviceId: device ?? null,
  };
}

export function isCanonicalVersion(version: string): boolean {
  return parseVersion(version) !== undefined;
}

/**
 * Order two version tokens: -1, 0 or 1. Throws VersionError when either is
 * not in the grammar, so an unvalidated token can never be ordered by accident.
 */
export function compareVersion(a: string, b: string): -1 | 0 | 1 {
  for (const v of [a, b]) {
    if (!isCanonicalVersion(v)) throw new VersionError(`not a canonical version: ${JSON.stringify(v)}`);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold an instant to the canonical form: UTC, trailing Z, six fractional
 * digits. Accepts ISO-8601 or PostgreSQL text with any offset and up to six
 * fractional digits; more would lose precision and is refused.
 */
export function canonicalInstant(input: string | Date): string {
  if (input instanceof Date) {
    const ms = input.getTime();
    if (Number.isNaN(ms)) throw new VersionError('invalid Date');
    return microsToInstant(BigInt(ms) * 1000n);
  }
  const m = LOOSE_INSTANT_RE.exec(input);
  const micros = m === null ? undefined : fieldsToMicros(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7] ?? '');
  if (m === null || micros === undefined) {
    throw new VersionError(`not an ISO-8601 instant: ${JSON.stringify(input)}`);
  }
  const zone = m[8]!;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (om > 59 || oh * 60 + om > 18 * 60) throw new VersionError(`bad offset in ${JSON.stringify(input)}`);
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return microsToInstant(micros - BigInt(offsetMinutes) * 60_000_000n);
}

/** Fold a device uuid (dashed or not, any case) to the 32-lowercase-hex spelling the grammar uses. */
export function normaliseDeviceId(id: string): string {
  const lower = id.toLowerCase();
  if (DEVICE_RE.test(lower)) return lower;
  if (DASHED_UUID_RE.test(lower)) return lower.replaceAll('-', '');
  throw new VersionError(`not a device uuid: ${JSON.stringify(id)}`);
}

/** Build a full HLC token from its parts, normalising the instant and the device id. */
export function canonicalVersion(parts: { instant: string | Date; counter: number; deviceId: string }): string {
  const { counter } = parts;
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_HLC_COUNTER) {
    throw new VersionError(`counter must be a whole number 0..${MAX_HLC_COUNTER}: ${counter}`);
  }
  return `${canonicalInstant(parts.instant)}#${String(counter).padStart(10, '0')}#${normaliseDeviceId(parts.deviceId)}`;
}
