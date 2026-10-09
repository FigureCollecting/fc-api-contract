import { describe, expect, it } from 'vitest';
import { applies, displayVectors as v, evaluate, type DisplayCase, type Outcome, type Scopes } from './support/display-model.js';

// catalog.proto DISPLAY RESTRICTIONS (Ross, 2026-09-26): masks and images are shown to every viewer by default; a
// restriction per image, product or source only withholds, evaluated with the viewer context; every denial is logged.
const SCOPES: Scopes = {
  no_display: { withholds: 'image', from: ['owner', 'share_link', 'anonymous'] },
  owner_views_only: { withholds: 'image', from: ['share_link', 'anonymous'] },
  no_share: { withholds: 'image', from: ['share_link'] },
  no_mask: { withholds: 'mask', from: ['owner', 'share_link', 'anonymous'] },
};

describe('golden display vectors (catalog.proto DISPLAY RESTRICTIONS)', () => {
  it('pin the three viewer contexts, the three levels and the four scopes', () => {
    expect(v.contexts).toEqual(['owner', 'share_link', 'anonymous']);
    expect(v.levels).toEqual(['image', 'product', 'source']);
    expect(v.scopes).toEqual(SCOPES);
  });

  it('show the image and its mask to every viewer when no restriction applies (masks in shared links by default)', () => {
    for (const context of v.contexts) {
      const c = v.cases.find((k) => k.restrictions.length === 0 && k.context === context && k.image.has_mask);
      expect(c, context).toBeDefined();
      expect(c!.expect).toEqual({ image: true, mask: true, denials: [] });
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

  it('have unique names', () => {
    expect(new Set(v.cases.map((c) => c.name)).size).toBe(v.cases.length);
  });

  it.each(v.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(evaluate(c, SCOPES)).toEqual(c.expect);
  });
});

// Each mutant gets one rule of the contract wrong; the vectors must catch every one.
const sortDenials = (o: Outcome): Outcome => ({ ...o, denials: [...o.denials].sort((a, b) => a.rule.localeCompare(b.rule)) });
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
    return { ...o, denials: o.denials.filter((d) => !seen.has(SCOPES[d.scope]!.withholds) && seen.add(SCOPES[d.scope]!.withholds)) };
  },
  'keeps the mask of a withheld image': (c) => {
    const o = evaluate(c, SCOPES);
    return { ...o, mask: c.image.has_mask && !c.restrictions.some((r) => applies(r, c.image) && SCOPES[r.scope]!.withholds === 'mask') };
  },
  'reports a mask the image does not have': (c) => {
    const o = evaluate(c, SCOPES);
    return { ...o, mask: o.image && !c.restrictions.some((r) => applies(r, c.image) && r.scope === 'no_mask' && SCOPES[r.scope]!.from.includes(c.context)) };
  },
  'lets owner_views_only through to anonymous viewers': (c) =>
    evaluate(c, { ...SCOPES, owner_views_only: { withholds: 'image', from: ['share_link'] } }),
  'withholds no_share from anonymous viewers too': (c) =>
    evaluate(c, { ...SCOPES, no_share: { withholds: 'image', from: ['share_link', 'anonymous'] } }),
  'exempts the owner from no_display': (c) =>
    evaluate(c, { ...SCOPES, no_display: { withholds: 'image', from: ['share_link', 'anonymous'] } }),
  'exempts shared links from no_mask': (c) =>
    evaluate(c, { ...SCOPES, no_mask: { withholds: 'mask', from: ['owner', 'anonymous'] } }),
  'lets the first applying rule decide': (c) => {
    const first = c.restrictions.find((r) => applies(r, c.image));
    return evaluate({ ...c, restrictions: first ? [first] : [] }, SCOPES);
  },
  'checks only the first source': (c) => evaluate({ ...c, image: { ...c.image, sources: c.image.sources.slice(0, 1) } }, SCOPES),
  'checks only the head, not the ids that resolve to it': (c) => evaluate({ ...c, image: { ...c.image, product_ids: c.image.product_ids.slice(0, 1) } }, SCOPES),
};

describe('golden display vectors catch every mutant of the rule', () => {
  it.each(Object.keys(MUTANTS))('%s', (name) => {
    const caught = v.cases.filter((c) => JSON.stringify(sortDenials(MUTANTS[name]!(c))) !== JSON.stringify(c.expect));
    expect(caught.length, name).toBeGreaterThan(0);
  });
});
