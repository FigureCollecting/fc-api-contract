import { describe, expect, it } from 'vitest';
import { displayVectors as v, evaluate, evaluateTiers, type Scopes, type TierCase } from './support/display-model.js';

// catalog.proto ImageTier (0.8.0): a tier has no status of its own. The derivative's tiers are sent only with the image
// and the mask's tiers only inside the mask, so whatever withholds the image or the mask withholds its tiers too.
// golden/display-vectors.json `tiers` has the cases; `cases` and `lists` are unchanged, so a consumer that pins them
// (fc-coordinator counts 51 cases and 9 lists) is unaffected.
const SCOPES: Scopes = v.scopes;
const IMAGE_SCOPES = Object.keys(SCOPES).filter((s) => SCOPES[s]!.withholds === 'image');
const tierCases = v.tiers;
const outcome = (c: TierCase) => evaluate(c, SCOPES);
const named = (prefix: string) => tierCases.filter((c) => c.name.startsWith(prefix));

describe('golden tier vectors (catalog.proto ImageTier)', () => {
  it('leave the 0.7.0 cases and lists as they were', () => {
    expect(v.cases).toHaveLength(51);
    expect(v.lists).toHaveLength(9);
  });

  it('carry "no_mask drops mask tiers": the image and its tiers sent, the mask and its tiers not', () => {
    const found = named('no_mask drops mask tiers');
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      expect(c.restrictions.some((r) => r.scope === 'no_mask'), c.name).toBe(true);
      expect(c.image.tiers.length * c.image.mask_tiers.length, c.name).toBeGreaterThan(0);
      expect(c.expect, c.name).toEqual({ tiers: c.image.tiers, mask_tiers: [] });
    }
  });

  it('carry "withheld image drops its tiers" for every scope that withholds the image and for an unrecognised one', () => {
    const found = named('withheld image drops its tiers');
    for (const scope of [...IMAGE_SCOPES, 'unrecognised'])
      expect(found.some((c) => c.restrictions.some((r) => (scope === 'unrecognised' ? !Object.hasOwn(SCOPES, r.scope) : r.scope === scope))), scope).toBe(true);
    for (const c of found) {
      expect(c.image.tiers.length * c.image.mask_tiers.length, c.name).toBeGreaterThan(0);
      expect(c.expect, c.name).toEqual({ tiers: [], mask_tiers: [] });
    }
  });

  it('cover every tier sent as held, an image without a mask, an image with no tiers yet, and mask tiers not minted yet', () => {
    expect(tierCases.some((c) => c.restrictions.length === 0 && c.image.has_mask && c.expect.tiers.length > 0 && c.expect.mask_tiers.length > 0)).toBe(true);
    expect(tierCases.some((c) => !c.image.has_mask && c.expect.tiers.length > 0)).toBe(true);
    expect(tierCases.some((c) => c.image.tiers.length === 0 && outcome(c).image)).toBe(true);
    expect(tierCases.some((c) => c.image.has_mask && c.image.mask_tiers.length === 0 && c.image.tiers.length > 0 && outcome(c).mask)).toBe(true);
    expect(tierCases.some((c) => c.restrictions.length > 0 && outcome(c).image && outcome(c).mask && c.expect.mask_tiers.length > 0)).toBe(true);
  });

  it('hold only ladders the rule allows: strictly ascending, at most four, none past 4,096, no mask tiers without a mask', () => {
    for (const c of tierCases)
      for (const list of [c.image.tiers, c.image.mask_tiers]) {
        expect(list.every((e, k) => Number.isInteger(e) && e > 0 && e <= 4096 && (k === 0 || e > list[k - 1]!)), c.name).toBe(true);
        expect(list.length, c.name).toBeLessThanOrEqual(4);
      }
    for (const c of tierCases.filter((k) => !k.image.has_mask)) expect(c.image.mask_tiers, c.name).toEqual([]);
  });

  it('have unique names', () => {
    expect(new Set(tierCases.map((c) => c.name)).size).toBe(tierCases.length);
  });

  it.each(tierCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(evaluateTiers(c, SCOPES)).toEqual(c.expect);
  });
});

// Each mutant gets one rule of tier withholding wrong; the vectors must catch every one.
const TIER_MUTANTS: Record<string, (c: TierCase) => TierCase['expect']> = {
  'keeps the mask tiers when no_mask withholds the mask': (c) => ({ tiers: outcome(c).image ? c.image.tiers : [], mask_tiers: outcome(c).image ? c.image.mask_tiers : [] }),
  'keeps the tiers of a withheld image': (c) => ({ tiers: c.image.tiers, mask_tiers: outcome(c).mask ? c.image.mask_tiers : [] }),
  'drops the image tiers with the mask': (c) => ({ tiers: outcome(c).mask ? c.image.tiers : [], mask_tiers: outcome(c).mask ? c.image.mask_tiers : [] }),
  'sends the mask tiers beside a withheld image': (c) => ({ tiers: outcome(c).image ? c.image.tiers : [], mask_tiers: c.image.mask_tiers }),
  'drops every tier on any restriction': (c) => (c.restrictions.length > 0 ? { tiers: [], mask_tiers: [] } : evaluateTiers(c, SCOPES)),
  'sends the mask tiers as the image tiers when the mask has none yet': (c) => {
    const o = evaluateTiers(c, SCOPES);
    return { ...o, mask_tiers: outcome(c).mask && o.mask_tiers.length === 0 ? o.tiers : o.mask_tiers };
  },
  'fails open on an unrecognised scope': (c) => evaluateTiers({ ...c, restrictions: c.restrictions.filter((r) => Object.hasOwn(SCOPES, r.scope)) }, SCOPES),
};

describe('golden tier vectors catch every mutant of the rule', () => {
  it.each(Object.keys(TIER_MUTANTS))('%s', (name) => {
    const caught = tierCases.filter((c) => JSON.stringify(TIER_MUTANTS[name]!(c)) !== JSON.stringify(c.expect));
    expect(caught.length, name).toBeGreaterThan(0);
  });
});
