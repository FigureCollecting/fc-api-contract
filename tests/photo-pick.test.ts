import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FACET_KEY_GRAMMARS,
  PUBLIC_IMAGE_URL_MAX_LENGTH,
  PUBLIC_IMAGE_URL_PATTERN,
  USER_FACET_FAMILIES,
  USER_FACET_PAYLOAD_SCHEMAS,
  buildFacetKey,
  compareVersion,
  isCanonicalVersion,
  isPublicImageUrl,
  parseServerFacetKey,
  parseUserFacetKey,
  payloadSchemaPath,
  photoPickKey,
} from '../src/index.js';

// The photo pick (sync.proto rule 6 PHOTO PICK): photo/{head_id}/pick, the photo a user chose to show for a figure.
// golden/photo-pick-vectors.json is what the coordinator's Push validation and the client both replay.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const prose = (text: string) => text.replace(/^\s*(\/\/|\*) ?/gm, '').replace(/\s+/g, ' ');

interface Push {
  name: string;
  op: 'UPSERT' | 'DELETE';
  mediaBase?: string;
  body?: Record<string, unknown>;
  raw?: string;
  expect: 'accepted' | 'payload_invalid';
  why?: 'schema' | 'foreign' | 'delete_payload';
}
interface PickEvent {
  op: 'UPSERT' | 'DELETE';
  version: string;
  url?: string;
}
interface Vectors {
  mediaBase: string;
  key: string;
  parsedKey: { family: 'photo/pick'; headId: string };
  pushes: Push[];
  lastWriterWins: { name: string; events: PickEvent[]; expect: string | null }[];
}
const vectors = JSON.parse(read('golden/photo-pick-vectors.json')) as Vectors;

const HEAD = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
const BASE = 'https://images.figurecollecting.com/d';
const HEX = '0123456789abcdef'.repeat(4);
const DISPLAY = { edited_at: '2026-11-21T10:15:00-06:00', tz: 'America/Chicago' };

const schema = JSON.parse(read('schemas/photo-pick.schema.json')) as {
  description: string;
  required: string[];
  properties: { url: { maxLength: number; pattern: string; description: string } };
};
const valid = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

describe('photo/pick: the key', () => {
  it('is the seventeenth user-owned family, with a grammar and a payload schema of its own', () => {
    expect(USER_FACET_FAMILIES).toContain('photo/pick');
    expect(USER_FACET_FAMILIES).toHaveLength(17);
    const grammar = FACET_KEY_GRAMMARS.filter((g) => g.family === 'photo/pick');
    expect(grammar.map((g) => g.owner)).toEqual(['user']);
    expect(USER_FACET_PAYLOAD_SCHEMAS['photo/pick']).toBe('schemas/photo-pick.schema.json');
    expect(payloadSchemaPath({ family: 'photo/pick', headId: HEAD })).toBe('schemas/photo-pick.schema.json');
  });

  it('is spelled photo/{head_id}/pick, one spelling, and the builder alone folds case', () => {
    expect(photoPickKey(HEAD)).toBe(`photo/${HEAD}/pick`);
    expect(photoPickKey(HEAD.toUpperCase())).toBe(`photo/${HEAD}/pick`);
    expect(buildFacetKey({ family: 'photo/pick', headId: HEAD.toUpperCase() })).toBe(`photo/${HEAD}/pick`);
    expect(parseUserFacetKey(`photo/${HEAD}/pick`)).toEqual({ family: 'photo/pick', headId: HEAD });
    expect(parseServerFacetKey(`photo/${HEAD}/pick`)).toBeUndefined();
    expect(FACET_KEY_GRAMMARS.filter((g) => g.pattern.test(`photo/${HEAD}/pick`)).map((g) => g.family)).toEqual(['photo/pick']);
  });

  it.each([
    ['an uppercase head id', `photo/${HEAD.toUpperCase()}/pick`],
    ['an undashed head id', `photo/${HEAD.replaceAll('-', '')}/pick`],
    ['`default` as the head', 'photo/default/pick'],
    ['no head', 'photo/pick'],
    ['an empty head', 'photo//pick'],
    ['a trailing segment (a pick is per figure, never per copy or per device)', `photo/${HEAD}/pick/0`],
    ['a trailing slash', `photo/${HEAD}/pick/`],
    ['another suffix', `photo/${HEAD}/choice`],
    ['an uppercase family', `PHOTO/${HEAD}/pick`],
    ['the pick spelled under uf (it is no figure field and no library reference)', `uf/${HEAD}/photo`],
    ['the pick spelled as a preference', `pref/photo/${HEAD}`],
    ['a trailing newline', `photo/${HEAD}/pick\n`],
  ])('claims no key with %s', (_why, key) => {
    expect(parseUserFacetKey(key)).toBeUndefined();
    expect(parseServerFacetKey(key)).toBeUndefined();
    expect(FACET_KEY_GRAMMARS.filter((g) => g.pattern.test(key))).toEqual([]);
  });

  it.each([
    ['not a uuid', 'fx-dark-angel'],
    ['`default`', 'default'],
    ['empty', ''],
    ['a number', 7],
    ['undefined', undefined],
  ])('refuses to build a key for a head id that is %s', (_why, head) => {
    expect(() => photoPickKey(head as never)).toThrow(TypeError);
    expect(() => buildFacetKey({ family: 'photo/pick', headId: head as never })).toThrow(TypeError);
  });

  it('is the key the golden vectors push on', () => {
    expect(vectors.key).toBe(photoPickKey(vectors.parsedKey.headId));
    expect(parseUserFacetKey(vectors.key)).toEqual(vectors.parsedKey);
  });
});

describe('isPublicImageUrl: the address ProductImage.url carries, on this server\'s media base', () => {
  it('accepts exactly <base>/<64 lowercase hex>', () => {
    expect(isPublicImageUrl(`${BASE}/${HEX}`, BASE)).toBe(true);
    expect(isPublicImageUrl(`${BASE}/${'f'.repeat(64)}`, BASE)).toBe(true);
  });

  it('reads the base as the coordinator and the spine do: trailing slashes trimmed and nothing else', () => {
    expect(isPublicImageUrl(`${BASE}/${HEX}`, `${BASE}/`)).toBe(true);
    expect(isPublicImageUrl(`${BASE}/${HEX}`, `${BASE}///`)).toBe(true);
    expect(isPublicImageUrl(`${BASE}/${HEX}`, ` ${BASE}`)).toBe(false);
    expect(isPublicImageUrl(`${BASE}/${HEX}`, BASE.toUpperCase())).toBe(false);
  });

  it.each([
    ['another host', `https://evil.example/d/${HEX}`],
    ['the media host as a prefix of another', `https://images.figurecollecting.com.evil.example/d/${HEX}`],
    ['another path on the media host', `https://images.figurecollecting.com/o/${HEX}`],
    ['a path below the base', `${BASE}/x/${HEX}`],
    ['a path above the base', `https://images.figurecollecting.com/${HEX}`],
    ['a base that only starts like it', `${BASE}d/${HEX}`],
    ['another port', `https://images.figurecollecting.com:8443/d/${HEX}`],
    ['http', `http://images.figurecollecting.com/d/${HEX}`],
    ['a query', `${BASE}/${HEX}?w=1`],
    ['a fragment', `${BASE}/${HEX}#x`],
    ['63 hex characters', `${BASE}/${HEX.slice(1)}`],
    ['65 hex characters', `${BASE}/${HEX}0`],
    ['uppercase hex', `${BASE}/${HEX.toUpperCase()}`],
    ['a trailing newline', `${BASE}/${HEX}\n`],
    ['the base alone', BASE],
    ['the base and a slash', `${BASE}/`],
    ['empty', ''],
  ])('refuses %s', (_why, url) => {
    expect(isPublicImageUrl(url, BASE)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a list holding the address', [`${BASE}/${HEX}`]],
    ['a URL object', new URL(`${BASE}/${HEX}`)],
    ['an object that prints as the address', { toString: () => `${BASE}/${HEX}` }],
  ])('refuses a value that is %s, not a string', (_why, value) => {
    expect(isPublicImageUrl(value, BASE)).toBe(false);
  });

  it.each([
    ['empty (images off)', ''],
    ['only slashes', '///'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('refuses every address when the base is %s', (_why, base) => {
    expect(isPublicImageUrl(`${BASE}/${HEX}`, base as never)).toBe(false);
    expect(isPublicImageUrl(`/${HEX}`, base as never)).toBe(false);
    expect(isPublicImageUrl(`https:///${HEX}`, base as never)).toBe(false);
  });

  it('refuses an http base even for an address on it: a public image is https', () => {
    const base = 'http://images.figurecollecting.com/d';
    expect(isPublicImageUrl(`${base}/${HEX}`, base)).toBe(false);
  });

  it('refuses an address past the length the schema allows, even on a base that long', () => {
    const fits = `https://h.example/${'p'.repeat(PUBLIC_IMAGE_URL_MAX_LENGTH - 18 - 1 - 64)}`;
    expect(`${fits}/${HEX}`).toHaveLength(PUBLIC_IMAGE_URL_MAX_LENGTH);
    expect(isPublicImageUrl(`${fits}/${HEX}`, fits)).toBe(true);
    expect(isPublicImageUrl(`${fits}p/${HEX}`, `${fits}p`)).toBe(false);
  });

  it('shares its form and its length with the schema, so the helper and a schema validator never disagree on a url', () => {
    expect(schema.properties.url.pattern).toBe(PUBLIC_IMAGE_URL_PATTERN);
    expect(schema.properties.url.maxLength).toBe(PUBLIC_IMAGE_URL_MAX_LENGTH);
    expect(PUBLIC_IMAGE_URL_MAX_LENGTH).toBe(512);
  });

  it('never accepts a url the schema refuses, whatever the base', () => {
    const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
    const base = fc.oneof(
      fc.constantFrom(BASE, `${BASE}/`, 'https://media.example.test:8443/a/b', 'https://h', 'http://h/d', 'https://h/../d', 'https://h/d?x=1', 'https://H/d', 'https://u:p@h/d', '', '/', 'https://'),
      fc.webUrl(),
      fc.string(),
    );
    const tail = fc.oneof(
      { arbitrary: hex, weight: 5 },
      { arbitrary: fc.oneof(hex.map((h) => h.toUpperCase()), hex.map((h) => `${h}?x`), hex.map((h) => `x/${h}`), hex.map((h) => `../${h}`), fc.string()), weight: 5 },
    );
    let accepted = 0;
    fc.assert(
      fc.property(base, tail, fc.boolean(), (b, t, slash) => {
        const url = `${b}${slash ? '/' : ''}${t}`;
        if (!isPublicImageUrl(url, b)) return;
        accepted++;
        expect(valid({ url, ...DISPLAY }), url).toBe(true);
        expect(url.startsWith('https://'), url).toBe(true);
        expect(url, url).not.toMatch(/[?#@\\%\s]|\/\.{1,2}\//);
        expect(url.slice(url.lastIndexOf('/') + 1), url).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 5000 },
    );
    expect(accepted).toBeGreaterThan(100);
  });
});

describe('golden photo-pick vectors: pushes', () => {
  const outcome = (p: Push): { expect: Push['expect']; why?: Push['why'] } => {
    const wire = p.raw ?? JSON.stringify(p.body);
    if (p.op === 'DELETE') return wire === '' ? { expect: 'accepted' } : { expect: 'payload_invalid', why: 'delete_payload' };
    let payload: unknown;
    try {
      payload = JSON.parse(wire);
    } catch {
      return { expect: 'payload_invalid', why: 'schema' };
    }
    if (!valid(payload)) return { expect: 'payload_invalid', why: 'schema' };
    const url = (payload as { url: string }).url;
    return isPublicImageUrl(url, p.mediaBase ?? vectors.mediaBase) ? { expect: 'accepted' } : { expect: 'payload_invalid', why: 'foreign' };
  };

  it('carries each case exactly one way: a body or a raw payload, and a reason exactly when it is refused', () => {
    expect(new Set(vectors.pushes.map((p) => p.name)).size).toBe(vectors.pushes.length);
    for (const p of vectors.pushes) {
      expect((p.body === undefined) !== (p.raw === undefined), p.name).toBe(true);
      expect(p.why === undefined, p.name).toBe(p.expect === 'accepted');
      expect(['UPSERT', 'DELETE'], p.name).toContain(p.op);
    }
  });

  it.each(vectors.pushes.map((p) => [p.name, p] as const))('%s', (_name, p) => {
    expect(outcome(p)).toEqual(p.why === undefined ? { expect: p.expect } : { expect: p.expect, why: p.why });
  });

  it('covers a valid pick, a malformed url, a foreign host, an over-long address and the DELETE', () => {
    const count = (prefix: string, expect_: Push['expect'], why?: Push['why']) =>
      vectors.pushes.filter((p) => p.name.startsWith(prefix) && p.expect === expect_ && p.why === why).length;
    expect(count('a pick', 'accepted')).toBeGreaterThanOrEqual(4);
    expect(count('malformed', 'payload_invalid', 'schema')).toBeGreaterThanOrEqual(30);
    expect(count('foreign', 'payload_invalid', 'foreign')).toBeGreaterThanOrEqual(10);
    expect(count('over-long', 'payload_invalid', 'schema')).toBe(1);
    expect(count('DELETE', 'accepted')).toBe(1);
    expect(count('DELETE', 'payload_invalid', 'delete_payload')).toBe(2);
    expect(vectors.pushes.filter((p) => !/^(a pick|the longest|malformed|foreign|over-long|DELETE)/.test(p.name))).toEqual([]);
  });

  it('puts the length boundary at 512 and 513 characters, the base the same but for one character', () => {
    const longest = vectors.pushes.find((p) => p.name.startsWith('the longest'))!;
    const over = vectors.pushes.find((p) => p.name.startsWith('over-long'))!;
    expect(String(longest.body!.url)).toHaveLength(512);
    expect(String(over.body!.url)).toHaveLength(513);
    expect(longest.expect).toBe('accepted');
    expect(over.mediaBase).toBe(`${longest.mediaBase}p`);
    expect(String(over.body!.url).startsWith(`${over.mediaBase}/`)).toBe(true);
  });

  it('refuses every foreign address by the base alone: each one passes the schema, and is accepted on its own base', () => {
    for (const p of vectors.pushes.filter((q) => q.why === 'foreign')) {
      expect(valid(p.body), p.name).toBe(true);
      const url = String(p.body!.url);
      expect(isPublicImageUrl(url, url.slice(0, url.lastIndexOf('/'))), p.name).toBe(true);
    }
  });

  it('never has the helper accept a url the schema refuses', () => {
    for (const p of vectors.pushes.filter((q) => q.why === 'schema' && typeof q.body?.url === 'string')) {
      const url = p.body!.url as string;
      if (valid({ url, ...DISPLAY })) continue; // refused for something other than its url (a missing or extra property)
      expect(isPublicImageUrl(url, p.mediaBase ?? vectors.mediaBase), p.name).toBe(false);
      expect(isPublicImageUrl(url, url.slice(0, url.lastIndexOf('/'))), p.name).toBe(false);
    }
  });
});

describe('golden photo-pick vectors: last writer wins', () => {
  const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
  // What a reader does with a feed of one facet's events: apply iff the version is greater than the one held.
  const settle = (events: PickEvent[]) => {
    let held: PickEvent | undefined;
    for (const e of events) if (held === undefined || compareVersion(e.version, held.version) > 0) held = e;
    return held === undefined || held.op === 'DELETE' ? null : held.url;
  };

  it('uses canonical device versions, a url on every UPSERT and none on a DELETE', () => {
    expect(vectors.lastWriterWins.length).toBeGreaterThanOrEqual(6);
    for (const c of vectors.lastWriterWins)
      for (const e of c.events) {
        expect(isCanonicalVersion(e.version), `${c.name}: ${e.version}`).toBe(true);
        if (e.op === 'UPSERT') expect(isPublicImageUrl(e.url, vectors.mediaBase), c.name).toBe(true);
        else expect(e.url, c.name).toBeUndefined();
      }
  });

  it.each(vectors.lastWriterWins.map((c) => [c.name, c] as const))('%s, in every arrival order', (_name, c) => {
    for (const order of permutations(c.events)) expect(settle(order), JSON.stringify(order.map((e) => e.version))).toBe(c.expect);
    // a replayed feed (every event twice) changes nothing
    expect(settle([...c.events, ...c.events])).toBe(c.expect);
  });

  it('covers a tie broken by the counter, a tie broken by the device, and a DELETE that wins and that loses', () => {
    const names = vectors.lastWriterWins.map((c) => c.name).join(' | ');
    expect(names).toMatch(/higher counter wins/);
    expect(names).toMatch(/greater device id wins/);
    expect(vectors.lastWriterWins.filter((c) => c.expect === null && c.events.some((e) => e.op === 'UPSERT'))).not.toHaveLength(0);
    expect(vectors.lastWriterWins.filter((c) => c.expect !== null && c.events.some((e) => e.op === 'DELETE'))).not.toHaveLength(0);
  });
});

describe('photo-pick payload schema', () => {
  it('is closed, requires the url and the display fields, and states the DELETE', () => {
    expect(schema.required).toEqual(['url', 'edited_at', 'tz']);
    expect(valid({ url: `${BASE}/${HEX}`, ...DISPLAY })).toBe(true);
    expect(valid({ url: `${BASE}/${HEX}`, ...DISPLAY, mask: `${BASE}/${HEX}` })).toBe(false);
    expect(schema.description).toMatch(/"Use default" is a DELETE with an empty payload/);
    expect(schema.description).toMatch(/Last writer wins/);
  });
});

describe('sync.proto and README: the photo pick', () => {
  const sync = read('proto/coordinator/v1/sync.proto');
  const rule6 = prose(sync.slice(sync.indexOf(' 6. USER-OWNED FACET KEYS'), sync.indexOf(' 7. TRANSACTIONS, AND WHAT IS DEFERRED')));
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json')) as { exports: Record<string, string> };

  it('lists the key in the user-owned table with its payload', () => {
    expect(rule6).toContain('photo/{head_id}/pick {"url": "<media base>/<64 hex>"}');
  });

  it('says what the address is and that a server accepts only one on its own media base', () => {
    expect(rule6).toMatch(/PHOTO PICK \(0\.8\.0\)\. photo\/\{head_id\}\/pick is the photo the user chose to show for the figure \{head_id\}/);
    expect(rule6).toMatch(/exactly as ProductImage\.url carries it \(catalog\.proto\): the public media base, a slash and the derivative_id, 64 lowercase hex characters, over https, with no credentials, query or fragment/);
    expect(rule6).toMatch(/A server accepts only an address on its own media base \(isPublicImageUrl\) and answers any other REJECTED payload_invalid/);
  });

  it('states last writer wins and that "use default" is a DELETE', () => {
    expect(rule6).toMatch(/LAST WRITER WINS: there is one pick per user and figure, the event with the greater version replaces the other on every device, and two picks are never merged/);
    expect(rule6).toMatch(/"Use default" is a DELETE: the tombstone wins or loses by its version like any pick, and while it stands the figure shows its primary on every device/);
  });

  it('keeps a pick from showing what the image list no longer carries, and out of the library', () => {
    expect(rule6).toMatch(/A client shows a picked photo only while the figure's GetProductImages list carries that address/);
    expect(rule6).toMatch(/A pick is a display preference and never a library reference/);
  });

  it('README names the facet, its vectors and the helper, and package.json exports the vectors', () => {
    expect(readme).toMatch(/## Photo pick/);
    expect(readme).toMatch(/`photo\/\{head_id\}\/pick` \(0\.8\.0, additive: one new key, no field and no existing schema changed\)/);
    expect(readme).toContain('golden/photo-pick-vectors.json');
    expect(readme).toContain('isPublicImageUrl');
    expect(pkg.exports['./golden/photo-pick-vectors.json']).toBe('./golden/photo-pick-vectors.json');
  });
});
