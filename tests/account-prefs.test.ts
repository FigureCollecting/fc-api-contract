import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PREFS,
  FACET_KEY_GRAMMARS,
  USER_FACET_FAMILIES,
  USER_FACET_PAYLOAD_SCHEMAS,
  accountPrefKey,
  buildFacetKey,
  compareVersion,
  isCanonicalVersion,
  parseServerFacetKey,
  parseUserFacetKey,
  payloadSchemaPath,
  type AccountPref,
} from '../src/index.js';

// The account preferences (sync.proto rule 6 ACCOUNT PREFERENCES; Ross, 2026-11-21: photo picks, case look, theme and
// recents belong to the account, not the device): pref/theme, pref/case and pref/recents, one key each per account.
// golden/account-pref-vectors.json is what the coordinator's Push validation and the client both replay; the photo
// pick, the fourth, is keyed per figure and has tests/photo-pick.test.ts.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const prose = (text: string) => text.replace(/^\s*(\/\/|\*) ?/gm, '').replace(/\s+/g, ' ');

type Family = `pref/${AccountPref}`;
interface Push {
  name: string;
  op: 'UPSERT' | 'DELETE';
  body?: Record<string, unknown>;
  raw?: string;
  expect: 'accepted' | 'payload_invalid';
  why?: 'schema' | 'delete_payload';
}
interface PrefEvent {
  op: 'UPSERT' | 'DELETE';
  version: string;
  body?: Record<string, unknown>;
}
interface FamilyVectors {
  key: string;
  parsedKey: { family: Family };
  pushes: Push[];
  lastWriterWins: { name: string; events: PrefEvent[]; expect: Record<string, unknown> | null }[];
}
const vectors = JSON.parse(read('golden/account-pref-vectors.json')) as { families: Record<Family, FamilyVectors> };

const FAMILIES: Family[] = ['pref/theme', 'pref/case', 'pref/recents'];
const DISPLAY = { edited_at: '2026-11-21T18:40:00-06:00', tz: 'America/Chicago' };
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaOf = (family: Family) =>
  JSON.parse(read(`schemas/${family.replace('/', '-')}.schema.json`)) as { description: string; required: string[]; properties: Record<string, { enum?: string[] }> };
const validators = new Map<Family, ReturnType<typeof ajv.compile>>();
const valid = (family: Family, payload: unknown): boolean => {
  if (!validators.has(family)) validators.set(family, ajv.compile(schemaOf(family)));
  return validators.get(family)!(payload) === true;
};

describe('account preferences: the keys', () => {
  it('names theme, case and recents, each a user-owned family after the photo pick', () => {
    expect(ACCOUNT_PREFS).toEqual(['theme', 'case', 'recents']);
    expect(USER_FACET_FAMILIES.slice(-4)).toEqual(['photo/pick', ...FAMILIES]);
    expect(Object.keys(vectors.families)).toEqual(FAMILIES);
  });

  it.each(FAMILIES)('%s is one key per account, user-owned, with a schema of its own', (family) => {
    const name = family.slice('pref/'.length) as AccountPref;
    expect(accountPrefKey(name)).toBe(family);
    expect(buildFacetKey({ family })).toBe(family);
    expect(parseUserFacetKey(family)).toEqual({ family });
    expect(parseServerFacetKey(family)).toBeUndefined();
    expect(FACET_KEY_GRAMMARS.filter((g) => g.pattern.test(family)).map((g) => [g.family, g.owner])).toEqual([[family, 'user']]);
    expect(USER_FACET_PAYLOAD_SCHEMAS[family]).toBe(`schemas/pref-${name}.schema.json`);
    expect(payloadSchemaPath({ family })).toBe(`schemas/pref-${name}.schema.json`);
    expect(vectors.families[family].key).toBe(family);
    expect(vectors.families[family].parsedKey).toEqual({ family });
  });

  it.each([
    ['a device in the key (a preference is the account\'s, never a device\'s)', 'pref/theme/0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e'],
    ['a field in the key (the look is one value)', 'pref/case/wall'],
    ['a trailing slash', 'pref/recents/'],
    ['an uppercase name', 'pref/Theme'],
    ['another spelling', 'pref/themes'],
    ['an unknown preference', 'pref/language'],
    ['the per-device depth rocker', 'pref/depth-rocker'],
    ['no name', 'pref/'],
    ['the family alone', 'pref'],
    ['a trailing newline', 'pref/theme\n'],
    ['a leading slash', '/pref/theme'],
  ])('claims no key with %s', (_why, key) => {
    expect(parseUserFacetKey(key)).toBeUndefined();
    expect(parseServerFacetKey(key)).toBeUndefined();
    expect(FACET_KEY_GRAMMARS.filter((g) => g.pattern.test(key))).toEqual([]);
  });

  it('keeps an import site named like a preference apart: pref/{site}/import is still the import preference', () => {
    for (const name of ACCOUNT_PREFS) expect(parseUserFacetKey(`pref/${name}/import`)).toEqual({ family: 'pref/import', site: name });
  });

  it.each([['an unknown name', 'language'], ['an uppercase name', 'THEME'], ['empty', ''], ['a number', 7], ['undefined', undefined]])(
    'refuses to build a key for %s',
    (_why, name) => {
      expect(() => accountPrefKey(name as never)).toThrow(TypeError);
      expect(() => buildFacetKey({ family: `pref/${String(name)}` as never })).toThrow(TypeError);
    },
  );
});

describe.each(FAMILIES)('golden account-preference vectors: %s', (family) => {
  const v = vectors.families[family];
  const outcome = (p: Push): { expect: Push['expect']; why?: Push['why'] } => {
    const wire = p.raw ?? JSON.stringify(p.body);
    if (p.op === 'DELETE') return wire === '' ? { expect: 'accepted' } : { expect: 'payload_invalid', why: 'delete_payload' };
    let payload: unknown;
    try {
      payload = JSON.parse(wire);
    } catch {
      return { expect: 'payload_invalid', why: 'schema' };
    }
    return valid(family, payload) ? { expect: 'accepted' } : { expect: 'payload_invalid', why: 'schema' };
  };

  it('carries each case exactly one way: a body or a raw payload, and a reason exactly when it is refused', () => {
    expect(new Set(v.pushes.map((p) => p.name)).size).toBe(v.pushes.length);
    for (const p of v.pushes) {
      expect((p.body === undefined) !== (p.raw === undefined), p.name).toBe(true);
      expect(p.why === undefined, p.name).toBe(p.expect === 'accepted');
      expect(['UPSERT', 'DELETE'], p.name).toContain(p.op);
    }
  });

  it.each(v.pushes.map((p) => [p.name, p] as const))('push: %s', (_name, p) => {
    expect(outcome(p)).toEqual(p.why === undefined ? { expect: p.expect } : { expect: p.expect, why: p.why });
  });

  it('covers valid payloads, malformed ones, the DELETE and a DELETE that carries a payload', () => {
    const count = (prefix: string, expect_: Push['expect'], why?: Push['why']) => v.pushes.filter((p) => p.name.startsWith(prefix) && p.expect === expect_ && p.why === why).length;
    expect(count('valid', 'accepted')).toBeGreaterThanOrEqual(3);
    expect(count('malformed', 'payload_invalid', 'schema')).toBeGreaterThanOrEqual(8);
    expect(count('DELETE', 'accepted')).toBe(1);
    expect(count('DELETE', 'payload_invalid', 'delete_payload')).toBe(1);
    expect(v.pushes.filter((p) => !/^(valid|malformed|DELETE)/.test(p.name))).toEqual([]);
    // what this device's localStorage holds today is never a payload as it stands: the client maps it (U2c)
    expect(v.pushes.filter((p) => /localStorage/.test(p.name) && p.expect === 'payload_invalid')).not.toHaveLength(0);
  });

  it('writes a case named for a length with a string of exactly that many characters', () => {
    for (const p of v.pushes) {
      const m = /of (\d+) characters/.exec(p.name);
      if (m === null) continue;
      const strings = Object.values(p.body ?? {}).flat().filter((s): s is string => typeof s === 'string');
      expect(strings.map((s) => [...s].length), p.name).toContain(Number(m[1]));
    }
  });

  const permutations =<T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
  // What a reader does with a feed of one facet's events: apply iff the version is greater than the one held.
  const settle = (events: PrefEvent[]) => {
    let held: PrefEvent | undefined;
    for (const e of events) if (held === undefined || compareVersion(e.version, held.version) > 0) held = e;
    return held === undefined || held.op === 'DELETE' ? null : held.body;
  };

  it('writes its last-writer-wins events as canonical device versions, a schema-valid body on every UPSERT and none on a DELETE', () => {
    expect(v.lastWriterWins.length).toBeGreaterThanOrEqual(3);
    for (const c of v.lastWriterWins)
      for (const e of c.events) {
        expect(isCanonicalVersion(e.version), `${c.name}: ${e.version}`).toBe(true);
        if (e.op === 'UPSERT') expect(valid(family, e.body), c.name).toBe(true);
        else expect(e.body, c.name).toBeUndefined();
      }
  });

  it.each(v.lastWriterWins.map((c) => [c.name, c] as const))('last writer wins: %s, in every arrival order', (_name, c) => {
    for (const order of permutations(c.events)) expect(settle(order), JSON.stringify(order.map((e) => e.version))).toEqual(c.expect);
    expect(settle([...c.events, ...c.events])).toEqual(c.expect); // a replayed feed changes nothing
    // the winner is one event's body whole: nothing is merged from the loser
    if (c.expect !== null) expect(c.events.filter((e) => JSON.stringify(e.body) === JSON.stringify(c.expect))).toHaveLength(1);
  });

  it('has a DELETE among its last-writer-wins events', () => {
    expect(v.lastWriterWins.some((c) => c.events.some((e) => e.op === 'DELETE') && c.events.some((e) => e.op === 'UPSERT'))).toBe(true);
  });
});

describe('account preference schemas', () => {
  it.each(FAMILIES)('%s is closed, requires the display fields and states last writer wins and its DELETE', (family) => {
    const s = schemaOf(family);
    expect(s.required).toEqual(expect.arrayContaining(['edited_at', 'tz']));
    expect(Object.keys(s.properties).sort()).toEqual([...s.required].sort());
    expect(s.description).toMatch(/Last writer wins/);
    expect(s.description).toMatch(/DELETE with an empty payload/);
    expect(s.description).toMatch(/the same on every device it signs in on/);
  });

  it('pref/theme takes the three themes the app has', () => {
    expect(schemaOf('pref/theme').properties.theme!.enum).toEqual(['dark', 'light', 'system']);
  });

  it('pref/case carries the look and no per-device control or dismissal', () => {
    expect(Object.keys(schemaOf('pref/case').properties)).toEqual(['pattern', 'ceiling_tenths_mm', 'clearance_tenths_mm', 'wall', 'wall_custom', 'arrange', 'show_estimated', 'edited_at', 'tz']);
    const look = { pattern: 'ikea-klingsbo', ceiling_tenths_mm: 24384, clearance_tenths_mm: 254, wall: 'cream', wall_custom: '#d8d2c4', arrange: 'series-scale-name', show_estimated: false, ...DISPLAY };
    expect(valid('pref/case', look)).toBe(true);
    for (const extra of [{ tab_order: ['view', 'reserved', 'info', 'refine'] }, { depth_rocker: 'vertical' }, { misfits_dismissed: [] }]) expect(valid('pref/case', { ...look, ...extra })).toBe(false);
    for (const field of ['pattern', 'ceiling_tenths_mm', 'clearance_tenths_mm', 'wall', 'wall_custom', 'arrange', 'show_estimated'] as const) {
      const { [field]: _dropped, ...rest } = look;
      expect(valid('pref/case', rest), field).toBe(false);
    }
  });

  it('pref/recents counts code points, so 200 emoji are one search and 201 are not', () => {
    expect(valid('pref/recents', { searches: ['🎎'.repeat(200)], ...DISPLAY })).toBe(true);
    expect(valid('pref/recents', { searches: ['🎎'.repeat(201)], ...DISPLAY })).toBe(false);
    expect(schemaOf('pref/recents').description).toMatch(/never an empty list/);
  });
});

describe('sync.proto and README: the account preferences', () => {
  const sync = read('proto/coordinator/v1/sync.proto');
  const rule6 = prose(sync.slice(sync.indexOf(' 6. USER-OWNED FACET KEYS'), sync.indexOf(' 7. TRANSACTIONS, AND WHAT IS DEFERRED')));
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json')) as { exports: Record<string, string> };

  it('lists the three keys in the user-owned table with their payloads', () => {
    expect(rule6).toContain('pref/theme {"theme": "dark"|"light"|"system"}');
    expect(rule6).toContain('pref/case {"pattern", "ceiling_tenths_mm", "clearance_tenths_mm", "wall", "wall_custom", "arrange", "show_estimated"}');
    expect(rule6).toContain('pref/recents {"searches": ["1..200 code points"], 1 to 10, newest first}');
  });

  it('says the four belong to the account and names what stays on the device', () => {
    expect(rule6).toMatch(/ACCOUNT PREFERENCES \(0\.9\.0; Ross, 2026-11-21\)\. The photo picks, the case look, the theme and the recent searches belong to the account, not to a device/);
    expect(rule6).toMatch(/pref\/theme, pref\/case and pref\/recents are one key each per account/);
    expect(rule6).toMatch(/What stays on the device is not in these payloads: the order of the case's tabs, the depth control's shape and the dismissed do-not-fit list/);
  });

  it('states one rule for all four: last writer wins per key, by version, whole values, DELETE = default', () => {
    expect(rule6).toMatch(/LAST WRITER WINS PER KEY, for all four as for every facet: the event with the greater version \(rule 5\) replaces the other on every device/);
    expect(rule6).toMatch(/A value is replaced whole: two looks are never merged field by field, nor two lists of searches/);
    expect(rule6).toMatch(/A DELETE is the app's default \(the default theme, the default look, an empty list\)/);
    expect(rule6).toMatch(/the server bounds a device's clock \(version_future\)/);
  });

  it('has a device push what it holds once, on first sign-in, and only where the account has nothing', () => {
    expect(rule6).toMatch(/FIRST SIGN-IN\. A device that holds values from before 0\.9\.0 pushes each once, after its first Delta, and only for a key the account has no event for, live or tombstoned/);
  });

  it('keeps recent searches private', () => {
    expect(rule6).toMatch(/Recent searches are private to the user: neither the coordinator nor a client logs them/);
  });

  it('README names the facets and their vectors, and package.json exports the vectors', () => {
    expect(readme).toMatch(/## Account preferences/);
    expect(readme).toMatch(/`pref\/theme`, `pref\/case` and `pref\/recents` \(0\.9\.0, additive: three new keys, no field and no existing schema changed\)/);
    expect(readme).toContain('golden/account-pref-vectors.json');
    expect(pkg.exports['./golden/account-pref-vectors.json']).toBe('./golden/account-pref-vectors.json');
  });
});
