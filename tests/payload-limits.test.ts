import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { create, toBinary, toJsonString } from '@bufbuild/protobuf';
import {
  MAX_PAYLOAD_BYTES,
  PushRequestSchema,
  SERVER_FACET_PAYLOAD_SCHEMAS,
  SyncEventSchema,
  SyncOp,
  USER_FACET_PAYLOAD_SCHEMAS,
  ufFacetKey,
  type SyncEvent,
  type UserFacetFamily,
} from '../src/index.js';
import { maxJsonBytes, patternSpan, type Schema } from './support/max-json-bytes.js';

type ServerFamily = keyof typeof SERVER_FACET_PAYLOAD_SCHEMAS;
const PATHS: Record<UserFacetFamily | ServerFamily, string> = { ...USER_FACET_PAYLOAD_SCHEMAS, ...SERVER_FACET_PAYLOAD_SCHEMAS };
const load = (family: UserFacetFamily | ServerFamily) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${PATHS[family]}`, import.meta.url)), 'utf8')) as Schema;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');
const bytes = (payload: object) => utf8(JSON.stringify(payload));

// The longest edited_at the pattern admits (nine fractional digits, an offset) and the longest tz.
const WIDEST = { edited_at: '2026-09-14T11:30:00.123456789+18:00', tz: `A${'a'.repeat(63)}` };
const UUID = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
// U+0001 is written by JSON.stringify as \u0001: six bytes, the most any one code point costs.
const VERSION = '2026-09-27T01:30:00.123456Z#0000000007#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
const NOTE = '\u0001'.repeat(10_000);
const ORIGIN = { site: `a${'-'.repeat(31)}`, native_id: '~'.repeat(64), ordinal: 99 };
const COUNT3 = { base: 9999, app: 9999, mfc: 9999 };
// The import's typed writes (a figure item's preview, a change entry and its undo), each list at its widest.
const WRITES = {
  copies: Array.from({ length: 500 }, () => ({ occ: UUID, status: 'removed', head_id: UUID, collection: `ordered/${UUID}`, origin: ORIGIN })),
  fields: Array.from({ length: 24 }, () => ({ head_id: UUID, field: 'wishability', score: 10, note: NOTE, wishability: 5 })),
};
const WORST: Record<UserFacetFamily | ServerFamily, object> = {
  'occ/head': { head_id: UUID, ...WIDEST },
  'occ/status': { status: 'ordered', ...WIDEST },
  'occ/collection': { collection: `ordered/${UUID}`, ...WIDEST },
  'occ/disposal': {
    reason: 'damaged',
    on: '2026-09-27',
    note: '\u0001'.repeat(2_000),
    counterparty: '\u0001'.repeat(200),
    price: { amount: '999999999999.9999', currency: 'USD' },
    ...WIDEST,
  },
  'occ/tag': { ...WIDEST },
  'uf/score': { score: 10, ...WIDEST },
  'uf/note': { note: '\u0001'.repeat(10_000), ...WIDEST },
  'uf/wishability': { wishability: 5, ...WIDEST },
  'uf/tag': { ...WIDEST },
  'uf/ktag': { ...WIDEST },
  'coll/name': { name: '\u0001'.repeat(100), ...WIDEST },
  'tag/name': { name: '\u0001'.repeat(100), ...WIDEST },
  'res/answer': {
    item: 'figure',
    rev: 'A'.repeat(128),
    choice: 'per_copy',
    copies: Array.from({ length: 500 }, () => ({ occ: UUID, status: 'ordered' })),
    fields: { score: 'app', note: 'mfc', wishability: 'app' },
    ...WIDEST,
  },
  'pref/import': { import_policy: 'FAVOR_APP', mfc_only: 'APPLY_AND_LIST', disposition_list: '9'.repeat(20), ...WIDEST },
  'occ/origin': ORIGIN,
  'imp/figure': {
    rev: 'A'.repeat(128),
    kind: 'divergence',
    import: 2_147_483_647,
    counts: { owned: COUNT3, ordered: COUNT3, wished: COUNT3 },
    fields: {
      score: { base: 10, app: 10, mfc: 10, status: 'conflict' },
      note: { base: NOTE, app: NOTE, mfc: NOTE, status: 'conflict' },
      wishability: { base: 5, app: 5, mfc: 5, status: 'conflict' },
    },
    copies: Array.from({ length: 1000 }, () => ({ occ: UUID, status: 'ordered', tracked: false })),
    mfc_rows: Array.from({ length: 64 }, () => ({ mfc_id: '9'.repeat(64), kind: 'ordered', count: 99 })),
    preview: { keep: WRITES, take: WRITES },
  },
  'imp/held': {
    rev: 'A'.repeat(128),
    held: Array.from({ length: 16 }, () => ({ key: 'a'.repeat(128), payload: '\u0001'.repeat(65_536), version: VERSION, reason: 'made_on_revised_result' })),
    more: 2_147_483_647,
  },
  'imp/change': { rev: 'A'.repeat(128), kind: 'favor_app', import: 2_147_483_647, writes: WRITES, undo: WRITES },
  'imp/align': {
    rev: 'A'.repeat(128),
    actions: Array.from({ length: 64 }, () => ({
      mfc_id: '9'.repeat(64),
      status: { now: 'ordered', should: 'ordered' },
      count: { now: 99, should: 99 },
      score: { now: 10, should: 10 },
      note: { now: NOTE, should: NOTE },
      wishability: { now: 5, should: 5 },
      add_to_list: '9'.repeat(20),
    })),
  },
  'imp/import': { import: 2_147_483_647, export_date: '2026-09-09' },
};
const FIELDS = Object.keys(USER_FACET_PAYLOAD_SCHEMAS) as UserFacetFamily[];
const SERVER = Object.keys(SERVER_FACET_PAYLOAD_SCHEMAS) as ServerFamily[];
const ALL = [...FIELDS, ...SERVER];

describe('MAX_PAYLOAD_BYTES', () => {
  it('is 64 KiB', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(65_536);
  });

  it('costs no code point more than six bytes as JSON.stringify writes it, lone surrogates included', () => {
    let max = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const b = Buffer.byteLength(JSON.stringify(String.fromCodePoint(cp)), 'utf8') - 2;
      if (b > max) max = b;
    }
    expect(max).toBe(6);
  });

  it.each(FIELDS)('%s: no payload its schema admits is over the cap', (field) => {
    expect(maxJsonBytes(load(field))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('keeps the uf note the largest user payload, so rule 3\'s 60,133-byte bound still holds', () => {
    const sizes = FIELDS.map((f) => maxJsonBytes(load(f)));
    expect(Math.max(...sizes)).toBe(60_133);
    expect(FIELDS.filter((f) => maxJsonBytes(load(f)) === 60_133)).toEqual(['uf/note']);
  });

  it.each(ALL)('%s: a schema-valid payload reaches that bound, so the bound is exact', (field) => {
    const v = ajv.compile(load(field));
    expect(v(WORST[field]), JSON.stringify(v.errors)).toBe(true);
    expect(bytes(WORST[field])).toBe(maxJsonBytes(load(field)));
  });

  it('puts the largest note at 60,133 bytes', () => {
    expect(bytes(WORST['uf/note'])).toBe(60_133);
    expect(bytes({ ...WORST['uf/note'], note: '\ud800'.repeat(10_000) })).toBe(60_133);
  });

  it.each(FIELDS)('%s: its schema states that largest size and the cap', (field) => {
    const description = load(field).description ?? '';
    const n = maxJsonBytes(load(field)).toLocaleString('en-US');
    expect(description).toContain(`at most ${n} bytes of UTF-8 as JSON.stringify writes it`);
    expect(description).toContain(`MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES.toLocaleString('en-US')})`);
  });

  it.each(SERVER)('%s: its schema states its largest size and that a Push of it is REJECTED', (field) => {
    const description = load(field).description ?? '';
    const n = maxJsonBytes(load(field)).toLocaleString('en-US');
    expect(description).toContain(`at most ${n} bytes of UTF-8 as JSON.stringify writes it`);
    expect(description).toContain('Server-owned: a Push of this key is REJECTED facet_key_not_user_owned');
  });
});

describe('maxJsonBytes', () => {
  const obj = (properties: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, properties });
  const note = load('uf/note');

  it('is unbounded for an optional property nothing bounds, or an open object', () => {
    expect(maxJsonBytes(obj({ ...note.properties, extra: { type: 'string' } }))).toBe(Infinity);
    expect(maxJsonBytes({ ...note, additionalProperties: undefined })).toBe(Infinity);
    expect(maxJsonBytes({ type: 'integer', minimum: 1 })).toBe(Infinity);
    expect(maxJsonBytes({ type: 'number', minimum: 0, maximum: 1 })).toBe(Infinity);
  });

  it('goes over the cap when a string bound is widened', () => {
    const tz = { ...note.properties!.tz!, maxLength: 20_000 };
    expect(maxJsonBytes(obj({ ...note.properties, tz }))).toBe(80_069);
    const wide = { ...note.properties!.note!, maxLength: 11_000 };
    expect(maxJsonBytes(obj({ ...note.properties, note: wide }))).toBeGreaterThan(MAX_PAYLOAD_BYTES);
  });

  it('counts integers by their widest bound and enums by their longest member', () => {
    expect(maxJsonBytes({ type: 'integer', minimum: -100, maximum: 99 })).toBe(4);
    expect(maxJsonBytes({ enum: ['a', 'owned', 7] })).toBe(7);
    expect(maxJsonBytes(obj({}))).toBe(2);
    expect(maxJsonBytes({ type: 'object', additionalProperties: false })).toBe(2);
  });

  it('bounds a string by the tighter of maxLength and pattern, at one byte a character only for JSON-safe ASCII', () => {
    expect(maxJsonBytes({ type: 'string', maxLength: 3 })).toBe(2 + 18);
    expect(maxJsonBytes({ type: 'string', maxLength: 3, pattern: '^[a-z]*$' })).toBe(2 + 3);
    expect(maxJsonBytes({ type: 'string', pattern: '^\\d{4}(-\\d{2})?$' })).toBe(2 + 7);
    expect(maxJsonBytes({ type: 'string', pattern: '^[!-~]{2}$' })).toBe(2 + 12);
    expect(maxJsonBytes({ type: 'string', pattern: '^[^a]{2}$' })).toBe(2 + 12);
    expect(maxJsonBytes({ type: 'string', pattern: '^.{2}$' })).toBe(2 + 12);
    expect(maxJsonBytes({ type: 'string', pattern: '^\\"\\.$' })).toBe(2 + 12);
    expect(maxJsonBytes({ type: 'string', pattern: '^(?:ab|c)[\\d_-]{0,3}$' })).toBe(2 + 5);
  });

  it('counts an array as its maxItems widest items, and a boolean as false; an unbounded array is unbounded', () => {
    expect(maxJsonBytes({ type: 'boolean' })).toBe(5);
    expect(maxJsonBytes({ type: 'array', maxItems: 3, items: { enum: ['ab'] } })).toBe(2 + 3 * 4 + 2);
    expect(maxJsonBytes({ type: 'array', maxItems: 0, items: { enum: ['ab'] } })).toBe(2);
    expect(maxJsonBytes({ type: 'array', items: { enum: ['ab'] } })).toBe(Infinity);
    expect(maxJsonBytes({ type: 'array', maxItems: 3 })).toBe(Infinity);
  });

  it('treats an unanchored, open-ended or top-level alternated pattern as unbounded', () => {
    for (const pattern of ['a{3}', '^a{3}', '^a+$', '^a*$', '^a{2,}$', '^a|b$', '^a\\$'])
      expect(maxJsonBytes({ type: 'string', pattern }), pattern).toBe(Infinity);
    expect(maxJsonBytes({ type: 'string', pattern: '^(a|bc)$' })).toBe(2 + 2);
    expect(maxJsonBytes({ type: 'string', pattern: '^(?:)*a$' })).toBe(2 + 1);
  });

  it('refuses a pattern construct it does not model instead of guessing', () => {
    for (const pattern of ['^\\s$', '^a{x}$', '^[a$', '^(a$', '^a)$', '^[a-\\d]$', '^a^b$', '^?$'])
      expect(() => patternSpan(pattern), pattern).toThrow(SyntaxError);
  });
});

describe('Push request size', () => {
  // A 71-character HLC version and the shortest user key: every conforming event carries at least these.
  const version = '2026-09-14T11:30:00.123456Z#0000000000#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
  const key = ufFacetKey('01234567-89ab-cdef-0123-456789abcdef', 'note');
  const quoteNote = JSON.stringify({ ...WORST['uf/note'], note: '"'.repeat(10_000) });
  const kinds: Record<string, SyncEvent> = {
    'a DELETE': create(SyncEventSchema, { facetKey: key, version, op: SyncOp.DELETE }),
    'a note of quotes': create(SyncEventSchema, { facetKey: key, version, op: SyncOp.UPSERT, payload: quoteNote }),
    'the widest note': create(SyncEventSchema, { facetKey: key, version, op: SyncOp.UPSERT, payload: JSON.stringify(WORST['uf/note']) }),
  };

  it.each(Object.keys(kinds))('keeps an 8 MiB binary batch of %s within 16 MiB as JSON', (kind) => {
    const one = toBinary(SyncEventSchema, kinds[kind]!).length + 4;
    const req = create(PushRequestSchema, {
      clientId: '~'.repeat(128),
      events: Array<SyncEvent>(Math.floor((8 * 2 ** 20 - 131) / one)).fill(kinds[kind]!),
    });
    expect(toBinary(PushRequestSchema, req).length).toBeLessThanOrEqual(8 * 2 ** 20);
    expect(utf8(toJsonString(PushRequestSchema, req))).toBeLessThanOrEqual(16 * 2 ** 20);
  });
});
