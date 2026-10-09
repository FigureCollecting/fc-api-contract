import { describe, expect, it } from 'vitest';
import {
  applies,
  displayVectors as v,
  evaluate,
  evaluateList,
  scopeOf,
  type DisplayCase,
  type ListCase,
  type Outcome,
  type Scopes,
  type ShownImage,
} from './support/display-model.js';

// catalog.proto DISPLAY RESTRICTIONS (Ross, 2026-09-26; orchestrator ruling 2026-10-09): masks and images are shown to
// every viewer by default; a restriction per image, product or source only withholds, evaluated with the viewer context;
// an unrecognised one fails closed; a denial is logged only when something was withheld; a withheld primary is replaced.
const SCOPES: Scopes = {
  no_display: { withholds: 'image', from: ['owner', 'share_link', 'anonymous'] },
  owner_views_only: { withholds: 'image', from: ['share_link', 'anonymous'] },
  no_share: { withholds: 'image', from: ['share_link', 'anonymous'] },
  no_mask: { withholds: 'mask', from: ['owner', 'share_link', 'anonymous'] },
};
const known = (r: { scope: string; level: string }) => r.scope in SCOPES && (v.levels as string[]).includes(r.level);
const shownWithMaskWithheld = (c: DisplayCase) => c.expect.image && c.image.has_mask && !c.expect.mask;

describe('golden display vectors (catalog.proto DISPLAY RESTRICTIONS)', () => {
  it('pin the three viewer contexts, the three levels and the four scopes, no_share covering anonymous viewers too', () => {
    expect(v.contexts).toEqual(['owner', 'share_link', 'anonymous']);
    expect(v.levels).toEqual(['image', 'product', 'source']);
    expect(v.scopes).toEqual(SCOPES);
  });

  it('show the image and its mask to every viewer when no restriction applies (masks in shared links by default)', () => {
    for (const context of v.contexts) {
      const c = v.cases.find((k) => k.restrictions.length === 0 && k.context === context && k.image.has_mask);
      expect(c, context).toBeDefined();
      expect(c!.expect).toEqual({ image: true, mask: true, grounding_from: 'mask', appearance_masked: true, denials: [] });
    }
  });

  it('cover every scope in every viewer context, alone, and every level', () => {
    for (const scope of Object.keys(SCOPES))
      for (const context of v.contexts)
        expect(v.cases.some((c) => c.context === context && c.restrictions.length === 1 && c.restrictions[0]!.scope === scope && applies(c.restrictions[0]!, c.image)), `${scope} ${context}`).toBe(true);
    for (const level of v.levels) {
      expect(v.cases.some((c) => c.restrictions.some((r) => r.level === level && applies(r, c.image))), `${level} applies`).toBe(true);
      expect(v.cases.some((c) => c.restrictions.some((r) => r.level === level && !applies(r, c.image))), `${level} misses`).toBe(true);
    }
  });

  it('cover an unrecognised scope in every viewer context and an unrecognised level that applies and one that misses (fail closed)', () => {
    for (const context of v.contexts)
      expect(v.cases.some((c) => c.context === context && c.restrictions.length === 1 && !(c.restrictions[0]!.scope in SCOPES) && c.expect.denials.length === 1), context).toBe(true);
    const unknownLevel = v.cases.flatMap((c) => c.restrictions.filter((r) => !(v.levels as string[]).includes(r.level)).map((r) => applies(r, c.image)));
    expect(unknownLevel).toContain(true);
    expect(unknownLevel).toContain(false);
    expect(v.cases.some((c) => c.restrictions.some((r) => known(r) && applies(r, c.image) && r.subject !== r.subject.toLowerCase()))).toBe(true);
  });

  it('cover the fields derived from the mask: a withheld mask with and without the derivative\'s own alpha, and a mask sent over own alpha', () => {
    expect(v.cases.some((c) => shownWithMaskWithheld(c) && c.image.has_own_alpha)).toBe(true);
    expect(v.cases.some((c) => shownWithMaskWithheld(c) && !c.image.has_own_alpha)).toBe(true);
    expect(v.cases.some((c) => c.expect.mask && c.image.has_own_alpha)).toBe(true);
    expect(v.cases.some((c) => !c.expect.image && c.image.has_own_alpha)).toBe(true);
  });

  it('cover evaluations that withhold nothing although a rule applies, and a mask rule under a withheld image (logged at debug only)', () => {
    expect(v.cases.some((c) => c.expect.denials.length === 0 && c.restrictions.some((r) => applies(r, c.image) && scopeOf(r, SCOPES).from.includes(c.context)))).toBe(true);
    expect(v.cases.some((c) => !c.expect.image && c.restrictions.some((r) => r.scope === 'no_mask' && applies(r, c.image)) && c.image.has_mask)).toBe(true);
  });

  it('have unique names', () => {
    expect(new Set(v.cases.map((c) => c.name)).size).toBe(v.cases.length);
    expect(new Set(v.lists.map((c) => c.name)).size).toBe(v.lists.length);
  });

  it.each(v.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(evaluate(c, SCOPES)).toEqual(c.expect);
  });
});

describe('golden display vectors: the list a viewer is sent (a withheld primary is replaced)', () => {
  const withheld = (c: ListCase) => c.images.filter((image) => !evaluate({ image, restrictions: c.restrictions, context: c.context }, SCOPES).image);

  it('cover a withheld primary with images left, with the next image withheld too, with nothing left, a withheld gallery image, the owner unaffected, and a spine list with no primary', () => {
    const primaryWithheld = (c: ListCase) => withheld(c).some((i) => i.primary);
    expect(v.lists.some((c) => primaryWithheld(c) && c.expect.images.length > 0)).toBe(true);
    expect(v.lists.some((c) => primaryWithheld(c) && withheld(c).length > 1 && c.expect.images.length > 0)).toBe(true);
    expect(v.lists.some((c) => c.images.length > 0 && c.expect.images.length === 0)).toBe(true);
    expect(v.lists.some((c) => withheld(c).length > 0 && !primaryWithheld(c))).toBe(true);
    expect(v.lists.some((c) => c.context === 'owner' && c.restrictions.length > 0 && withheld(c).length === 0)).toBe(true);
    expect(v.lists.some((c) => !c.images.some((i) => i.primary) && c.expect.images.length > 0)).toBe(true);
  });

  it('read as if a withheld image never existed: a list the spine sent with a primary has exactly one, first, with role "primary"', () => {
    for (const c of v.lists.filter((k) => k.images.some((i) => i.primary) && k.expect.images.length > 0)) {
      expect(c.expect.images.filter((i) => i.primary), c.name).toEqual([c.expect.images[0]]);
      expect(c.expect.images.filter((i) => i.role === 'primary'), c.name).toEqual([c.expect.images[0]]);
    }
  });

  it.each(v.lists.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(evaluateList(c, SCOPES)).toEqual(c.expect);
  });
});

// Each mutant gets one rule of the contract wrong; the vectors must catch every one.
const sortDenials = (o: Outcome): Outcome => ({ ...o, denials: [...o.denials].sort((a, b) => a.rule.localeCompare(b.rule)) });
const covering = (c: DisplayCase, target: 'image' | 'mask') =>
  c.restrictions.filter((r) => applies(r, c.image) && scopeOf(r, SCOPES).from.includes(c.context) && scopeOf(r, SCOPES).withholds === target).map((r) => ({ rule: r.rule, scope: r.scope }));
const MUTANTS: Record<string, (c: DisplayCase) => Outcome> = {
  'ignores the level (matches the subject against any id)': (c) =>
    evaluate({ ...c, restrictions: c.restrictions.map((r) => ({ ...r, level: r.subject === c.image.image_id ? 'image' : c.image.product_ids.includes(r.subject) ? 'product' : 'source' })) }, SCOPES),
  'logs only the first denial': (c) => {
    const o = evaluate(c, SCOPES);
    return { ...o, denials: o.denials.slice(0, 1) };
  },
  'logs only what was not already withheld': (c) => {
    const o = evaluate(c, SCOPES);
    const seen = new Set<string>();
    const target = (d: { scope: string }) => scopeOf({ rule: '', level: '', subject: '', ...d }, SCOPES).withholds;
    return { ...o, denials: o.denials.filter((d) => !seen.has(target(d)) && seen.add(target(d))) };
  },
  'keeps the mask of a withheld image': (c) => {
    const o = evaluate(c, SCOPES);
    return { ...o, mask: c.image.has_mask && covering(c, 'mask').length === 0 };
  },
  'reports a mask the image does not have': (c) => {
    const o = evaluate(c, SCOPES);
    return { ...o, mask: o.image && covering(c, 'mask').length === 0 };
  },
  'lets owner_views_only through to anonymous viewers': (c) => evaluate(c, { ...SCOPES, owner_views_only: { withholds: 'image', from: ['share_link'] } }),
  'lets no_share through to anonymous viewers (the 0.4.0 draft)': (c) => evaluate(c, { ...SCOPES, no_share: { withholds: 'image', from: ['share_link'] } }),
  'exempts the owner from no_display': (c) => evaluate(c, { ...SCOPES, no_display: { withholds: 'image', from: ['share_link', 'anonymous'] } }),
  'exempts shared links from no_mask': (c) => evaluate(c, { ...SCOPES, no_mask: { withholds: 'mask', from: ['owner', 'anonymous'] } }),
  'lets the first applying rule decide': (c) => {
    const first = c.restrictions.find((r) => applies(r, c.image));
    return evaluate({ ...c, restrictions: first ? [first] : [] }, SCOPES);
  },
  'checks only the first source': (c) => evaluate({ ...c, image: { ...c.image, sources: c.image.sources.slice(0, 1) } }, SCOPES),
  'checks only the head, not the ids that resolve to it': (c) => evaluate({ ...c, image: { ...c.image, product_ids: c.image.product_ids.slice(0, 1) } }, SCOPES),
  'fails open on an unrecognised scope': (c) => evaluate({ ...c, restrictions: c.restrictions.filter((r) => r.scope in SCOPES) }, SCOPES),
  'reads an unrecognised scope as no_share': (c) => evaluate({ ...c, restrictions: c.restrictions.map((r) => (r.scope in SCOPES ? r : { ...r, scope: 'no_share' })) }, SCOPES),
  'fails open on an unrecognised level': (c) => evaluate({ ...c, restrictions: c.restrictions.filter((r) => (v.levels as string[]).includes(r.level)) }, SCOPES),
  'matches subjects case-sensitively': (c) => {
    const ids = { image: [c.image.image_id], product: c.image.product_ids, source: c.image.sources } as Record<string, string[]>;
    const exact = (r: DisplayCase['restrictions'][number]) => (ids[r.level] ?? [c.image.image_id, ...c.image.product_ids, ...c.image.sources]).includes(r.subject);
    return evaluate({ ...c, restrictions: c.restrictions.filter(exact) }, SCOPES);
  },
  'logs every applying rule that covers the context (the 0.4.0 draft)': (c) => ({ ...evaluate(c, SCOPES), denials: [...covering(c, 'image'), ...covering(c, 'mask')] }),
  'logs a mask rule when the image itself is withheld': (c) => {
    const o = evaluate(c, SCOPES);
    return o.image ? o : { ...o, denials: [...covering(c, 'image'), ...covering(c, 'mask')] };
  },
  'logs no_mask on an image without a mask': (c) => {
    const o = evaluate(c, SCOPES);
    return o.image && !c.image.has_mask ? { ...o, denials: covering(c, 'mask') } : o;
  },
  'grounds on a withheld mask': (c) => {
    const o = evaluate(c, SCOPES);
    return o.image && c.image.has_mask ? { ...o, grounding_from: 'mask' } : o;
  },
  'leaves the grounding unset when the mask is withheld, despite own alpha': (c) => {
    const o = evaluate(c, SCOPES);
    return o.grounding_from === 'own_alpha' && c.image.has_mask ? { ...o, grounding_from: 'unset' } : o;
  },
  'grounds on own alpha even when the mask is sent': (c) => {
    const o = evaluate(c, SCOPES);
    return o.mask && c.image.has_own_alpha ? { ...o, grounding_from: 'own_alpha' } : o;
  },
  'reports grounding for a withheld image': (c) => {
    const o = evaluate(c, SCOPES);
    return !o.image && c.image.has_own_alpha ? { ...o, grounding_from: 'own_alpha' } : o;
  },
  'computes the thumbhash and color with a withheld mask': (c) => {
    const o = evaluate(c, SCOPES);
    return { ...o, appearance_masked: o.image && c.image.has_mask };
  },
};

const shown = (c: ListCase) => c.images.filter((image) => evaluate({ image, restrictions: c.restrictions, context: c.context }, SCOPES).image);
const plain = (i: ShownImage) => ({ image_id: i.image_id, role: i.role, primary: i.primary });
const LIST_MUTANTS: Record<string, (c: ListCase) => { images: ShownImage[] }> = {
  'leaves a withheld primary unreplaced (the 0.4.0 draft)': (c) => ({ images: shown(c).map(plain) }),
  'promotes without rewriting the role': (c) => ({ images: evaluateList(c, SCOPES).images.map((i, k) => (k === 0 && i.primary ? { ...i, role: c.images.find((x) => x.image_id === i.image_id)!.role } : i)) }),
  'promotes the last image shown': (c) => {
    const s = shown(c).map(plain);
    const promote = c.images.some((i) => i.primary) && !s.some((i) => i.primary) && s.length > 0;
    return { images: promote ? s.map((i, k) => (k === s.length - 1 ? { ...i, role: 'primary', primary: true } : i)) : s };
  },
  'promotes the first image when the spine sent no primary': (c) => ({ images: shown(c).map((i, k) => (k === 0 ? { image_id: i.image_id, role: 'primary', primary: true } : plain(i))) }),
  'keeps the withheld images in the list': (c) => ({ images: c.images.map(plain) }),
};

describe('golden display vectors catch every mutant of the rule', () => {
  it.each(Object.keys(MUTANTS))('%s', (name) => {
    const caught = v.cases.filter((c) => JSON.stringify(sortDenials(MUTANTS[name]!(c))) !== JSON.stringify(c.expect));
    expect(caught.length, name).toBeGreaterThan(0);
  });

  it.each(Object.keys(LIST_MUTANTS))('list: %s', (name) => {
    const caught = v.lists.filter((c) => JSON.stringify(LIST_MUTANTS[name]!(c)) !== JSON.stringify(c.expect));
    expect(caught.length, name).toBeGreaterThan(0);
  });
});
