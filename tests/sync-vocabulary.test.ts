import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HOLDING_STATUSES,
  PUSH_REJECT_REASONS,
  USER_FACET_FIELDS,
  USER_FACET_PAYLOAD_SCHEMAS,
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
