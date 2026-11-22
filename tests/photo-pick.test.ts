import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as contract from '../src/index.js';
import {
  FACET_KEY_GRAMMARS,
  USER_FACET_FAMILIES,
  USER_FACET_PAYLOAD_SCHEMAS,
  buildFacetKey,
  compareVersion,
  isCanonicalVersion,
  parseServerFacetKey,
  parseUserFacetKey,
  payloadSchemaPath,
  photoPickKey,
} from '../src/index.js';

// The photo pick (sync.proto rule 6 PHOTO PICK): photo/{head_id}/pick, the photo a user chose to show for a figure,
// named by its derivative_id and never by an address. golden/photo-pick-vectors.json is what the coordinator's Push
// validation and the client both replay.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const prose = (text: string) => text.replace(/^\s*(\/\/|\*) ?/gm, '').replace(/\s+/g, ' ');

interface Push {
  name: string;
  op: 'UPSERT' | 'DELETE';
  body?: Record<string, unknown>;
  raw?: string;
  expect: 'accepted' | 'payload_invalid';
  why?: 'schema' | 'delete_payload';
}
interface PickEvent {
  op: 'UPSERT' | 'DELETE';
  version: string;
  derivative_id?: string;
}
interface Vectors {
  key: string;
  parsedKey: { family: 'photo/pick'; headId: string };
  pushes: Push[];
  shown: { name: string; pick: string | null; images: string[]; expect: string | null }[];
  lastWriterWins: { name: string; events: PickEvent[]; expect: string | null }[];
}
const vectors = JSON.parse(read('golden/photo-pick-vectors.json')) as Vectors;

const HEAD = '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b';
const HEX = '0123456789abcdef'.repeat(4);
const ID = /^[0-9a-f]{64}$/;
const DISPLAY = { edited_at: '2026-11-21T10:15:00-06:00', tz: 'America/Chicago' };

const schema = JSON.parse(read('schemas/photo-pick.schema.json')) as {
  description: string;
  required: string[];
  properties: Record<string, { pattern?: string; description?: string }>;
};
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const valid = (payload: unknown): boolean => validate(payload) === true;

describe('photo/pick: the key', () => {
  it('is a user-owned family, with a grammar and a payload schema of its own', () => {
    expect(USER_FACET_FAMILIES).toContain('photo/pick');
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
    ['the image id in the key (it is the payload: one pick per figure)', `photo/${HEAD}/pick/${HEX}`],
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

describe('photo-pick payload schema', () => {
  it('is closed and carries the image id, the display fields and nothing else', () => {
    expect(schema.required).toEqual(['derivative_id', 'edited_at', 'tz']);
    expect(Object.keys(schema.properties)).toEqual(['derivative_id', 'edited_at', 'tz']);
    expect(schema.properties.derivative_id!.pattern).toBe('^[0-9a-f]{64}$');
    expect(valid({ derivative_id: HEX, ...DISPLAY })).toBe(true);
    expect(valid({ derivative_id: HEX, ...DISPLAY, mask_id: HEX })).toBe(false);
  });

  it('carries no address: a url is neither the id nor a property beside it', () => {
    expect(valid({ url: `https://images.figurecollecting.com/d/${HEX}`, ...DISPLAY })).toBe(false);
    expect(valid({ derivative_id: `https://images.figurecollecting.com/d/${HEX}`, ...DISPLAY })).toBe(false);
    expect(valid({ derivative_id: HEX, url: `https://images.figurecollecting.com/d/${HEX}`, ...DISPLAY })).toBe(false);
    expect(schema.properties).not.toHaveProperty('url');
  });

  it('states last writer wins, the DELETE and that the id names ProductImage.derivative_id', () => {
    expect(schema.description).toMatch(/Last writer wins/);
    expect(schema.description).toMatch(/"Use default" is a DELETE with an empty payload/);
    expect(schema.properties.derivative_id!.description).toMatch(/ProductImage\.derivative_id/);
    expect(schema.properties.derivative_id!.description).toMatch(/Never an address/);
  });

  it('accepts exactly the strings of 64 lowercase hex characters', () => {
    const near = fc.oneof(
      fc.stringMatching(/^[0-9a-f]{64}$/),
      fc.stringMatching(/^[0-9a-fA-F]{60,68}$/),
      fc.stringMatching(/^[0-9a-f]{0,130}$/),
      fc.stringMatching(/^[0-9a-f]{64}$/).map((h) => `${h}\n`),
      fc.stringMatching(/^[0-9a-f]{63}$/).chain((h) => fc.string({ minLength: 1, maxLength: 1 }).map((c) => h + c)),
      fc.string(),
    );
    let accepted = 0;
    fc.assert(
      fc.property(near, (id) => {
        const ok = valid({ derivative_id: id, ...DISPLAY });
        expect(ok, JSON.stringify(id)).toBe(ID.test(id));
        if (ok) accepted++;
      }),
      { numRuns: 3000 },
    );
    expect(accepted).toBeGreaterThan(300);
  });
});

describe('the contract ships no address check for a pick', () => {
  it('exports nothing that takes a media base or a url: a pick is an id, so no host is ever compared', () => {
    for (const name of ['isPublicImageUrl', 'PUBLIC_IMAGE_URL_PATTERN', 'PUBLIC_IMAGE_URL_MAX_LENGTH']) expect(contract).not.toHaveProperty(name);
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
    return valid(payload) ? { expect: 'accepted' } : { expect: 'payload_invalid', why: 'schema' };
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

  it('covers a valid pick, a bad id shape, uppercase hex, a wrong length and the DELETE', () => {
    const count = (prefix: string, expect_: Push['expect'], why?: Push['why']) =>
      vectors.pushes.filter((p) => p.name.startsWith(prefix) && p.expect === expect_ && p.why === why).length;
    expect(count('a pick', 'accepted')).toBe(3);
    expect(count('bad shape', 'payload_invalid', 'schema')).toBeGreaterThanOrEqual(20);
    expect(count('uppercase hex', 'payload_invalid', 'schema')).toBe(2);
    expect(count('wrong length', 'payload_invalid', 'schema')).toBe(5);
    expect(count('DELETE', 'accepted')).toBe(1);
    expect(count('DELETE', 'payload_invalid', 'delete_payload')).toBe(2);
    expect(vectors.pushes.filter((p) => !/^(a pick|bad shape|uppercase hex|wrong length|DELETE)/.test(p.name))).toEqual([]);
  });

  it('writes each wrong-length and uppercase case as what its name says, and nothing else wrong with it', () => {
    const id = (p: Push) => String(p.body!.derivative_id);
    for (const p of vectors.pushes.filter((q) => q.name.startsWith('wrong length'))) {
      const m = /(\d+) characters/.exec(p.name);
      expect(id(p), p.name).toHaveLength(m === null ? 0 : Number(m[1]));
      expect(id(p), p.name).toMatch(/^[0-9a-f]*$/);
    }
    for (const p of vectors.pushes.filter((q) => q.name.startsWith('uppercase hex'))) {
      expect(id(p), p.name).toHaveLength(64);
      expect(id(p), p.name).not.toMatch(ID);
      expect(id(p).toLowerCase(), p.name).toMatch(ID);
    }
    for (const p of vectors.pushes.filter((q) => / in 64 characters/.test(q.name))) expect(id(p), p.name).toHaveLength(64);
    for (const p of vectors.pushes.filter((q) => q.expect === 'accepted' && q.op === 'UPSERT')) expect(id(p), p.name).toMatch(ID);
  });
});

describe('golden photo-pick vectors: what is shown', () => {
  // The client rule: a pick is shown only while the figure's image list carries its id; otherwise it reads as no pick.
  const shown = (pick: string | null, images: readonly string[]): string | null => (pick !== null && images.includes(pick) ? pick : null);

  it.each(vectors.shown.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(shown(c.pick, c.images)).toBe(c.expect);
  });

  it('writes every id in the cases as a derivative id, and never shows one the list lacks', () => {
    for (const c of vectors.shown) {
      for (const id of [...c.images, ...(c.pick === null ? [] : [c.pick])]) expect(id, c.name).toMatch(ID);
      expect(new Set(c.images).size, c.name).toBe(c.images.length);
      if (c.expect !== null) expect(c.images, c.name).toContain(c.expect);
      if (c.expect !== null) expect(c.expect, c.name).toBe(c.pick);
    }
  });

  it('covers a pick in the list, a pick no longer in it, an empty list and no pick, and a missing pick reads as no pick', () => {
    const cases = vectors.shown;
    expect(cases.filter((c) => c.pick !== null && c.expect === c.pick).length).toBeGreaterThanOrEqual(2);
    const gone = cases.filter((c) => c.pick !== null && c.expect === null);
    expect(gone.length).toBeGreaterThanOrEqual(3);
    expect(gone.some((c) => /no longer in the figure's image list/.test(c.name) && c.images.length > 0)).toBe(true);
    expect(gone.some((c) => c.images.length === 0)).toBe(true);
    const none = cases.filter((c) => c.pick === null);
    expect(none).toHaveLength(1);
    // "shown as no pick": the outcome of a pick the list lacks is the outcome of having no pick at all
    for (const c of gone) expect(c.expect).toBe(none[0]!.expect);
  });
});

describe('golden photo-pick vectors: last writer wins', () => {
  const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
  // What a reader does with a feed of one facet's events: apply iff the version is greater than the one held.
  const settle = (events: PickEvent[]) => {
    let held: PickEvent | undefined;
    for (const e of events) if (held === undefined || compareVersion(e.version, held.version) > 0) held = e;
    return held === undefined || held.op === 'DELETE' ? null : held.derivative_id;
  };

  it('uses canonical device versions, an id on every UPSERT and none on a DELETE', () => {
    expect(vectors.lastWriterWins.length).toBeGreaterThanOrEqual(6);
    for (const c of vectors.lastWriterWins)
      for (const e of c.events) {
        expect(isCanonicalVersion(e.version), `${c.name}: ${e.version}`).toBe(true);
        if (e.op === 'UPSERT') expect(e.derivative_id, c.name).toMatch(ID);
        else expect(e.derivative_id, c.name).toBeUndefined();
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

describe('sync.proto and README: the photo pick', () => {
  const sync = read('proto/coordinator/v1/sync.proto');
  const rule6 = prose(sync.slice(sync.indexOf(' 6. USER-OWNED FACET KEYS'), sync.indexOf(' 7. TRANSACTIONS, AND WHAT IS DEFERRED')));
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json')) as { exports: Record<string, string> };

  it('lists the key in the user-owned table with its payload', () => {
    expect(rule6).toContain('photo/{head_id}/pick {"derivative_id": "64 lowercase hex"}');
  });

  it('says the pick is an image id, never an address, so no host is trusted or compared', () => {
    expect(rule6).toMatch(/PHOTO PICK \(0\.9\.0\)\. photo\/\{head_id\}\/pick is the photo the user chose to show for the figure \{head_id\}/);
    expect(rule6).toMatch(/Its payload names one derivative by its derivative_id, as ProductImage\.derivative_id carries it \(catalog\.proto\): the 64 lowercase hex characters of the SHA-256 of its bytes/);
    expect(rule6).toMatch(/Never an address: a pick carries no url, host or path, so nothing a device pushes is ever fetched/);
    expect(rule6).not.toMatch(/isPublicImageUrl|media base \(isPublic/);
  });

  it('states last writer wins and that "use default" is a DELETE', () => {
    expect(rule6).toMatch(/LAST WRITER WINS: there is one pick per user and figure, the event with the greater version replaces the other on every device, and two picks are never merged/);
    expect(rule6).toMatch(/"Use default" is a DELETE: the tombstone wins or loses by its version like any pick, and while it stands the figure shows its primary on every device/);
  });

  it('shows a pick only from the figure\'s own image list, and keeps it out of the library', () => {
    expect(rule6).toMatch(/A client shows a pick only while the figure's GetProductImages list carries an image with that derivative_id, and draws it from that entry's url/);
    expect(rule6).toMatch(/it shows the default, exactly as if there were no pick, and keeps the facet/);
    expect(rule6).toMatch(/The server checks the id's form only/);
    expect(rule6).toMatch(/A pick is a display preference and never a library reference/);
  });

  it('README names the facet and its vectors, and package.json exports the vectors', () => {
    expect(readme).toMatch(/## Photo pick/);
    expect(readme).toMatch(/`photo\/\{head_id\}\/pick` \(0\.9\.0, additive: one new key, no field and no existing schema changed\)/);
    expect(readme).toContain('golden/photo-pick-vectors.json');
    expect(readme).not.toContain('isPublicImageUrl');
    expect(readme).not.toContain('src/public-image.ts');
    expect(pkg.exports['./golden/photo-pick-vectors.json']).toBe('./golden/photo-pick-vectors.json');
  });
});
