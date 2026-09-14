import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { SyncEventSchema, SyncOp } from '../src/index.js';

// The canonical spelling of SyncEvent.version and PushResult.version, as
// sync.proto rule 2 pins it: UTC, trailing Z, EXACTLY six fractional digits.
// Defined here rather than shipped as a helper — plan §A.3 keeps helpers in
// fc-shared. The contract states the form; this file is what enforces it.
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const protoText = readFileSync(
  fileURLToPath(new URL('../proto/coordinator/v1/sync.proto', import.meta.url)),
  'utf8',
);

describe('version lexical form', () => {
  it('accepts the canonical spelling and rejects every near-miss', () => {
    expect(CANONICAL.test('2026-09-14T11:30:00.123456Z')).toBe(true);

    // Each of these is a defensible reading of "normalised UTC ISO-8601" and
    // each one breaks the merge rule if it reaches the feed.
    const rejected = [
      '2026-09-14T11:30:00Z', // no fraction — PostgreSQL's default when it is zero
      '2026-09-14T11:30:00.123Z', // millisecond precision
      '2026-09-14T11:30:00.123456789Z', // nanosecond precision
      '2026-09-14T20:30:00.123456+09:00', // offset form, same instant
      '2026-09-14 11:30:00.123456Z', // space separator
      '2026-09-14T11:30:00.123456', // no zone at all
    ];
    for (const v of rejected) {
      expect(CANONICAL.test(v), `${v} must not be accepted as canonical`).toBe(false);
    }
  });

  it('shows why the form is pinned: two spellings of one instant invert', () => {
    const truncated = '2026-09-14T11:30:00Z';
    const full = '2026-09-14T11:30:00.000000Z';

    expect(new Date(truncated).getTime()).toBe(new Date(full).getTime());
    // '.' is 0x2E, 'Z' is 0x5A, so the truncated spelling sorts GREATER. A
    // re-delivered event spelled the other way satisfies `version > local`
    // and re-applies, which breaks "a replay from cursor 0 reaches the same
    // state".
    expect(truncated > full).toBe(true);
  });

  it('orders canonically-spelled versions by instant, including across a second boundary', () => {
    const a = '2026-09-14T11:29:59.999999Z';
    const b = '2026-09-14T11:30:00.000000Z';
    const c = '2026-09-14T11:30:00.000001Z';

    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect([c, a, b].slice().sort()).toEqual([a, b, c]);
  });

  it('leaves room for the HLC counter as a fixed-width sortable suffix', () => {
    // Rule 4's merge token. Appending a fixed-width counter keeps the
    // comparison lexicographic, so an old client that never learned about the
    // counter still orders events correctly.
    const base = '2026-09-14T11:30:00.123456Z';
    const tick1 = `${base}#0000000001`;
    const tick2 = `${base}#0000000002`;
    const later = '2026-09-14T11:30:00.123457Z';

    expect(base < tick1).toBe(true); // no counter sorts first at the same instant
    expect(tick1 < tick2).toBe(true);
    expect(tick2 < later).toBe(true); // a later instant still wins over any counter
    // Variable width would break it, which is why the suffix must be padded.
    expect(`${base}#10` < `${base}#9`).toBe(true);
  });

  it('carries a canonical version through the codec unchanged', () => {
    const version = '2026-09-14T11:30:00.123456Z';
    const decoded = fromBinary(
      SyncEventSchema,
      toBinary(
        SyncEventSchema,
        create(SyncEventSchema, { facetKey: 'f', version, op: SyncOp.UPSERT, payload: '{}' }),
      ),
    );

    expect(decoded.version).toBe(version);
    expect(CANONICAL.test(decoded.version)).toBe(true);
  });
});

describe('sync.proto states the rule the tests enforce', () => {
  it('pins the fractional precision rather than saying only "normalised"', () => {
    // A future loosening of the comment breaks this test, which is the point:
    // in a contract repo the comment IS the contract.
    expect(protoText).toMatch(/exactly six fractional digits/i);
    expect(protoText).toMatch(/trailing `Z`/);
  });

  it('describes version as an opaque lexicographically-ordered token, so the HLC can extend it', () => {
    expect(protoText).toMatch(/lexicographically[- ]ordered/i);
    expect(protoText).toMatch(/fixed-width/i);
  });
});
