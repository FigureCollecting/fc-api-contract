import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as contract from '../src/index.js';
import {
  COLLECTION_KINDS,
  DEFAULT_COLLECTION_ID,
  DISPOSAL_REASONS,
  FACET_KEY_GRAMMARS,
  IMPORT_ITEMS,
  OCCURRENCE_STATUSES,
  OCC_FIELDS,
  PUSH_REJECT_REASONS,
  SERVER_FACET_FAMILIES,
  SERVER_FACET_PAYLOAD_SCHEMAS,
  SyncOp,
  UF_FIELDS,
  USER_FACET_FAMILIES,
  USER_FACET_PAYLOAD_SCHEMAS,
  buildFacetKey,
  canonicalMfcId,
  collNameKey,
  collectionRef,
  compareVersion,
  answerKey,
  importItemKey,
  importMarkerKey,
  importOccIdFromMac,
  importPrefKey,
  mfcImportOccName,
  occFacetKey,
  occOriginKey,
  occTagKey,
  parseServerFacetKey,
  parseUserFacetKey,
  payloadSchemaPath,
  tagNameKey,
  ufFacetKey,
  ufKindTagKey,
  ufTagKey,
  type FacetKey,
} from '../src/index.js';

const OCC = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7';
const HEAD = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
const TAG = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const CID = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';

describe('vocabulary', () => {
  it('names the four occurrence statuses, which are also the four collection kinds', () => {
    expect(OCCURRENCE_STATUSES).toEqual(['owned', 'ordered', 'wished', 'former']);
    expect(COLLECTION_KINDS).toEqual(OCCURRENCE_STATUSES);
    expect(DEFAULT_COLLECTION_ID).toBe('default');
  });

  it('names the seven disposal reasons (Ross, 2026-09-27)', () => {
    expect(DISPOSAL_REASONS).toEqual(['sold', 'traded', 'gifted', 'damaged', 'lost', 'stolen', 'other']);
  });

  it('names fourteen user-owned and six server-owned families, one grammar each', () => {
    expect(USER_FACET_FAMILIES).toEqual([
      'occ/head', 'occ/status', 'occ/collection', 'occ/disposal', 'occ/tag',
      'uf/score', 'uf/note', 'uf/wishability', 'uf/tag', 'uf/ktag',
      'coll/name', 'tag/name', 'res/answer', 'pref/import',
    ]);
    expect(SERVER_FACET_FAMILIES).toEqual(['occ/origin', 'imp/figure', 'imp/held', 'imp/change', 'imp/align', 'imp/import']);
    expect(OCC_FIELDS).toEqual(['head', 'status', 'collection', 'disposal']);
    expect(UF_FIELDS).toEqual(['score', 'note', 'wishability']);
    expect(FACET_KEY_GRAMMARS.map((g) => g.family)).toEqual([...USER_FACET_FAMILIES, ...SERVER_FACET_FAMILIES]);
    for (const g of FACET_KEY_GRAMMARS) {
      expect(g.owner).toBe((USER_FACET_FAMILIES as readonly string[]).includes(g.family) ? 'user' : 'server');
      expect(g.pattern.source.startsWith('^') && g.pattern.source.endsWith('$'), g.family).toBe(true);
    }
  });

  it('names the four per-figure items the import keeps on the feed (import.proto THE SERVER DECIDES)', () => {
    expect(IMPORT_ITEMS).toEqual(['figure', 'held', 'change', 'align']);
  });

  it('no longer exports the 0.3.0 draft\'s import bases and conflicts (bases are server-internal now)', () => {
    for (const name of ['importBaseKey', 'importConflictKey', 'IMPORT_WRITTEN_FAMILIES']) expect(contract).not.toHaveProperty(name);
  });

  it('publishes no namespace an import occ id could be recomputed from (the key is the coordinator\'s alone)', () => {
    expect(contract).not.toHaveProperty('MFC_IMPORT_OCC_NAMESPACE');
  });

  it('names the six REJECTED reason codes, basis_missing last', () => {
    expect(PUSH_REJECT_REASONS).toEqual([
      'version_malformed',
      'version_future',
      'facet_key_not_user_owned',
      'device_mismatch',
      'payload_invalid',
      'basis_missing',
    ]);
  });

  it('no longer exports the 0.2.x holding vocabulary', () => {
    for (const name of ['HOLDING_STATUSES', 'USER_FACET_FIELDS', 'userFacetKey']) expect(contract).not.toHaveProperty(name);
  });
});

describe('builders', () => {
  it('build one key per family, folding case', () => {
    expect(occFacetKey(OCC.toUpperCase(), 'status')).toBe(`occ/${OCC}/status`);
    expect(occFacetKey(OCC, 'disposal')).toBe(`occ/${OCC}/disposal`);
    expect(occTagKey(OCC, TAG)).toBe(`occ/${OCC}/tag/${TAG}`);
    expect(ufFacetKey(HEAD, 'wishability')).toBe(`uf/${HEAD}/wishability`);
    expect(ufTagKey(HEAD, TAG)).toBe(`uf/${HEAD}/tag/${TAG}`);
    expect(ufKindTagKey(HEAD, 'owned', TAG)).toBe(`uf/${HEAD}/ktag/owned/${TAG}`);
    expect(collNameKey('owned', 'default')).toBe('coll/owned/default/name');
    expect(collNameKey('wished', CID.toUpperCase())).toBe(`coll/wished/${CID}/name`);
    expect(tagNameKey(TAG)).toBe(`tag/${TAG}/name`);
    expect(occOriginKey(OCC)).toBe(`occ/${OCC}/origin`);
  });

  it('build the import\'s keys: an item per figure, the marker, an answer and the preference', () => {
    expect(typeof importItemKey).toBe('function');
    expect(importItemKey('mfc', 'figure', HEAD.toUpperCase())).toBe(`imp/mfc/figure/${HEAD}`);
    expect(importItemKey('mfc', 'align', HEAD)).toBe(`imp/mfc/align/${HEAD}`);
    expect(importMarkerKey('mfc')).toBe('imp/mfc/import');
    expect(answerKey('mfc', HEAD)).toBe(`res/mfc/${HEAD}`);
    expect(importPrefKey('mfc')).toBe('pref/mfc/import');
    expect(() => importItemKey('mfc', 'base' as never, HEAD)).toThrow(TypeError);
    expect(() => importItemKey('MFC', 'figure', HEAD)).toThrow(TypeError);
    expect(() => importItemKey('mfc', 'figure', 'default')).toThrow(TypeError);
    expect(() => importMarkerKey('m fc')).toThrow(TypeError);
    expect(() => answerKey('mfc', 7 as never)).toThrow(TypeError);
    expect(() => importPrefKey(7 as never)).toThrow(TypeError);
  });

  it('throw TypeError on anything else', () => {
    expect(() => occFacetKey('not-a-uuid', 'status')).toThrow(TypeError);
    expect(() => occFacetKey(OCC, 'acq' as never)).toThrow(TypeError);
    expect(() => ufFacetKey(HEAD, 'status' as never)).toThrow(TypeError);
    expect(() => ufKindTagKey(HEAD, 'research' as never, TAG)).toThrow(TypeError);
    expect(() => collNameKey('owned', 'mine')).toThrow(TypeError);
    expect(() => tagNameKey('default')).toThrow(TypeError);
    expect(() => buildFacetKey({ family: 'imp/base', site: 'mfc', target: { family: 'occ/status', occId: OCC } } as never)).toThrow(TypeError);
    expect(() => buildFacetKey({ family: 'holding/status', headId: HEAD } as never)).toThrow(TypeError);
    expect(() => buildFacetKey(null as never)).toThrow(TypeError);
    // Malformed input from an untyped caller (a JSON body, an IndexedDB row) is refused, never coerced.
    expect(() => occFacetKey(7 as never, 'status')).toThrow(TypeError);
    expect(() => collNameKey('owned', null as never)).toThrow(TypeError);
  });

  it('name an import copy only from a uuid user, a canonical MFC id and an ordinal 1..99', () => {
    const user = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    expect(mfcImportOccName(user, '1144', 99)).toBe(`${user}:mfc:1144:99`);
    expect(mfcImportOccName(user, '001144', 1)).toBe(`${user}:mfc:1144:1`);
    expect(() => mfcImportOccName('user-1', '1144', 1)).toThrow(TypeError);
    expect(() => mfcImportOccName(user, '11a4', 1)).toThrow(TypeError);
    expect(() => mfcImportOccName(user, '', 1)).toThrow(TypeError);
    expect(() => mfcImportOccName(user, '0', 1)).toThrow(TypeError);
    for (const ordinal of [0, 100, 1.5]) expect(() => mfcImportOccName(user, '1144', ordinal), String(ordinal)).toThrow(TypeError);
  });

  it('canonicalise an MFC id by stripping leading zeros, and refuse anything but ASCII digits', () => {
    expect(canonicalMfcId('0001144')).toBe('1144');
    expect(canonicalMfcId('1'.repeat(64))).toBe('1'.repeat(64));
    expect(() => canonicalMfcId('1'.repeat(65))).toThrow(TypeError);
    expect(() => canonicalMfcId('000')).toThrow(TypeError);
    expect(() => canonicalMfcId(1144 as never)).toThrow(TypeError);
  });

  it('spell an import occ id as the MAC\'s first 16 bytes in an RFC 9562 version 8 uuid', () => {
    const mac = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const id = importOccIdFromMac(mac);
    expect(id).toBe('fffefdfc-fbfa-89f8-b7f6-f5f4f3f2f1f0');
    expect(id[14]).toBe('8'); // version 8
    expect('89ab').toContain(id[19]!); // RFC 9562 variant
    const buffer = Buffer.from(mac);
    expect(importOccIdFromMac(buffer)).toBe(id);
    expect(Buffer.compare(buffer, Buffer.from(mac))).toBe(0); // the caller's MAC is never written to
    expect(parseUserFacetKey(`occ/${id}/head`)).toEqual({ family: 'occ/head', occId: id });
    for (const bad of [new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), 'f'.repeat(64), undefined]) {
      expect(() => importOccIdFromMac(bad as never), String(bad)).toThrow(TypeError);
    }
  });

  it('build a collection ref only for a known kind and a uuid or default id', () => {
    expect(collectionRef('former', 'default')).toBe('former/default');
    expect(collectionRef('owned', CID.toUpperCase())).toBe(`owned/${CID}`);
    expect(() => collectionRef('custom' as never, 'default')).toThrow(TypeError);
    expect(() => collectionRef('owned', 'mine')).toThrow(TypeError);
  });

  it('parse nothing that is not a string', () => {
    expect(parseUserFacetKey(undefined as never)).toBeUndefined();
    expect(parseServerFacetKey(7 as never)).toBeUndefined();
    expect(contract.parseCollectionRef(undefined as never)).toBeUndefined();
  });
});

describe('payload schemas', () => {
  const shipped = (rel: string) => existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));

  it('points every user-owned family at a schema file the package ships', () => {
    expect(Object.keys(USER_FACET_PAYLOAD_SCHEMAS)).toEqual([...USER_FACET_FAMILIES]);
    for (const rel of Object.values(USER_FACET_PAYLOAD_SCHEMAS)) expect(shipped(rel), rel).toBe(true);
  });

  it('points every server-owned family at a schema of its own', () => {
    expect(SERVER_FACET_PAYLOAD_SCHEMAS).toEqual({
      'occ/origin': 'schemas/occ-origin.schema.json',
      'imp/figure': 'schemas/imp-figure.schema.json',
      'imp/held': 'schemas/imp-held.schema.json',
      'imp/change': 'schemas/imp-change.schema.json',
      'imp/align': 'schemas/imp-align.schema.json',
      'imp/import': 'schemas/imp-import.schema.json',
    });
    for (const rel of Object.values(SERVER_FACET_PAYLOAD_SCHEMAS)) expect(shipped(rel), rel).toBe(true);
    expect(payloadSchemaPath({ family: 'imp/held', site: 'mfc', headId: HEAD })).toBe('schemas/imp-held.schema.json');
    expect(payloadSchemaPath({ family: 'imp/import', site: 'mfc' })).toBe('schemas/imp-import.schema.json');
    expect(payloadSchemaPath({ family: 'res/answer', site: 'mfc', headId: HEAD })).toBe('schemas/res-answer.schema.json');
    expect(payloadSchemaPath({ family: 'pref/import', site: 'mfc' })).toBe('schemas/pref-import.schema.json');
    expect(payloadSchemaPath({ family: 'occ/origin', occId: OCC })).toBe('schemas/occ-origin.schema.json');
    expect(payloadSchemaPath({ family: 'occ/tag', occId: OCC, tagId: TAG })).toBe('schemas/occ-tag.schema.json');
  });

  it('ships no schema for the retired holding grain or the 0.3.0 draft\'s import conflict', () => {
    expect(shipped('schemas/holding-status.schema.json')).toBe(false);
    expect(shipped('schemas/holding-count.schema.json')).toBe(false);
    expect(shipped('schemas/imp-conflict.schema.json')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 6, executed. Each device holds facets under LWW; these helpers are the rules sync.proto
// states, written the simplest way, so the claims the comment makes are checked, not just stated.
// ---------------------------------------------------------------------------
describe('rule 6: occurrences under LWW', () => {
  type Facet = { version: string; op: SyncOp; value?: Record<string, unknown> };
  type Replica = Map<string, Facet>;
  const DEVICE_A = '0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
  const DEVICE_B = '9c1e3a5b7d9f1b3d5f7a9c1e3b5d7f9a';
  const v = (minute: number, device: string) => `2026-09-27T01:${String(minute).padStart(2, '0')}:00.000000Z#0000000000#${device}`;
  const put = (key: FacetKey, minute: number, device: string, value?: Record<string, unknown>): [string, Facet] => [
    buildFacetKey(key),
    { version: v(minute, device), op: value === undefined ? SyncOp.DELETE : SyncOp.UPSERT, value },
  ];
  // Deliver every event to every replica in any order: the higher version wins per key.
  const converge = (...events: [string, Facet][]): Replica => {
    const r: Replica = new Map();
    for (const [key, f] of events) if (!r.has(key) || compareVersion(r.get(key)!.version, f.version) < 0) r.set(key, f);
    return r;
  };
  const live = (r: Replica, key: string) => (r.get(key)?.op === SyncOp.UPSERT ? r.get(key)!.value : undefined);
  const occ = (occId: string) => ({
    head: (r: Replica) => live(r, occFacetKey(occId, 'head'))?.head_id as string | undefined,
    status: (r: Replica) => live(r, occFacetKey(occId, 'status'))?.status as string | undefined,
    // THE DISPLAY RULE: the filed collection if it exists and its kind is the copy's status, else {status}/default.
    shownIn: (r: Replica) => {
      const status = live(r, occFacetKey(occId, 'status'))?.status as string;
      const ref = contract.parseCollectionRef((live(r, occFacetKey(occId, 'collection'))?.collection as string) ?? '');
      const exists = ref !== undefined && (ref.collId === 'default' || live(r, collNameKey(ref.kind, ref.collId)) !== undefined);
      return exists && ref.kind === status ? collectionRef(ref.kind, ref.collId) : collectionRef(status as never, 'default');
    },
  });
  // Live copies of a card: a live status and a head among requested_as.
  const copies = (r: Replica, occIds: string[], requestedAs: string[]) =>
    occIds.filter((o) => occ(o).status(r) !== undefined && requestedAs.includes(occ(o).head(r) ?? ''));
  const O1 = '00000000-0000-4000-8000-000000000001';
  const O2 = '00000000-0000-4000-8000-000000000002';
  const O3 = '00000000-0000-4000-8000-000000000003';
  const C2027 = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';

  it('keeps an arrival when a stale device re-files the copy within its old kind at a higher version (the O3-H revert)', () => {
    const base = [
      put({ family: 'occ/head', occId: O1 }, 0, DEVICE_A, { head_id: HEAD }),
      put({ family: 'coll/name', collKind: 'ordered', collId: C2027 }, 0, DEVICE_A, { name: '2027 preorders' }),
    ];
    // Desktop marks it arrived (status + filing in one batch); the phone, offline, files it into an ordered collection later.
    const arrived = put({ family: 'occ/status', occId: O1 }, 5, DEVICE_A, { status: 'owned' });
    const arrivedFiling = put({ family: 'occ/collection', occId: O1 }, 5, DEVICE_A, { collection: 'owned/default' });
    const staleRefile = put({ family: 'occ/collection', occId: O1 }, 9, DEVICE_B, { collection: `ordered/${C2027}` });
    for (const order of [[arrived, arrivedFiling, staleRefile], [staleRefile, arrivedFiling, arrived]]) {
      const r = converge(...base, put({ family: 'occ/status', occId: O1 }, 1, DEVICE_A, { status: 'ordered' }), ...order);
      expect(occ(O1).status(r)).toBe('owned');
      expect(occ(O1).shownIn(r)).toBe('owned/default'); // a mismatched filing never moves the copy
    }
  });

  it('shows every live copy in exactly one collection, falling back to the default for a deleted or other-kind filing', () => {
    const r = converge(
      put({ family: 'occ/head', occId: O1 }, 0, DEVICE_A, { head_id: HEAD }),
      put({ family: 'occ/status', occId: O1 }, 0, DEVICE_A, { status: 'ordered' }),
      put({ family: 'occ/collection', occId: O1 }, 1, DEVICE_A, { collection: `ordered/${C2027}` }),
      put({ family: 'coll/name', collKind: 'ordered', collId: C2027 }, 0, DEVICE_A, { name: '2027 preorders' }),
    );
    expect(occ(O1).shownIn(r)).toBe(`ordered/${C2027}`);
    const deleted = converge(...r, put({ family: 'coll/name', collKind: 'ordered', collId: C2027 }, 2, DEVICE_B));
    expect(occ(O1).shownIn(deleted)).toBe('ordered/default');
    const undone = converge(...deleted, put({ family: 'coll/name', collKind: 'ordered', collId: C2027 }, 3, DEVICE_B, { name: '2027' }));
    expect(occ(O1).shownIn(undone)).toBe(`ordered/${C2027}`); // undo restores the filing with no copy write
  });

  it('counts copies, never a quantity field: ordered two from two shops, got one, want another', () => {
    const events = [O1, O2, O3].map((o) => put({ family: 'occ/head', occId: o }, 0, DEVICE_A, { head_id: HEAD }));
    const r = converge(
      ...events,
      put({ family: 'occ/status', occId: O1 }, 1, DEVICE_A, { status: 'owned' }),
      put({ family: 'occ/status', occId: O2 }, 1, DEVICE_A, { status: 'ordered' }),
      put({ family: 'occ/status', occId: O3 }, 1, DEVICE_B, { status: 'wished' }),
    );
    const byKind = (k: string) => copies(r, [O1, O2, O3], [HEAD]).filter((o) => occ(o).status(r) === k).length;
    expect([byKind('owned'), byKind('ordered'), byKind('wished')]).toEqual([1, 1, 1]);
  });

  it('keeps a removed copy\'s head, so undo restores it and a copy with no head is never counted', () => {
    const removed = converge(
      put({ family: 'occ/head', occId: O1 }, 0, DEVICE_A, { head_id: HEAD }),
      put({ family: 'occ/status', occId: O1 }, 0, DEVICE_A, { status: 'owned' }),
      put({ family: 'occ/status', occId: O1 }, 4, DEVICE_B),
    );
    expect(copies(removed, [O1], [HEAD])).toEqual([]);
    expect(occ(O1).head(removed)).toBe(HEAD);
    const undone = converge(...removed, put({ family: 'occ/status', occId: O1 }, 5, DEVICE_B, { status: 'owned' }));
    expect(copies(undone, [O1], [HEAD])).toEqual([O1]);
    const headless = converge(put({ family: 'occ/status', occId: O2 }, 0, DEVICE_A, { status: 'owned' }));
    expect(copies(headless, [O2], [HEAD])).toEqual([]);
  });

  it('sums the copies of a merged card over requested_as, with no status tiebreak', () => {
    const MERGED = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const r = converge(
      put({ family: 'occ/head', occId: O1 }, 0, DEVICE_A, { head_id: HEAD }),
      put({ family: 'occ/status', occId: O1 }, 0, DEVICE_A, { status: 'owned' }),
      put({ family: 'occ/head', occId: O2 }, 0, DEVICE_B, { head_id: MERGED }),
      put({ family: 'occ/status', occId: O2 }, 3, DEVICE_B, { status: 'wished' }),
    );
    expect(copies(r, [O1, O2], [HEAD, MERGED])).toEqual([O1, O2]);
    expect(copies(r, [O1, O2], [HEAD])).toEqual([O1]); // one call's card alone misses the other head
  });
});
