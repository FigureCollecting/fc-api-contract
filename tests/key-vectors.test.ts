import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_KINDS,
  FACET_KEY_GRAMMARS,
  IMPORT_WRITTEN_FAMILIES,
  OCC_FIELDS,
  UF_FIELDS,
  buildFacetKey,
  canonicalMfcId,
  collectionRef,
  importOccIdFromMac,
  mfcImportOccName,
  parseCollectionRef,
  parseServerFacetKey,
  parseUserFacetKey,
  type FacetKey,
  type ImportTargetKey,
  type ServerFacetKey,
  type UserFacetKey,
} from '../src/index.js';
import { importOccMac, uuidV8 } from './support/import-occ-id.js';

interface Vectors {
  mfcImportOccTestKey: { hex: string; note: string };
  valid: { key: string; owner: 'user' | 'server'; parsed: FacetKey; note: string }[];
  invalid: { key: string; note: string }[];
  build: { input: FacetKey; key: string; note: string }[];
  buildRejects: { input: unknown; note: string }[];
  collectionRefs: {
    valid: { ref: string; kind: string; collId: string }[];
    invalid: { ref: string; note: string }[];
  };
  mfcIds: { canonical: { raw: string; id: string }[]; invalid: { raw: string; note: string }[] };
  mfcImportOccIds: { userId: string; mfcId: string; ordinal: number; name: string; occId: string }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/key-vectors.json', import.meta.url)), 'utf8'),
) as Vectors;

const parse = (key: string): FacetKey | undefined => parseUserFacetKey(key) ?? parseServerFacetKey(key);
const grammarsMatching = (key: string) => FACET_KEY_GRAMMARS.filter((g) => g.pattern.test(key)).map((g) => g.family);

describe('golden key vectors', () => {
  it('cover every family, user- and server-owned', () => {
    const families = new Set(vectors.valid.map((v) => v.parsed.family));
    expect([...families].sort()).toEqual(FACET_KEY_GRAMMARS.map((g) => g.family).sort());
  });

  it.each(vectors.valid.map((v) => [v.key, v] as const))('parses %s to exactly one family', (key, v) => {
    const user = parseUserFacetKey(key);
    const server = parseServerFacetKey(key);
    if (v.owner === 'user') {
      expect(user).toEqual(v.parsed);
      expect(server).toBeUndefined();
    } else {
      expect(server).toEqual(v.parsed);
      expect(user).toBeUndefined();
    }
    expect(grammarsMatching(key)).toEqual([v.parsed.family]);
    expect(buildFacetKey(v.parsed)).toBe(key);
  });

  it.each(vectors.invalid.map((v) => [v.key, v.note] as const))('rejects %j (%s)', (key) => {
    expect(parseUserFacetKey(key)).toBeUndefined();
    expect(parseServerFacetKey(key)).toBeUndefined();
    expect(grammarsMatching(key)).toEqual([]);
  });

  it.each(vectors.build.map((v) => [v.note, v] as const))('builds the canonical key: %s', (_note, v) => {
    expect(buildFacetKey(v.input)).toBe(v.key);
  });

  it.each(vectors.buildRejects.map((v) => [v.note, v] as const))('refuses to build: %s', (_note, v) => {
    expect(() => buildFacetKey(v.input as FacetKey)).toThrow(TypeError);
  });

  it.each(vectors.collectionRefs.valid.map((v) => [v.ref, v] as const))('parses the collection ref %s', (ref, v) => {
    expect(parseCollectionRef(ref)).toEqual({ kind: v.kind, collId: v.collId });
    expect(collectionRef(v.kind as never, v.collId)).toBe(ref);
  });

  it.each(vectors.collectionRefs.invalid.map((v) => [v.ref, v.note] as const))('rejects the collection ref %j (%s)', (ref) => {
    expect(parseCollectionRef(ref)).toBeUndefined();
  });

  it('mint import copies under a published TEST key, never a namespace anyone can recompute from', () => {
    expect(vectors.mfcImportOccTestKey.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(vectors.mfcImportOccTestKey.note).toMatch(/TEST ONLY/);
    expect(vectors).not.toHaveProperty('mfcImportOccNamespace');
  });

  it.each(vectors.mfcIds.canonical.map((v) => [v.raw, v.id] as const))('canonicalises the MFC id %j to %j', (raw, id) => {
    expect(canonicalMfcId(raw)).toBe(id);
    expect(canonicalMfcId(id)).toBe(id);
  });

  it.each(vectors.mfcIds.invalid.map((v) => [v.raw, v.note] as const))('refuses the MFC id %j (%s)', (raw) => {
    expect(() => canonicalMfcId(raw)).toThrow(TypeError);
    expect(() => mfcImportOccName(vectors.mfcImportOccIds[0]!.userId, raw, 1)).toThrow(TypeError);
  });

  it.each(vectors.mfcImportOccIds.map((v) => [`${v.mfcId}:${v.ordinal}`, v] as const))('names and mints the import copy %s', (_label, v) => {
    expect(mfcImportOccName(v.userId, v.mfcId, v.ordinal)).toBe(v.name);
    expect(mfcImportOccName(v.userId.toUpperCase(), v.mfcId, v.ordinal)).toBe(v.name);
    const mac = importOccMac(vectors.mfcImportOccTestKey.hex, v.name);
    expect(uuidV8(mac)).toBe(v.occId);
    expect(importOccIdFromMac(mac)).toBe(v.occId);
    expect(parseUserFacetKey(`occ/${v.occId}/status`)).toEqual({ family: 'occ/status', occId: v.occId });
  });

  it('gives one MFC item one set of copies, however many leading zeros the export writes', () => {
    const user = vectors.mfcImportOccIds[0]!.userId;
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 20n }), fc.nat({ max: 5 }), (n, zeros) => {
        const id = n.toString();
        expect(canonicalMfcId('0'.repeat(zeros) + id)).toBe(id);
        expect(mfcImportOccName(user, '0'.repeat(zeros) + id, 1)).toBe(mfcImportOccName(user, id, 1));
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Properties: every structured key round-trips through its one spelling, and no string is ever
// claimed by two families (a second family for one string would make one facet two facets).
// ---------------------------------------------------------------------------
const id = fc.uuid();
const kind = fc.constantFrom(...COLLECTION_KINDS);
const userKey: fc.Arbitrary<UserFacetKey> = fc.oneof(
  fc.record({ family: fc.constantFrom(...OCC_FIELDS.map((f) => `occ/${f}` as const)), occId: id }),
  fc.record({ family: fc.constant('occ/tag' as const), occId: id, tagId: id }),
  fc.record({ family: fc.constantFrom(...UF_FIELDS.map((f) => `uf/${f}` as const)), headId: id }),
  fc.record({ family: fc.constant('uf/tag' as const), headId: id, tagId: id }),
  fc.record({ family: fc.constant('uf/ktag' as const), headId: id, collKind: kind, tagId: id }),
  fc.record({ family: fc.constant('coll/name' as const), collKind: kind, collId: fc.oneof(id, fc.constant('default')) }),
  fc.record({ family: fc.constant('tag/name' as const), tagId: id }),
);
const importTarget = userKey.filter((k): k is ImportTargetKey => (IMPORT_WRITTEN_FAMILIES as readonly string[]).includes(k.family));
const serverKey: fc.Arbitrary<ServerFacetKey> = fc.oneof(
  fc.record({ family: fc.constant('occ/origin' as const), occId: id }),
  fc.record({
    family: fc.constantFrom('imp/base' as const, 'imp/conflict' as const),
    site: fc.stringMatching(/^[a-z][a-z0-9-]{0,31}$/),
    target: importTarget,
  }),
);
const anyKey: fc.Arbitrary<FacetKey> = fc.oneof(userKey, serverKey);

const shout = (k: FacetKey): FacetKey =>
  JSON.parse(JSON.stringify(k), (name, value: unknown) =>
    typeof value === 'string' && /Id$/.test(name) ? value.toUpperCase() : value,
  ) as FacetKey;

// Segments every grammar is built from, plus near misses, so random joins probe the boundaries.
const SEGMENTS = [
  'occ', 'uf', 'coll', 'tag', 'imp', 'holding', 'head', 'status', 'collection', 'disposal', 'origin',
  'score', 'note', 'wishability', 'ktag', 'name', 'base', 'conflict', 'mfc', 'default', 'DEFAULT',
  ...COLLECTION_KINDS, 'custom', 'count', '', '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7',
  '5B0C7C7E-2F1D-4C1E-9A1B-3C4D5E6F7A8B', '0192f3a44f5b6c7d8e9f0123456789ab',
];

describe('key grammar properties', () => {
  it('parse(build(x)) == x for every family', () => {
    fc.assert(
      fc.property(anyKey, (k) => {
        expect(parse(buildFacetKey(k))).toEqual(k);
      }),
      { numRuns: 2000 },
    );
  });

  it('folds case in the builder only: an uppercase input builds the lowercase key, whose parse is the lowercase input', () => {
    fc.assert(
      fc.property(anyKey, (k) => {
        const key = buildFacetKey(shout(k));
        expect(key).toBe(buildFacetKey(k));
        expect(parse(key.toUpperCase())).toBeUndefined();
      }),
      { numRuns: 1000 },
    );
  });

  it('claims every built key for exactly one family, the one it was built as', () => {
    fc.assert(
      fc.property(anyKey, (k) => {
        expect(grammarsMatching(buildFacetKey(k))).toEqual([k.family]);
      }),
      { numRuns: 2000 },
    );
  });

  it('never lets two families claim one string, and gives every parsed string one spelling', () => {
    const joined = fc.array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 7 }).map((s) => s.join('/'));
    fc.assert(
      fc.property(fc.oneof(joined, fc.string(), anyKey.map(buildFacetKey)), (key) => {
        expect(grammarsMatching(key).length).toBeLessThanOrEqual(1);
        const user = parseUserFacetKey(key);
        const server = parseServerFacetKey(key);
        expect(user !== undefined && server !== undefined).toBe(false);
        const parsed = user ?? server;
        if (parsed !== undefined) expect(buildFacetKey(parsed)).toBe(key);
        else expect(grammarsMatching(key)).toEqual([]);
      }),
      { numRuns: 5000 },
    );
  });
});
