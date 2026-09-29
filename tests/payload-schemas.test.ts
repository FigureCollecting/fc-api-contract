import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DISPOSAL_REASONS,
  OCCURRENCE_STATUSES,
  SERVER_FACET_PAYLOAD_SCHEMAS,
  USER_FACET_PAYLOAD_SCHEMAS,
  parseUserFacetKey,
  type UserFacetFamily,
} from '../src/index.js';
import type { Json } from './support/server-model.js';
import { vectors } from './support/vectors.js';

type Family = UserFacetFamily | keyof typeof SERVER_FACET_PAYLOAD_SCHEMAS;
const PATHS: Record<Family, string> = { ...USER_FACET_PAYLOAD_SCHEMAS, ...SERVER_FACET_PAYLOAD_SCHEMAS };
const load = (family: Family) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${PATHS[family]}`, import.meta.url)), 'utf8')) as {
    $schema?: string;
    $id?: string;
    title?: string;
    required?: string[];
    properties?: Record<string, { enum?: unknown[] }>;
  };

const ajv = new Ajv2020({ strict: true, allErrors: true });
const compiled = new Map<Family, ReturnType<typeof ajv.compile>>();
const validator = (family: Family) => {
  expect(PATHS[family], `${family} has a schema`).toBeDefined();
  if (!compiled.has(family)) compiled.set(family, ajv.compile(load(family)));
  return compiled.get(family)!;
};

const DISPLAY = { edited_at: '2026-09-14T06:29:58.500-05:00', tz: 'America/Chicago' };
const UUID = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
const USER = Object.keys(USER_FACET_PAYLOAD_SCHEMAS) as UserFacetFamily[];
const ALL = Object.keys(PATHS) as Family[];
const VERSION = '2026-09-27T01:30:00.123456Z#0000000007#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
const UUID2 = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7';
const ZERO = { base: 0, app: 0, mfc: 0 };
// import.proto 6: a figure item, here a conflict (app 9, MFC 7 on a score of 5) with what keep and take would write.
const CARD = {
  rev: 'I2:owned1',
  kind: 'conflict',
  import: 2,
  counts: { owned: { base: 1, app: 1, mfc: 1 }, ordered: ZERO, wished: ZERO },
  fields: { score: { base: 5, app: 9, mfc: 7, status: 'conflict' }, note: { status: 'nochange' }, wishability: { status: 'nochange' } },
  copies: [{ occ: UUID2, status: 'owned', tracked: true }],
  mfc_rows: [{ mfc_id: '1144', kind: 'owned', count: 1 }],
  preview: { keep: { copies: [], fields: [] }, take: { copies: [], fields: [{ head_id: UUID, field: 'score', score: 7 }] } },
};

describe('payload schemas', () => {
  it.each(ALL)('%s compiles under draft 2020-12 strict mode', (family) => {
    const schema = load(family);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(`https://figurecollecting.com/schemas/coordinator/v1/${PATHS[family].slice('schemas/'.length)}`);
    expect(() => validator(family)).not.toThrow();
  });

  it('ships exactly the mapped schemas, the retired holding ones gone', () => {
    const files = readdirSync(fileURLToPath(new URL('../schemas', import.meta.url))).sort();
    expect(files).toEqual(Object.values(PATHS).map((p) => p.slice('schemas/'.length)).sort());
  });

  it.each(USER)('%s requires the display fields and names its key in the title', (family) => {
    const schema = load(family);
    expect(schema.required).toEqual(expect.arrayContaining(['edited_at', 'tz']));
    expect(schema.title).toMatch(/payload$/);
  });

  it('keeps the status enum and the disposal reasons in step with the vocabulary', () => {
    expect(load('occ/status').properties!.status!.enum).toEqual([...OCCURRENCE_STATUSES]);
    expect(load('occ/disposal').properties!.reason!.enum).toEqual([...DISPOSAL_REASONS]);
  });

  it.each([
    ['occ/head', { head_id: UUID, ...DISPLAY }],
    ['occ/status', { status: 'owned', ...DISPLAY }],
    ['occ/status', { status: 'former', edited_at: '2026-09-14T11:29:58Z', tz: 'UTC' }],
    ['occ/collection', { collection: 'owned/default', ...DISPLAY }],
    ['occ/collection', { collection: `ordered/${UUID}`, ...DISPLAY }],
    ['occ/disposal', { reason: 'sold', ...DISPLAY }],
    ['occ/disposal', { reason: 'traded', on: '2026-09-01', note: 'for the Rei 1/7', counterparty: 'a friend at AnimeNYC', price: { amount: '12800', currency: 'JPY' }, ...DISPLAY }],
    ['occ/disposal', { reason: 'sold', price: { amount: '149.99', currency: 'USD' }, ...DISPLAY }],
    ['occ/disposal', { reason: 'gifted', price: { amount: '0', currency: 'USD' }, ...DISPLAY }],
    ['occ/disposal', { reason: 'stolen', note: '箱ごと盗まれた', ...DISPLAY }],
    ['occ/tag', { ...DISPLAY }],
    ['uf/score', { score: 1, ...DISPLAY }],
    ['uf/score', { score: 10, ...DISPLAY }],
    ['uf/note', { note: '', ...DISPLAY }],
    ['uf/note', { note: 'box damaged, figure fine — 箱に傷', ...DISPLAY }],
    ['uf/note', { note: '🎎'.repeat(10_000), ...DISPLAY }], // 10,000 code points, 20,000 UTF-16 units
    ['uf/wishability', { wishability: 1, ...DISPLAY }],
    ['uf/wishability', { wishability: 5, ...DISPLAY }],
    ['uf/tag', { ...DISPLAY }],
    ['uf/ktag', { ...DISPLAY }],
    ['coll/name', { name: 'Owned statues', ...DISPLAY }],
    ['coll/name', { name: '🎎'.repeat(100), ...DISPLAY }],
    ['tag/name', { name: 'unlicensed_nsfw_statues', ...DISPLAY }],
    ['occ/status', { status: 'owned', edited_at: '2026-09-14T23:59:59.999+14:00', tz: 'Pacific/Kiritimati' }],
    ['occ/origin', { site: 'mfc', native_id: '1144', ordinal: 1 }],
    ['occ/origin', { site: 'mfc', native_id: '3743689', ordinal: 99 }],
    ['res/answer', { item: 'figure', rev: 'I2:owned1', choice: 'keep', ...DISPLAY }],
    ['res/answer', { item: 'figure', rev: 'I2:owned1', choice: 'per_copy', copies: [{ occ: UUID2, status: 'former' }, { occ: UUID, status: 'removed' }], fields: { score: 'mfc' }, ...DISPLAY }],
    ['res/answer', { item: 'held', rev: 'H:5', choice: 'take', ...DISPLAY }],
    ['res/answer', { item: 'change', rev: 'C3:x', choice: 'undo', ...DISPLAY }],
    ['res/answer', { item: 'align', rev: 'A3:x', choice: 'dismiss', ...DISPLAY }],
    ['pref/import', { import_policy: 'ASK', ...DISPLAY }],
    ['pref/import', { import_policy: 'FAVOR_MFC', disposition_list: '206369', ...DISPLAY }],
    ['imp/figure', CARD],
    ['imp/figure', { ...CARD, kind: 'divergence', fields: { score: { status: 'nochange' }, note: { app: 'mine', mfc: 'theirs', status: 'nochange' }, wishability: { status: 'nochange' } } }],
    ['imp/held', { rev: 'H:5', held: [{ key: `occ/${UUID2}/status`, payload: JSON.stringify({ status: 'former', ...DISPLAY }), version: VERSION, reason: 'late_after_knowing' }] }],
    ['imp/held', { rev: 'H:6', held: [{ key: `occ/${UUID2}/status`, version: VERSION, reason: 'after_answer' }] }], // a held tombstone
    ['imp/held', { rev: 'H:7', held: [{ key: `occ/${UUID2}/tag/${UUID}`, payload: JSON.stringify(DISPLAY), version: VERSION, reason: 'made_on_revised_result' }], more: 6 }], // more held than listed
    ['imp/change', { rev: 'C2:x', kind: 'applied', import: 2, writes: { copies: [{ occ: UUID2, status: 'removed' }], fields: [] }, undo: { copies: [{ occ: UUID2, status: 'owned' }], fields: [] } }],
    ['imp/change', { rev: 'C2:z', kind: 'applied', import: 2, writes: { copies: [{ occ: UUID2, origin: { site: 'mfc', native_id: '1144', ordinal: 2 }, head_id: UUID, status: 'owned' }], fields: [] }, undo: { copies: [{ occ: UUID2, status: 'removed' }], fields: [] } }],
    ['imp/change', { rev: 'C2:y', kind: 'favor_mfc', import: 2, writes: { copies: [], fields: [{ head_id: UUID, field: 'score', score: 7 }] }, undo: { copies: [], fields: [{ head_id: UUID, field: 'score', score: 9 }] } }],
    ['imp/align', { rev: 'A:x', actions: [{ mfc_id: '1144', count: { now: 2, should: 1 }, add_to_list: '206369' }] }],
    ['imp/align', { rev: 'A:y', actions: [{ mfc_id: '777', status: { now: 'owned' } }, { mfc_id: '1144', score: { now: 7, should: 9 }, note: { should: 'box damaged' } }] }],
    ['imp/import', { import: 1, export_date: '2026-09-09' }],
  ] as const)('%s accepts %o', (family, payload) => {
    const v = validator(family);
    expect(v(payload), JSON.stringify(v.errors)).toBe(true);
  });

  it.each([
    ['occ/head', 'an uppercase head id', { head_id: UUID.toUpperCase(), ...DISPLAY }],
    ['occ/head', 'no head id', { ...DISPLAY }],
    ['occ/status', 'no tz', { status: 'owned', edited_at: DISPLAY.edited_at }],
    ['occ/status', 'no edited_at', { status: 'owned', tz: DISPLAY.tz }],
    ['occ/status', 'a status outside the register', { status: 'preordered', ...DISPLAY }],
    ['occ/status', 'a quantity', { status: 'owned', count: 2, ...DISPLAY }],
    ['occ/status', 'the head in the status payload (design A, not chosen)', { status: 'owned', head_id: UUID, ...DISPLAY }],
    ['occ/status', 'a date without a time', { status: 'owned', edited_at: '2026-09-14', tz: DISPLAY.tz }],
    ['occ/status', 'an empty tz', { status: 'owned', edited_at: DISPLAY.edited_at, tz: '' }],
    ['occ/collection', 'a bare kind', { collection: 'owned', ...DISPLAY }],
    ['occ/collection', 'an unknown kind', { collection: 'custom/default', ...DISPLAY }],
    ['occ/collection', 'an uppercase default', { collection: 'owned/DEFAULT', ...DISPLAY }],
    ['occ/collection', 'a collection name instead of an id', { collection: 'owned/statues', ...DISPLAY }],
    ['occ/disposal', 'no reason', { note: 'sold it', ...DISPLAY }],
    ['occ/disposal', 'an unknown reason', { reason: 'broken', ...DISPLAY }],
    ['occ/disposal', 'a date with a time', { reason: 'sold', on: '2026-09-01T00:00:00Z', ...DISPLAY }],
    ['occ/disposal', 'month 13', { reason: 'sold', on: '2026-13-01', ...DISPLAY }],
    ['occ/disposal', 'an empty note (omit it instead)', { reason: 'sold', note: '', ...DISPLAY }],
    ['occ/disposal', 'a note past 2,000 code points', { reason: 'sold', note: 'x'.repeat(2001), ...DISPLAY }],
    ['occ/disposal', 'a counterparty past 200 code points', { reason: 'sold', counterparty: 'x'.repeat(201), ...DISPLAY }],
    ['occ/disposal', 'a price as a number', { reason: 'sold', price: { amount: 149.99, currency: 'USD' }, ...DISPLAY }],
    ['occ/disposal', 'a price with no currency', { reason: 'sold', price: { amount: '149.99' }, ...DISPLAY }],
    ['occ/disposal', 'a lowercase currency', { reason: 'sold', price: { amount: '149.99', currency: 'usd' }, ...DISPLAY }],
    ['occ/disposal', 'a negative price', { reason: 'sold', price: { amount: '-1', currency: 'USD' }, ...DISPLAY }],
    ['occ/disposal', 'a leading zero', { reason: 'sold', price: { amount: '0149', currency: 'USD' }, ...DISPLAY }],
    ['occ/disposal', 'five decimals', { reason: 'sold', price: { amount: '1.00001', currency: 'USD' }, ...DISPLAY }],
    ['occ/disposal', 'thirteen integer digits', { reason: 'sold', price: { amount: '1234567890123', currency: 'USD' }, ...DISPLAY }],
    ['occ/disposal', 'a price with a property', { reason: 'sold', price: { amount: '1', currency: 'USD', fx: '1' }, ...DISPLAY }],
    ['occ/tag', 'a property', { color: 'red', ...DISPLAY }],
    ['uf/score', 'zero (remove the score instead)', { score: 0, ...DISPLAY }],
    ['uf/score', 'past 10', { score: 11, ...DISPLAY }],
    ['uf/note', 'a note past 10,000 characters', { note: 'x'.repeat(10_001), ...DISPLAY }],
    ['uf/note', 'no note', { ...DISPLAY }],
    ['uf/note', 'a note past 10,000 code points', { note: '🎎'.repeat(10_001), ...DISPLAY }],
    ['uf/wishability', 'zero (MFC\'s unrated: write nothing)', { wishability: 0, ...DISPLAY }],
    ['uf/wishability', 'past 5', { wishability: 6, ...DISPLAY }],
    ['uf/wishability', 'a fraction', { wishability: 2.5, ...DISPLAY }],
    ['coll/name', 'an empty name', { name: '', ...DISPLAY }],
    ['coll/name', 'a name past 100 code points', { name: 'x'.repeat(101), ...DISPLAY }],
    ['coll/name', 'a visibility (a later key, never a property)', { name: 'Statues', visibility: 'public', ...DISPLAY }],
    ['tag/name', 'an empty name', { name: '', ...DISPLAY }],
    ['tag/name', 'a color (a later key, never a property)', { name: 'red', color: '#ff0000', ...DISPLAY }],
    ['occ/origin', 'an ordinal of 0', { site: 'mfc', native_id: '1144', ordinal: 0 }],
    ['occ/origin', 'an ordinal past 99', { site: 'mfc', native_id: '1144', ordinal: 100 }],
    ['occ/origin', 'an uppercase site', { site: 'MFC', native_id: '1144', ordinal: 1 }],
    ['occ/origin', 'a native id with a space', { site: 'mfc', native_id: '11 44', ordinal: 1 }],
    ['occ/origin', 'display fields (a server write)', { site: 'mfc', native_id: '1144', ordinal: 1, ...DISPLAY }],
    ['res/answer', 'no rev', { item: 'figure', choice: 'keep', ...DISPLAY }],
    ['res/answer', 'no item (a rev alone can name any of the figure\'s items)', { rev: 'I2:x', choice: 'keep', ...DISPLAY }],
    ['res/answer', 'an unknown item', { item: 'import', rev: 'I2:x', choice: 'keep', ...DISPLAY }],
    ['res/answer', 'an unknown choice', { item: 'figure', rev: 'I2:x', choice: 'maybe', ...DISPLAY }],
    ['res/answer', 'copies with another choice', { item: 'figure', rev: 'I2:x', choice: 'keep', copies: [{ occ: UUID2, status: 'owned' }], ...DISPLAY }],
    ['res/answer', 'choice per_copy with no copies', { item: 'figure', rev: 'I2:x', choice: 'per_copy', ...DISPLAY }],
    ['res/answer', 'a copy status outside the answer', { item: 'figure', rev: 'I2:x', choice: 'per_copy', copies: [{ occ: UUID2, status: 'lost' }], ...DISPLAY }],
    ['res/answer', 'an uppercase occ id', { item: 'figure', rev: 'I2:x', choice: 'per_copy', copies: [{ occ: UUID2.toUpperCase(), status: 'owned' }], ...DISPLAY }],
    ['res/answer', 'a field side other than app or mfc', { item: 'figure', rev: 'I2:x', choice: 'per_copy', copies: [], fields: { score: 'both' }, ...DISPLAY }],
    ['res/answer', 'a rev with a space', { item: 'figure', rev: 'I2 x', choice: 'keep', ...DISPLAY }],
    ['pref/import', 'an unknown import policy', { import_policy: 'FAVOR_ME', ...DISPLAY }],
    ['pref/import', 'no import policy', { ...DISPLAY }],
    ['pref/import', 'an mfc_only preference (0.3.0 applies and lists every change only MFC made; there is no HOLD)', { import_policy: 'ASK', mfc_only: 'HOLD', ...DISPLAY }],
    ['pref/import', 'a list id with a leading zero', { import_policy: 'ASK', disposition_list: '0206369', ...DISPLAY }],
    ['imp/figure', 'an unknown kind', { ...CARD, kind: 'maybe' }],
    ['imp/figure', 'a held MFC change (no such item in 0.3.0)', { ...CARD, kind: 'mfc_change' }],
    ['imp/figure', 'no wished counts', { ...CARD, counts: { owned: ZERO, ordered: ZERO } }],
    ['imp/figure', 'an uppercase copy id', { ...CARD, copies: [{ occ: UUID2.toUpperCase(), tracked: true }] }],
    ['imp/figure', 'import 0', { ...CARD, import: 0 }],
    ['imp/figure', 'a Count past 99 on an MFC row', { ...CARD, mfc_rows: [{ mfc_id: '1144', kind: 'owned', count: 100 }] }],
    ['imp/figure', 'display fields (a server write)', { ...CARD, ...DISPLAY }],
    ['imp/held', 'an unknown reason', { rev: 'H:5', held: [{ key: `occ/${UUID2}/status`, version: VERSION, reason: 'late' }] }],
    ['imp/held', 'a bare-instant version (an edit always has the full form)', { rev: 'H:5', held: [{ key: `occ/${UUID2}/status`, version: '2026-09-27T01:30:00.123456Z', reason: 'after_answer' }] }],
    ['imp/held', 'more 0 (absent when the card lists every held edit)', { rev: 'H:5', held: [{ key: `occ/${UUID2}/status`, version: VERSION, reason: 'after_answer' }], more: 0 }],
    ['imp/held', 'more than 16 edits listed', { rev: 'H:5', held: Array.from({ length: 17 }, () => ({ key: `occ/${UUID2}/status`, version: VERSION, reason: 'after_answer' })) }],
    ['imp/change', 'an unknown kind', { rev: 'C2:x', kind: 'favor', import: 2, writes: { copies: [], fields: [] }, undo: { copies: [], fields: [] } }],
    ['imp/change', 'a copy status outside the register', { rev: 'C2:x', kind: 'applied', import: 2, writes: { copies: [{ occ: UUID2, status: 'lost' }], fields: [] }, undo: { copies: [], fields: [] } }],
    ['imp/change', 'a field write of a field the import never writes', { rev: 'C2:x', kind: 'applied', import: 2, writes: { copies: [], fields: [{ head_id: UUID, field: 'price' }] }, undo: { copies: [], fields: [] } }],
    ['imp/change', 'no undo', { rev: 'C2:x', kind: 'applied', import: 2, writes: { copies: [], fields: [] } }],
    ['imp/align', 'a Count past 99', { rev: 'A:x', actions: [{ mfc_id: '1144', count: { now: 2, should: 100 } }] }],
    ['imp/align', 'a list id that is not digits', { rev: 'A:x', actions: [{ mfc_id: '1144', add_to_list: 'sold' }] }],
    ['imp/align', 'a status MFC cannot hold', { rev: 'A:x', actions: [{ mfc_id: '1144', status: { now: 'former' } }] }],
    ['imp/align', 'an MFC id with a leading zero', { rev: 'A:x', actions: [{ mfc_id: '01144', count: { now: 2, should: 1 } }] }],
    ['imp/import', 'import 0', { import: 0, export_date: '2026-09-09' }],
    ['imp/import', 'an export date with a time', { import: 1, export_date: '2026-09-09T00:00:00Z' }],
  ] as const)('%s rejects a payload with %s', (family, _why, payload) => {
    expect(validator(family)(payload)).toBe(false);
  });

  const BODY: Record<UserFacetFamily, object> = {
    'occ/head': { head_id: UUID },
    'occ/status': { status: 'owned' },
    'occ/collection': { collection: 'owned/default' },
    'occ/disposal': { reason: 'sold' },
    'occ/tag': {},
    'uf/score': { score: 1 },
    'uf/note': { note: '' },
    'uf/wishability': { wishability: 3 },
    'uf/tag': {},
    'uf/ktag': {},
    'coll/name': { name: 'Statues' },
    'tag/name': { name: 'red' },
    'res/answer': { item: 'figure', rev: 'D:1', choice: 'keep' },
    'pref/import': { import_policy: 'ASK' },
  };
  const BAD_DISPLAY = [
    ['month 13', { edited_at: '2026-13-14T06:29:58-05:00', tz: DISPLAY.tz }],
    ['day 32', { edited_at: '2026-09-32T06:29:58-05:00', tz: DISPLAY.tz }],
    ['hour 24', { edited_at: '2026-09-14T24:00:00Z', tz: DISPLAY.tz }],
    ['an offset past 18 hours', { edited_at: '2026-09-14T06:29:58+19:00', tz: DISPLAY.tz }],
    ['a tz with a space', { edited_at: DISPLAY.edited_at, tz: 'America/New York' }],
    ['a tz with an empty segment', { edited_at: DISPLAY.edited_at, tz: 'America//Chicago' }],
  ] as const;
  it.each(USER.flatMap((family) => BAD_DISPLAY.map(([why, d]) => [family, why, d] as const)))(
    '%s rejects display fields with %s',
    (family, _why, display) => {
      expect(validator(family)({ ...BODY[family], ...display })).toBe(false);
      expect(validator(family)({ ...BODY[family], ...DISPLAY })).toBe(true);
    },
  );

  it.each(USER)('%s is closed: any extra property is invalid', (family) => {
    expect(validator(family)({ ...BODY[family], ...DISPLAY, extra: 1 })).toBe(false);
  });
});

// golden/import-vectors.json writes abstract payloads (its $comment: ids, heads and values are abstract). Lifted to the
// wire, each abstract id a uuid and the display fields added, every payload a golden step sends must validate against
// its closed schema, so an implementation that validates what it is pushed can run every golden as written.
describe('golden payloads', () => {
  const uuidOf = (name: string) => {
    const h = createHash('sha256').update(name).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const liftKey = (key: string) => {
    const p = key.split('/');
    if (p[0] === 'occ' || p[0] === 'uf' || p[0] === 'res') p[p[0] === 'res' ? 2 : 1] = uuidOf(p[p[0] === 'res' ? 2 : 1]!);
    if ((p[0] === 'occ' || p[0] === 'uf') && p[2] === 'tag') p[3] = uuidOf(p[3]!);
    return p.join('/');
  };
  const liftValue = (family: UserFacetFamily, v: Json): unknown => {
    const body = (b: object) => ({ ...b, ...DISPLAY });
    if (family === 'occ/status') return body({ status: v });
    if (family === 'occ/head') return body({ head_id: uuidOf(String(v)) });
    if (family === 'occ/collection') {
      const [kind, id] = String(v).split('/');
      return body({ collection: `${kind}/${id === 'default' ? id : uuidOf(id!)}` });
    }
    if (family === 'uf/score' || family === 'uf/note' || family === 'uf/wishability') return body({ [family.slice(3)]: v });
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? body(v) : v;
  };
  const steps = [
    ...vectors.serverScenarios.map((c) => [c.id, c.steps] as const),
    ...vectors.review.map((c) => [c.name, c.steps] as const),
  ];

  it('every edit and answer a golden pushes validates against its closed schema once lifted to the wire', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const [where, ss] of steps)
      for (const st of ss) {
        if (st.op === 'edit') {
          const parsed = parseUserFacetKey(liftKey(st.key));
          if (parsed === undefined) {
            bad.push(`${where}: ${st.key} is no user-owned key`);
            continue;
          }
          if (st.value === null) continue; // a tombstone carries no payload
          checked++;
          const payload = liftValue(parsed.family as UserFacetFamily, st.value);
          if (!validator(parsed.family as Family)(payload)) bad.push(`${where}: ${st.key} ${JSON.stringify(st.value)}`);
        } else if (st.op === 'resolve') {
          checked++;
          const copies = st.copies === undefined ? {} : { copies: Object.entries(st.copies).map(([occ, status]) => ({ occ: uuidOf(occ), status })) };
          const payload = { item: st.item ?? 'figure', rev: 'I2:x', choice: st.choice, ...copies, ...(st.fields === undefined ? {} : { fields: st.fields }), ...DISPLAY };
          if (parseUserFacetKey(liftKey(`res/mfc/${st.fig}`)) === undefined || !validator('res/answer')(payload)) bad.push(`${where}: answer ${JSON.stringify(payload)}`);
        }
      }
    expect(checked).toBeGreaterThan(300);
    expect(bad).toEqual([]);
  });
});
