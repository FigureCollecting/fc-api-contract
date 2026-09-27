import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  DISPOSAL_REASONS,
  OCCURRENCE_STATUSES,
  SERVER_FACET_PAYLOAD_SCHEMAS,
  USER_FACET_PAYLOAD_SCHEMAS,
  type UserFacetFamily,
} from '../src/index.js';

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
  if (!compiled.has(family)) compiled.set(family, ajv.compile(load(family)));
  return compiled.get(family)!;
};

const DISPLAY = { edited_at: '2026-09-14T06:29:58.500-05:00', tz: 'America/Chicago' };
const UUID = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
const USER = Object.keys(USER_FACET_PAYLOAD_SCHEMAS) as UserFacetFamily[];
const ALL = Object.keys(PATHS) as Family[];
const VERSION = '2026-09-27T01:30:00.123456Z#0000000007#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';

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
    ['imp/conflict', { against: VERSION, export_date: '2026-09-09' }],
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
    ['imp/conflict', 'a bare-instant against (a user facet always has the full form)', { against: '2026-09-27T01:30:00.123456Z', export_date: '2026-09-09' }],
    ['imp/conflict', 'no export date', { against: VERSION }],
    ['imp/conflict', 'an export date with a time', { against: VERSION, export_date: '2026-09-09T00:00:00Z' }],
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
