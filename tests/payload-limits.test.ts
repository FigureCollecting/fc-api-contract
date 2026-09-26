import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { create, toBinary, toJsonString } from '@bufbuild/protobuf';
import {
  MAX_PAYLOAD_BYTES,
  PushRequestSchema,
  SyncEventSchema,
  SyncOp,
  USER_FACET_PAYLOAD_SCHEMAS,
  userFacetKey,
  type SyncEvent,
  type UserFacetField,
} from '../src/index.js';
import { maxJsonBytes, patternSpan, type Schema } from './support/max-json-bytes.js';

const load = (field: UserFacetField) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${USER_FACET_PAYLOAD_SCHEMAS[field]}`, import.meta.url)), 'utf8')) as Schema;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');
const bytes = (payload: object) => utf8(JSON.stringify(payload));

// The longest edited_at the pattern admits (nine fractional digits, an offset) and the longest tz.
const WIDEST = { edited_at: '2026-09-14T11:30:00.123456789+18:00', tz: `A${'a'.repeat(63)}` };
// U+0001 is written by JSON.stringify as \u0001: six bytes, the most any one code point costs.
const WORST: Record<UserFacetField, object> = {
  status: { status: 'ordered', ...WIDEST },
  count: { count: 9999, ...WIDEST },
  score: { score: 10, ...WIDEST },
  note: { note: '\u0001'.repeat(10_000), ...WIDEST },
};
const FIELDS = Object.keys(USER_FACET_PAYLOAD_SCHEMAS) as UserFacetField[];

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

  it.each(FIELDS)('%s: a schema-valid payload reaches that bound, so the bound is exact', (field) => {
    const v = ajv.compile(load(field));
    expect(v(WORST[field]), JSON.stringify(v.errors)).toBe(true);
    expect(bytes(WORST[field])).toBe(maxJsonBytes(load(field)));
  });

  it('puts the largest note at 60,133 bytes', () => {
    expect(bytes(WORST.note)).toBe(60_133);
    expect(bytes({ ...WORST.note, note: '\ud800'.repeat(10_000) })).toBe(60_133);
  });

  it.each(FIELDS)('%s: its schema states that largest size and the cap', (field) => {
    const description = load(field).description ?? '';
    const n = maxJsonBytes(load(field)).toLocaleString('en-US');
    expect(description).toContain(`at most ${n} bytes of UTF-8 as JSON.stringify writes it`);
    expect(description).toContain(`MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES.toLocaleString('en-US')})`);
  });
});

describe('maxJsonBytes', () => {
  const obj = (properties: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, properties });
  const note = load('note');

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
  const key = userFacetKey('01234567-89ab-cdef-0123-456789abcdef', 'note');
  const quoteNote = JSON.stringify({ ...WORST.note, note: '"'.repeat(10_000) });
  const kinds: Record<string, SyncEvent> = {
    'a DELETE': create(SyncEventSchema, { facetKey: key, version, op: SyncOp.DELETE }),
    'a note of quotes': create(SyncEventSchema, { facetKey: key, version, op: SyncOp.UPSERT, payload: quoteNote }),
    'the widest note': create(SyncEventSchema, { facetKey: key, version, op: SyncOp.UPSERT, payload: JSON.stringify(WORST.note) }),
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
