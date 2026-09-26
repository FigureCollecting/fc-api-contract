import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
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

  // Rule 6's interim display: the live status with the higher version among requested_as.
  const shown = (local: Map<string, Held>, requestedAs: string[]) =>
    requestedAs
      .map((id) => local.get(userFacetKey(id, 'status')))
      .filter((h): h is Held => h !== undefined && h.op === SyncOp.UPSERT)
      .sort((x, y) => compareVersion(y.version, x.version))[0]?.status;

  it('clears with one delete that tombstones every live status among requested_as, each above its own version', () => {
    const now = Date.parse('2026-09-14T11:30:00.000Z');
    const hlc = new Hlc({ deviceId: DEVICE, clock: { wallMs: () => now, monoMs: () => 0 } });
    hlc.measure('2026-09-14T11:30:00.000000Z', 0);
    const local = new Map<string, Held>([
      [userFacetKey(A, 'status'), { version: `2026-09-01T00:00:00.000000Z#0000000000#${DEVICE}`, op: SyncOp.UPSERT, status: 'owned' }],
      // Written by another device whose clock ran 3 minutes ahead.
      [userFacetKey(B, 'status'), { version: `2026-09-14T11:33:00.000000Z#0000000000#${OTHER}`, op: SyncOp.UPSERT, status: 'wished' }],
    ]);
    expect(shown(local, [A, B])).toBe('wished');

    const tombstones = [A, B]
      .map((id) => userFacetKey(id, 'status'))
      .filter((key) => local.get(key)?.op === SyncOp.UPSERT)
      .map((key) => ({ facetKey: key, version: hlc.tick(local.get(key)!.version), op: SyncOp.DELETE }));
    for (const t of tombstones) {
      if (compareVersion(local.get(t.facetKey)!.version, t.version) < 0) local.set(t.facetKey, { version: t.version, op: t.op });
    }

    expect(tombstones.map((t) => t.facetKey)).toEqual([userFacetKey(A, 'status'), userFacetKey(B, 'status')]);
    expect(shown(local, [A, B])).toBeUndefined();
  });
});
