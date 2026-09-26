import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  GetProductsResponseSchema,
  HOLDING_STATUSES,
  Hlc,
  PUSH_REJECT_REASONS,
  SyncOp,
  USER_FACET_FIELDS,
  USER_FACET_PAYLOAD_SCHEMAS,
  compareVersion,
  parseUserFacetKey,
  userFacetKey,
} from '../src/index.js';

const HEAD = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';

describe('user-owned facet keys', () => {
  it.each([
    [`holding/${HEAD}/status`, 'status'],
    [`holding/${HEAD}/count`, 'count'],
    [`uf/${HEAD}/score`, 'score'],
    [`uf/${HEAD}/note`, 'note'],
  ])('parses %s', (key, field) => {
    expect(parseUserFacetKey(key)).toEqual({ headId: HEAD, field });
  });

  it.each([
    [`holding/${HEAD}/score`, 'score lives under uf/'],
    [`uf/${HEAD}/status`, 'status lives under holding/'],
    [`holding/${HEAD.toUpperCase()}/status`, 'uppercase head id: a second spelling of one facet'],
    [`holding/${HEAD.replaceAll('-', '')}/status`, 'dashless head id'],
    [`holding/owned/${HEAD}`, 'the per-list grain that was not chosen'],
    [`holding/${HEAD}/status/extra`, 'trailing segment'],
    [`price/${HEAD}/amiami/new/list`, 'a server-owned kind'],
    ['holding:01J8Z9/condition', 'the 0.1.0 example spelling'],
    ['', 'empty'],
  ])('rejects %s (%s)', (key) => {
    expect(parseUserFacetKey(key)).toBeUndefined();
  });

  it('builds the canonical key, folding the head id to lowercase', () => {
    expect(userFacetKey(HEAD.toUpperCase(), 'status')).toBe(`holding/${HEAD}/status`);
    expect(userFacetKey(HEAD, 'note')).toBe(`uf/${HEAD}/note`);
    for (const field of USER_FACET_FIELDS) {
      expect(parseUserFacetKey(userFacetKey(HEAD, field))).toEqual({ headId: HEAD, field });
    }
  });

  it('refuses to build a key from something that is not a head id', () => {
    expect(() => userFacetKey('not-a-uuid', 'status')).toThrow(TypeError);
    expect(() => userFacetKey(HEAD, 'condition' as never)).toThrow(TypeError);
  });
});

describe('vocabulary', () => {
  it('names the three holding states', () => {
    expect(HOLDING_STATUSES).toEqual(['owned', 'ordered', 'wished']);
  });

  it('names the five REJECTED reason codes', () => {
    expect(PUSH_REJECT_REASONS).toEqual([
      'version_malformed',
      'version_future',
      'facet_key_not_user_owned',
      'device_mismatch',
      'payload_invalid',
    ]);
  });

  it('points every field at a schema file the package ships', () => {
    expect(Object.keys(USER_FACET_PAYLOAD_SCHEMAS).sort()).toEqual([...USER_FACET_FIELDS].sort());
    for (const rel of Object.values(USER_FACET_PAYLOAD_SCHEMAS)) {
      expect(existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url))), rel).toBe(true);
    }
  });
});

describe('rule 6: a merged card', () => {
  const A = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
  const B = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
  const DEVICE = '0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
  const OTHER = '9c1e3a5b7d9f1b3d5f7a9c1e3b5d7f9a';
  type Held = { version: string; op: SyncOp; status?: string };

  const statusAt = (id: string, day: string, status: string, device = DEVICE): [string, Held] => [
    userFacetKey(id, 'status'),
    { version: `${day}#0000000000#${device}`, op: SyncOp.UPSERT, status },
  ];
  const clockAt = () => {
    const now = Date.parse('2026-09-14T11:30:00.000Z');
    const hlc = new Hlc({ deviceId: DEVICE, clock: { wallMs: () => now, monoMs: () => 0 } });
    hlc.measure('2026-09-14T11:30:00.000000Z', 0);
    return hlc;
  };

  // Rule 6's interim display: the live status with the higher version among requested_as. Its
  // head_id is also where a new write for the card goes.
  const displayed = (local: Map<string, Held>, requestedAs: string[]) =>
    requestedAs
      .map((id) => ({ id, held: local.get(userFacetKey(id, 'status')) }))
      .filter((h): h is { id: string; held: Held } => h.held !== undefined && h.held.op === SyncOp.UPSERT)
      .sort((x, y) => compareVersion(y.held.version, x.held.version))[0];
  const shown = (local: Map<string, Held>, requestedAs: string[]) => displayed(local, requestedAs)?.held.status;

  // A delete on the card: tombstone every live status among requested_as, each above its own version.
  const deleteCard = (hlc: Hlc, local: Map<string, Held>, requestedAs: string[]) => {
    const tombstones = requestedAs
      .map((id) => userFacetKey(id, 'status'))
      .filter((key) => local.get(key)?.op === SyncOp.UPSERT)
      .map((key) => ({ facetKey: key, version: hlc.tick(local.get(key)!.version), op: SyncOp.DELETE }));
    for (const t of tombstones) {
      if (compareVersion(local.get(t.facetKey)!.version, t.version) < 0) local.set(t.facetKey, { version: t.version, op: t.op });
    }
    return tombstones.map((t) => t.facetKey);
  };

  it('clears with one delete that tombstones every live status among requested_as, each above its own version', () => {
    const local = new Map<string, Held>([
      statusAt(A, '2026-09-01T00:00:00.000000Z', 'owned'),
      // Written by another device whose clock ran 3 minutes ahead.
      statusAt(B, '2026-09-14T11:33:00.000000Z', 'wished', OTHER),
    ]);
    expect(shown(local, [A, B])).toBe('wished');

    expect(deleteCard(clockAt(), local, [A, B])).toEqual([userFacetKey(A, 'status'), userFacetKey(B, 'status')]);
    expect(shown(local, [A, B])).toBeUndefined();
  });

  it('groups cards by head_id across GetProducts calls and unions requested_as, so display, write target and delete see both held ids', () => {
    const SURVIVOR = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
    const held = () => new Map<string, Held>([
      statusAt(A, '2026-09-01T00:00:00.000000Z', 'owned'),
      statusAt(B, '2026-09-10T00:00:00.000000Z', 'wished'),
    ]);
    // 1,144 held ids take six calls of at most 200 refs. A and B fell in different calls, so each
    // call's card names only its own ref.
    const ref = (id: string) => ({ ref: { case: 'headId' as const, value: id } });
    const calls = [
      create(GetProductsResponseSchema, { products: [{ headId: SURVIVOR, requestedAs: [ref(A)] }] }),
      create(GetProductsResponseSchema, { products: [{ headId: SURVIVOR, requestedAs: [ref(B)] }] }),
    ];
    const perCall = held();
    deleteCard(clockAt(), perCall, [B]);
    expect(shown(perCall, [A, B])).toBe('owned'); // a delete through one call's card leaves the other live

    const byHead = new Map<string, string[]>();
    for (const card of calls.flatMap((c) => c.products)) {
      const ids = card.requestedAs.flatMap((r) => (r.ref.case === 'headId' ? [r.ref.value] : []));
      byHead.set(card.headId, [...new Set([...(byHead.get(card.headId) ?? []), ...ids])]);
    }
    const requestedAs = byHead.get(SURVIVOR)!;
    const local = held();
    expect(requestedAs).toEqual([A, B]);
    expect(shown(local, requestedAs)).toBe('wished');
    expect(displayed(local, requestedAs)?.id).toBe(B); // the write target

    deleteCard(clockAt(), local, requestedAs);
    expect(shown(local, requestedAs)).toBeUndefined();
  });
});
