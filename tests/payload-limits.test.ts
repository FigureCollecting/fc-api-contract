import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD_BYTES, USER_FACET_PAYLOAD_SCHEMAS, type UserFacetField } from '../src/index.js';

const load = (field: UserFacetField) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${USER_FACET_PAYLOAD_SCHEMAS[field]}`, import.meta.url)), 'utf8')) as {
    description: string;
  };
const ajv = new Ajv2020({ strict: true, allErrors: true });
const bytes = (payload: object) => Buffer.byteLength(JSON.stringify(payload), 'utf8');

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

  it.each(FIELDS)('%s: the widest schema-valid payload is valid and under the cap', (field) => {
    const v = ajv.compile(load(field));
    expect(v(WORST[field]), JSON.stringify(v.errors)).toBe(true);
    expect(bytes(WORST[field])).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('puts the largest note at 60,133 bytes', () => {
    expect(bytes(WORST.note)).toBe(60_133);
    expect(bytes({ ...WORST.note, note: '\ud800'.repeat(10_000) })).toBe(60_133);
  });

  it.each(FIELDS)('%s: its schema states that largest size and the cap', (field) => {
    const { description } = load(field);
    const n = bytes(WORST[field]).toLocaleString('en-US');
    expect(description).toContain(`at most ${n} bytes of UTF-8 as JSON.stringify writes it`);
    expect(description).toContain(`MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES.toLocaleString('en-US')})`);
  });
});
