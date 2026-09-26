import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { USER_FACET_PAYLOAD_SCHEMAS, type UserFacetField } from '../src/index.js';

const load = (field: UserFacetField) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${USER_FACET_PAYLOAD_SCHEMAS[field]}`, import.meta.url)), 'utf8')) as object;

const ajv = new Ajv2020({ strict: true, allErrors: true });
const compiled = new Map<UserFacetField, ReturnType<typeof ajv.compile>>();
const validator = (field: UserFacetField) => {
  if (!compiled.has(field)) compiled.set(field, ajv.compile(load(field)));
  return compiled.get(field)!;
};

const DISPLAY = { edited_at: '2026-09-14T06:29:58.500-05:00', tz: 'America/Chicago' };

describe('payload schemas', () => {
  it.each(Object.keys(USER_FACET_PAYLOAD_SCHEMAS) as UserFacetField[])('%s compiles under draft 2020-12 strict mode', (field) => {
    const schema = load(field) as { $schema?: string; $id?: string };
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toMatch(/^https:\/\/figurecollecting\.com\/schemas\/coordinator\/v1\//);
    expect(() => validator(field)).not.toThrow();
  });

  it.each([
    ['status', { status: 'owned', ...DISPLAY }],
    ['status', { status: 'ordered', ...DISPLAY }],
    ['status', { status: 'wished', edited_at: '2026-09-14T11:29:58Z', tz: 'UTC' }],
    ['count', { count: 1, ...DISPLAY }],
    ['count', { count: 9999, ...DISPLAY }],
    ['score', { score: 1, ...DISPLAY }],
    ['score', { score: 10, ...DISPLAY }],
    ['note', { note: '', ...DISPLAY }],
    ['note', { note: 'box damaged, figure fine — 箱に傷', ...DISPLAY }],
    ['note', { note: '🎎'.repeat(10_000), ...DISPLAY }], // 10,000 code points, 20,000 UTF-16 units
    ['status', { status: 'owned', edited_at: '2026-09-14T23:59:59.999+14:00', tz: 'Pacific/Kiritimati' }],
  ] as const)('%s accepts %o', (field, payload) => {
    const v = validator(field);
    expect(v(payload), JSON.stringify(v.errors)).toBe(true);
  });

  it.each([
    ['status', 'no tz', { status: 'owned', edited_at: DISPLAY.edited_at }],
    ['status', 'no edited_at', { status: 'owned', tz: DISPLAY.tz }],
    ['status', 'a status outside the register', { status: 'preordered', ...DISPLAY }],
    ['status', 'an unknown property', { status: 'owned', list: 'owned', ...DISPLAY }],
    ['status', 'a date without a time', { status: 'owned', edited_at: '2026-09-14', tz: DISPLAY.tz }],
    ['status', 'an empty tz', { status: 'owned', edited_at: DISPLAY.edited_at, tz: '' }],
    ['count', 'zero copies (remove the holding instead)', { count: 0, ...DISPLAY }],
    ['count', 'a fractional count', { count: 1.5, ...DISPLAY }],
    ['count', 'a count spelled as a string', { count: '2', ...DISPLAY }],
    ['count', 'past the bound', { count: 10000, ...DISPLAY }],
    ['score', 'zero (remove the score instead)', { score: 0, ...DISPLAY }],
    ['score', 'past 10', { score: 11, ...DISPLAY }],
    ['note', 'a note past 10,000 characters', { note: 'x'.repeat(10_001), ...DISPLAY }],
    ['note', 'no note', { ...DISPLAY }],
    ['note', 'a note past 10,000 code points', { note: '🎎'.repeat(10_001), ...DISPLAY }],
  ] as const)('%s rejects a payload with %s', (field, _why, payload) => {
    expect(validator(field)(payload)).toBe(false);
  });

  const BODY: Record<UserFacetField, object> = { status: { status: 'owned' }, count: { count: 1 }, score: { score: 1 }, note: { note: '' } };
  const BAD_DISPLAY = [
    ['month 13', { edited_at: '2026-13-14T06:29:58-05:00', tz: DISPLAY.tz }],
    ['day 32', { edited_at: '2026-09-32T06:29:58-05:00', tz: DISPLAY.tz }],
    ['hour 24', { edited_at: '2026-09-14T24:00:00Z', tz: DISPLAY.tz }],
    ['an offset past 18 hours', { edited_at: '2026-09-14T06:29:58+19:00', tz: DISPLAY.tz }],
    ['a tz with a space', { edited_at: DISPLAY.edited_at, tz: 'America/New York' }],
    ['a tz with an empty segment', { edited_at: DISPLAY.edited_at, tz: 'America//Chicago' }],
  ] as const;
  it.each((Object.keys(BODY) as UserFacetField[]).flatMap((field) => BAD_DISPLAY.map(([why, d]) => [field, why, d] as const)))(
    '%s rejects display fields with %s',
    (field, _why, display) => {
      expect(validator(field)({ ...BODY[field], ...display })).toBe(false);
    },
  );
});
