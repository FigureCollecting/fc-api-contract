import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_FUTURE_SKEW_MS,
  SERVER_DEVICE_ID,
  VersionError,
  canonicalInstant,
  canonicalVersion,
  compareVersion,
  isCanonicalVersion,
  normaliseDeviceId,
  parseVersion,
} from '../src/index.js';
import { instantToMicros, microsToInstant } from '../src/version.js';

interface Vectors {
  serverDeviceId: string;
  valid: Array<{ version: string; instant: string; micros: string; counter: number | null; deviceId: string | null }>;
  invalid: Array<{ version: string; note: string }>;
  order: Array<{ a: string; b: string; cmp: -1 | 0 | 1; note: string }>;
  sorted: string[];
  canonicalInstant: Array<{ input: string; output?: string; error?: boolean; note: string }>;
  canonicalVersion: Array<{ instant: string; counter: number; deviceId: string; output?: string; error?: boolean; note: string }>;
  collationTraps: Array<{ a: string; b: string; bytewise: -1 | 1; glibcEnUs: -1 | 1; icuEnUs: -1 | 1; note: string }>;
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/version-vectors.json', import.meta.url)), 'utf8'),
) as Vectors;

describe('golden vectors', () => {
  it('carry at least 30 cases', () => {
    const total =
      vectors.valid.length +
      vectors.invalid.length +
      vectors.order.length +
      vectors.canonicalInstant.length +
      vectors.canonicalVersion.length;
    expect(total).toBeGreaterThanOrEqual(30);
  });

  it('name the reserved server device the helpers export', () => {
    expect(vectors.serverDeviceId).toBe(SERVER_DEVICE_ID);
    expect(SERVER_DEVICE_ID).toBe('0'.repeat(32));
  });

  it.each(vectors.valid)('parses $version', ({ version, instant, micros, counter, deviceId }) => {
    expect(isCanonicalVersion(version)).toBe(true);
    expect(parseVersion(version)).toEqual({ instant, micros: BigInt(micros), counter, deviceId });
  });

  it.each(vectors.invalid)('rejects "$version" ($note)', ({ version }) => {
    expect(isCanonicalVersion(version)).toBe(false);
    expect(parseVersion(version)).toBeUndefined();
    expect(() => compareVersion(version, vectors.valid[0]!.version)).toThrow(VersionError);
    expect(() => compareVersion(vectors.valid[0]!.version, version)).toThrow(VersionError);
  });

  it.each(vectors.order)('orders $note', ({ a, b, cmp }) => {
    expect(compareVersion(a, b)).toBe(cmp);
    expect(compareVersion(b, a)).toBe(-cmp || 0);
  });

  it('gives a total order: sorting any permutation reproduces the golden sequence', () => {
    const n = vectors.sorted.length;
    fc.assert(
      fc.property(fc.shuffledSubarray(vectors.sorted, { minLength: n, maxLength: n }), (shuffled) => {
        expect([...shuffled].sort(compareVersion)).toEqual(vectors.sorted);
      }),
      { numRuns: 1_000 },
    );
  });

  it('agrees with bytewise order on every pair of valid tokens, which is what a C-collation column does', () => {
    const all = [...vectors.sorted, ...vectors.valid.map((v) => v.version)];
    const bytes = (s: string) => Buffer.from(s, 'utf8');
    for (const a of all) {
      for (const b of all) {
        expect(compareVersion(a, b)).toBe(Math.sign(Buffer.compare(bytes(a), bytes(b))));
      }
    }
  });

  it('agrees with ICU en-US on every pair of valid tokens: the grammar is collation-invariant', () => {
    const all = [...vectors.sorted, ...vectors.valid.map((v) => v.version)];
    for (const a of all) {
      for (const b of all) {
        expect(Math.sign(a.localeCompare(b, 'en-US'))).toBe(compareVersion(a, b));
      }
    }
  });

  it.each(vectors.collationTraps)('names a pair a locale collation misorders: $note', ({ a, b, bytewise, icuEnUs, glibcEnUs }) => {
    expect(isCanonicalVersion(a)).toBe(true);
    expect(isCanonicalVersion(b)).toBe(false);
    expect(() => compareVersion(a, b)).toThrow(VersionError);
    expect(Math.sign(Buffer.compare(Buffer.from(a), Buffer.from(b)))).toBe(bytewise);
    expect(Math.sign(a.localeCompare(b, 'en-US'))).toBe(icuEnUs);
    expect(bytewise === glibcEnUs && bytewise === icuEnUs).toBe(false);
  });

  it.each(vectors.canonicalInstant)('canonicalInstant("$input") ($note)', ({ input, output, error }) => {
    if (error) {
      expect(() => canonicalInstant(input)).toThrow(VersionError);
    } else {
      expect(canonicalInstant(input)).toBe(output);
    }
  });

  it.each(vectors.canonicalVersion)('canonicalVersion ($note)', ({ instant, counter, deviceId, output, error }) => {
    if (error) {
      expect(() => canonicalVersion({ instant, counter, deviceId })).toThrow(VersionError);
    } else {
      expect(canonicalVersion({ instant, counter, deviceId })).toBe(output);
      expect(isCanonicalVersion(output!)).toBe(true);
    }
  });
});

describe('canonicalInstant', () => {
  it('renders a Date at microsecond width', () => {
    expect(canonicalInstant(new Date('2026-09-14T11:30:00.123Z'))).toBe('2026-09-14T11:30:00.123000Z');
  });

  it('rejects an invalid Date and a year outside four digits after folding the offset', () => {
    expect(() => canonicalInstant(new Date(Number.NaN))).toThrow(VersionError);
    expect(() => canonicalInstant('0000-01-01T00:30:00+01:00')).toThrow(VersionError);
  });

  it('rejects an offset with minutes past 59', () => {
    expect(() => canonicalInstant('2026-09-14T11:30:00+09:60')).toThrow(VersionError);
  });

  it('rejects an offset past 18 hours', () => {
    expect(() => canonicalInstant('2026-09-14T11:30:00+99:00')).toThrow(VersionError);
    expect(() => canonicalInstant('2026-09-14T11:30:00-18:01')).toThrow(VersionError);
    expect(canonicalInstant('2026-09-14T11:30:00-18:00')).toBe('2026-09-15T05:30:00.000000Z');
  });
});

describe('normaliseDeviceId', () => {
  it('folds a dashed or uppercase uuid to 32 lowercase hex', () => {
    expect(normaliseDeviceId('0F3A5C7E-9B1D-2F4A-6C8E-0B2D4F6A8C0E')).toBe('0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e');
    expect(normaliseDeviceId('0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e')).toBe('0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e');
  });

  it('rejects anything that is not a uuid', () => {
    expect(() => normaliseDeviceId('0f3a5c7e-9b1d2f4a6c8e0b2d4f6a8c0e')).toThrow(VersionError);
    expect(() => normaliseDeviceId('')).toThrow(VersionError);
  });
});

describe('micros conversions', () => {
  it('round-trip, including before the epoch', () => {
    for (const instant of ['1969-12-31T23:59:59.999999Z', '1970-01-01T00:00:00.000000Z', '2026-09-14T11:30:00.123456Z']) {
      expect(microsToInstant(instantToMicros(instant))).toBe(instant);
    }
    expect(instantToMicros('1969-12-31T23:59:59.999999Z')).toBe(-1n);
  });

  it('refuse a non-canonical instant and a micros value past year 9999', () => {
    expect(() => instantToMicros('2026-09-14T11:30:00Z')).toThrow(VersionError);
    expect(() => microsToInstant(253402300800000000n)).toThrow(VersionError);
    expect(() => microsToInstant(10n ** 20n)).toThrow(VersionError); // past the Date range
  });
});

describe('skew bound', () => {
  it('is five minutes, the number sync.proto states', () => {
    expect(MAX_FUTURE_SKEW_MS).toBe(300_000);
  });
});
