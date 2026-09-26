import { describe, expect, it } from 'vitest';
import { create, equals, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import {
  DeltaRequestSchema,
  DeltaResponseSchema,
  PushOutcome,
  PushRequestSchema,
  PushResponseSchema,
  PushResultSchema,
  StatusRequestSchema,
  StatusResponseSchema,
  SyncEventSchema,
  SyncOp,
  USER_FACET_FIELDS,
  userFacetKey,
} from '../src/index.js';

const HEAD = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const STATUS_KEY = userFacetKey(HEAD, 'status');
const UPSERT = {
  facetKey: STATUS_KEY,
  version: '2026-09-14T11:30:00.123456Z#0000000000#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e',
  op: SyncOp.UPSERT,
  payload: JSON.stringify({ status: 'owned', edited_at: '2026-09-14T06:29:58.500-05:00', tz: 'America/Chicago' }),
};

describe('SyncEvent', () => {
  it('round-trips an upsert through binary and JSON', () => {
    const msg = create(SyncEventSchema, UPSERT);

    const fromBin = fromBinary(SyncEventSchema, toBinary(SyncEventSchema, msg));
    expect(equals(SyncEventSchema, msg, fromBin)).toBe(true);

    const viaJson = fromJson(SyncEventSchema, toJson(SyncEventSchema, msg));
    expect(equals(SyncEventSchema, msg, viaJson)).toBe(true);
  });

  it('round-trips a tombstone with an empty payload', () => {
    const msg = create(SyncEventSchema, {
      facetKey: STATUS_KEY,
      version: '2026-09-14T11:31:00.000000Z#0000000000#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e',
      op: SyncOp.DELETE,
      payload: '',
    });
    const decoded = fromBinary(SyncEventSchema, toBinary(SyncEventSchema, msg));

    expect(decoded.op).toBe(SyncOp.DELETE);
    expect(decoded.payload).toBe('');
  });

  it('keeps version a raw string whose lexicographic order is the instant order', () => {
    const decoded = fromBinary(SyncEventSchema, toBinary(SyncEventSchema, create(SyncEventSchema, UPSERT)));

    expect(decoded.version).toBe(UPSERT.version);
    // The client's merge rule is `version > local[facet]` on these strings. It
    // is only correct while the server emits normalised UTC, so the contract
    // test states the property rather than trusting the comment.
    expect(decoded.version > '2026-09-14T11:29:59.999999Z').toBe(true);
    expect(decoded.version > '2026-09-14T11:30:00.123457Z').toBe(false);
  });

  it('never restamps the user-visible edit time carried inside payload', () => {
    const decoded = fromBinary(SyncEventSchema, toBinary(SyncEventSchema, create(SyncEventSchema, UPSERT)));
    const payload = JSON.parse(decoded.payload) as { edited_at: string; tz: string };

    // The merge token is UTC; what the user sees is their own local edit time,
    // offset and all, untouched by the wire.
    expect(payload.edited_at).toBe('2026-09-14T06:29:58.500-05:00');
    expect(payload.tz).toBe('America/Chicago');
    expect(payload.edited_at).not.toBe(decoded.version);
  });

  it('preserves an op number it does not know, so an old app degrades instead of corrupting', () => {
    // A phone installed months ago decoding an op added since. proto3 enums are
    // open: the number must survive the round trip rather than collapse to 0,
    // which would turn an unknown op into a silent UNSPECIFIED.
    const forward = fromBinary(SyncEventSchema, toBinary(SyncEventSchema, create(SyncEventSchema, {
      ...UPSERT,
      op: 99 as SyncOp,
    })));

    expect(forward.op).toBe(99);
    expect(forward.op).not.toBe(SyncOp.UNSPECIFIED);
    expect(toBinary(SyncEventSchema, forward)).toEqual(
      toBinary(SyncEventSchema, create(SyncEventSchema, { ...UPSERT, op: 99 as SyncOp })),
    );
  });
});

describe('Delta', () => {
  it('round-trips a request with an empty cursor meaning from-the-beginning', () => {
    const msg = create(DeltaRequestSchema, { cursor: '', limit: 0 });
    const decoded = fromBinary(DeltaRequestSchema, toBinary(DeltaRequestSchema, msg));

    expect(decoded.cursor).toBe('');
    expect(decoded.limit).toBe(0);
    expect(equals(DeltaRequestSchema, msg, decoded)).toBe(true);
  });

  it('round-trips a resumed request', () => {
    const msg = create(DeltaRequestSchema, { cursor: 'seq:8417', limit: 500 });

    expect(equals(DeltaRequestSchema, msg, fromBinary(DeltaRequestSchema, toBinary(DeltaRequestSchema, msg)))).toBe(true);
    expect(fromJson(DeltaRequestSchema, toJson(DeltaRequestSchema, msg)).cursor).toBe('seq:8417');
  });

  it('round-trips a page and keeps event order', () => {
    const second = { ...UPSERT, version: '2026-09-14T11:32:00.000000Z#0000000000#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e', payload: '{"status":"wished","edited_at":"2026-09-14T06:32:00-05:00","tz":"America/Chicago"}' };
    const msg = create(DeltaResponseSchema, {
      events: [UPSERT, second],
      nextCursor: 'seq:8419',
      hasMore: true,
    });
    const decoded = fromBinary(DeltaResponseSchema, toBinary(DeltaResponseSchema, msg));

    expect(equals(DeltaResponseSchema, msg, decoded)).toBe(true);
    // Two events for one facet in one page: applying them out of order would
    // leave the older value winning.
    expect(decoded.events.map((e) => e.version)).toEqual([UPSERT.version, second.version]);
    expect(decoded.hasMore).toBe(true);
  });

  it('round-trips the last page, which still carries a resumable cursor', () => {
    const msg = create(DeltaResponseSchema, { events: [], nextCursor: 'seq:8419', hasMore: false });
    const decoded = fromJson(DeltaResponseSchema, toJson(DeltaResponseSchema, msg));

    expect(decoded.events).toEqual([]);
    expect(decoded.nextCursor).toBe('seq:8419');
    expect(decoded.hasMore).toBe(false);
  });
});

describe('Push', () => {
  it('round-trips a batch carrying its idempotency key', () => {
    const msg = create(PushRequestSchema, { clientId: 'dev-7f3a/batch-00019', events: [UPSERT] });
    const decoded = fromBinary(PushRequestSchema, toBinary(PushRequestSchema, msg));

    expect(equals(PushRequestSchema, msg, decoded)).toBe(true);
    // A retry after a dropped response carries this unchanged; without it the
    // server cannot tell a retry from a second edit.
    expect(decoded.clientId).toBe('dev-7f3a/batch-00019');
  });

  it('round-trips every outcome the conflict policy can produce', () => {
    const outcomes = [
      PushOutcome.APPLIED,
      PushOutcome.DUPLICATE,
      PushOutcome.STALE,
      PushOutcome.REVIEW,
      PushOutcome.REJECTED,
    ];
    const msg = create(PushResponseSchema, {
      results: outcomes.map((outcome, i) => ({
        facetKey: userFacetKey(HEAD, USER_FACET_FIELDS[i % USER_FACET_FIELDS.length]!),
        outcome,
        version: '2026-09-14T11:30:00.123456Z',
      })),
    });
    const decoded = fromBinary(PushResponseSchema, toBinary(PushResponseSchema, msg));

    expect(equals(PushResponseSchema, msg, decoded)).toBe(true);
    expect(decoded.results.map((r) => r.outcome)).toEqual(outcomes);
  });

  it('carries the server facet whole on a non-applied result so the client can converge', () => {
    const current = {
      facetKey: STATUS_KEY,
      version: '2026-09-14T12:00:00.000000Z#0000000000#9c1e3a5b7d9f1b3d5f7a9c1e3b5d7f9a',
      op: SyncOp.UPSERT,
      payload: '{"status":"ordered","edited_at":"2026-09-14T07:00:00-05:00","tz":"America/Chicago"}',
    };
    const msg = create(PushResultSchema, {
      facetKey: STATUS_KEY,
      outcome: PushOutcome.STALE,
      version: current.version,
      current,
    });
    const decoded = fromJson(PushResultSchema, toJson(PushResultSchema, msg));

    // Version alone is the 0.1.0 defect: a client storing it next to its own
    // losing payload drops the Delta event at that version as not newer.
    expect(decoded.outcome).toBe(PushOutcome.STALE);
    expect(decoded.current?.version).toBe(current.version);
    expect(decoded.current?.payload).toBe(current.payload);
    expect(decoded.current?.op).toBe(SyncOp.UPSERT);
  });

  it('round-trips a REJECTED result with its reason and no current value', () => {
    const msg = create(PushResultSchema, {
      facetKey: 'price/x',
      outcome: PushOutcome.REJECTED,
      reason: 'facet_key_not_user_owned: price/ is server-owned',
    });
    const decoded = fromBinary(PushResultSchema, toBinary(PushResultSchema, msg));

    expect(decoded.outcome).toBe(PushOutcome.REJECTED);
    expect(decoded.reason.split(':')[0]).toBe('facet_key_not_user_owned');
    expect(decoded.current).toBeUndefined();
    expect(decoded.version).toBe('');
  });
});

describe('Status', () => {
  it('round-trips the empty request', () => {
    const msg = create(StatusRequestSchema, {});
    expect(equals(StatusRequestSchema, msg, fromBinary(StatusRequestSchema, toBinary(StatusRequestSchema, msg)))).toBe(true);
    expect(toBinary(StatusRequestSchema, msg).length).toBe(0);
  });

  it('round-trips head, review backlog and the clock sample', () => {
    const msg = create(StatusResponseSchema, {
      cursor: 'seq:8419',
      pendingReview: 3n,
      serverNowIso: '2026-09-14T11:33:07.000000Z',
    });
    const decoded = fromBinary(StatusResponseSchema, toBinary(StatusResponseSchema, msg));

    expect(equals(StatusResponseSchema, msg, decoded)).toBe(true);
    expect(decoded.pendingReview).toBe(3n);
    // The HLC anchor. A client reads this, not its own clock, to measure offset.
    expect(decoded.serverNowIso).toBe('2026-09-14T11:33:07.000000Z');
  });

  it('round-trips a caught-up status through JSON', () => {
    const msg = create(StatusResponseSchema, {
      cursor: 'seq:8419',
      pendingReview: 0n,
      serverNowIso: '2026-09-14T11:33:07.000000Z',
    });
    const decoded = fromJson(StatusResponseSchema, toJson(StatusResponseSchema, msg));

    expect(decoded.pendingReview).toBe(0n);
    expect(decoded.cursor).toBe('seq:8419');
  });
});
