import { describe, expect, it } from 'vitest';
import { create, equals, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import {
  CompareRequestSchema,
  CompareResponseSchema,
  CoverageSchema,
} from '../src/index.js';

// A CompareResult as the spine actually emits one: every amount and every
// instant is a STRING. The long product code and the trailing-zero amount are
// the two values that a Struct-based response would quietly corrupt, so they
// are the ones worth carrying through the round trip.
const SPINE_RESULT_JSON = JSON.stringify({
  heads: [
    {
      headId: 'head_01J8Z9',
      perStore: [
        {
          store: 'amiami',
          price: { amount: '18700.00', currency: 'JPY' },
          asOf: '2026-09-14T11:30:00.123456Z',
          productCode: '4580416943215000123',
        },
      ],
    },
  ],
  related: [],
  coverage: { redacted: ['inventory_levels'] },
});

describe('CompareRequest', () => {
  it('round-trips a gtin14 seed through binary and JSON', () => {
    const msg = create(CompareRequestSchema, {
      seed: { case: 'gtin14', value: '00045804169432' },
      nowIso: '2026-09-14T11:30:00.123456Z',
    });

    const fromBin = fromBinary(CompareRequestSchema, toBinary(CompareRequestSchema, msg));
    expect(equals(CompareRequestSchema, msg, fromBin)).toBe(true);

    const viaJson = fromJson(CompareRequestSchema, toJson(CompareRequestSchema, msg));
    expect(equals(CompareRequestSchema, msg, viaJson)).toBe(true);
    expect(viaJson.seed).toEqual({ case: 'gtin14', value: '00045804169432' });
  });

  it('round-trips a head_id seed and keeps the seed exclusive', () => {
    const msg = create(CompareRequestSchema, {
      seed: { case: 'headId', value: 'head_01J8Z9' },
      nowIso: '2026-09-14T11:30:00.123456Z',
    });

    const fromBin = fromBinary(CompareRequestSchema, toBinary(CompareRequestSchema, msg));
    expect(equals(CompareRequestSchema, msg, fromBin)).toBe(true);
    // The oneof is the contract's way of saying "exactly one seed"; a decoder
    // that surfaced both would let a caller smuggle a second seed past the
    // INVALID_ARGUMENT check.
    expect(fromBin.seed.case).toBe('headId');
  });

  it('carries now_iso as the caller wrote it, sub-second digits intact', () => {
    // A server that parsed and re-serialised this would round 123456 to 123.
    const nowIso = '2026-09-14T11:30:00.123456Z';
    const msg = create(CompareRequestSchema, { seed: { case: 'gtin14', value: '1' }, nowIso });
    expect(fromBinary(CompareRequestSchema, toBinary(CompareRequestSchema, msg)).nowIso).toBe(nowIso);
  });
});

describe('CompareResponse', () => {
  it('round-trips the spine payload through binary and JSON', () => {
    const msg = create(CompareResponseSchema, {
      resultJson: SPINE_RESULT_JSON,
      coverage: { redacted: ['inventory_levels'] },
    });

    const fromBin = fromBinary(CompareResponseSchema, toBinary(CompareResponseSchema, msg));
    expect(equals(CompareResponseSchema, msg, fromBin)).toBe(true);

    const viaJson = fromJson(CompareResponseSchema, toJson(CompareResponseSchema, msg));
    expect(equals(CompareResponseSchema, msg, viaJson)).toBe(true);
  });

  it('carries result_json byte-for-byte, so string amounts never fold to float64', () => {
    const msg = create(CompareResponseSchema, { resultJson: SPINE_RESULT_JSON });
    const decoded = fromBinary(CompareResponseSchema, toBinary(CompareResponseSchema, msg));

    expect(decoded.resultJson).toBe(SPINE_RESULT_JSON);
    const parsed = JSON.parse(decoded.resultJson) as {
      heads: { perStore: { price: { amount: string }; productCode: string }[] }[];
    };
    // The trailing zeros and the 19-digit code survive: both are lost the moment
    // the transport folds JSON numbers, which is why result_json is text.
    expect(parsed.heads[0]!.perStore[0]!.price.amount).toBe('18700.00');
    expect(parsed.heads[0]!.perStore[0]!.productCode).toBe('4580416943215000123');
  });

  it('lifts coverage.redacted with the same members in the same order', () => {
    const redacted = ['inventory_levels', 'wholesale_price'];
    const msg = create(CompareResponseSchema, {
      resultJson: JSON.stringify({ heads: [], coverage: { redacted } }),
      coverage: { redacted },
    });
    const decoded = fromBinary(CompareResponseSchema, toBinary(CompareResponseSchema, msg));

    const inBlob = (JSON.parse(decoded.resultJson) as { coverage: { redacted: string[] } })
      .coverage.redacted;
    // The lift is a copy, never a recomputation: if these two ever disagree the
    // client is being told a different story than the spine told the coordinator.
    expect(decoded.coverage?.redacted).toEqual(inBlob);
    expect(decoded.coverage?.redacted).toEqual(redacted);
  });

  it('distinguishes nothing-withheld from nothing-found', () => {
    // Entitled caller, unknown seed: empty heads, empty redacted.
    const entitled = create(CompareResponseSchema, {
      resultJson: JSON.stringify({ heads: [], coverage: { redacted: [] } }),
      coverage: {},
    });
    const decodedEntitled = fromBinary(
      CompareResponseSchema,
      toBinary(CompareResponseSchema, entitled),
    );
    expect(decodedEntitled.coverage?.redacted).toEqual([]);

    // Fail-closed caller: a populated result with a facet named as withheld.
    const denied = create(CompareResponseSchema, {
      resultJson: SPINE_RESULT_JSON,
      coverage: { redacted: ['inventory_levels'] },
    });
    const decodedDenied = fromBinary(CompareResponseSchema, toBinary(CompareResponseSchema, denied));
    expect(decodedDenied.coverage?.redacted).toEqual(['inventory_levels']);
  });
});

describe('Coverage', () => {
  it('round-trips an empty and a populated redaction list', () => {
    const empty = create(CoverageSchema, {});
    expect(fromBinary(CoverageSchema, toBinary(CoverageSchema, empty)).redacted).toEqual([]);

    const populated = create(CoverageSchema, { redacted: ['inventory_levels'] });
    const decoded = fromBinary(CoverageSchema, toBinary(CoverageSchema, populated));
    expect(equals(CoverageSchema, populated, decoded)).toBe(true);
    expect(fromJson(CoverageSchema, toJson(CoverageSchema, populated)).redacted).toEqual([
      'inventory_levels',
    ]);
  });
});
