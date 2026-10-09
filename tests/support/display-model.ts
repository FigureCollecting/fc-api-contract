// golden/display-vectors.json, typed, and a reference evaluation of catalog.proto DISPLAY RESTRICTIONS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Context = 'owner' | 'share_link' | 'anonymous';
export type Level = 'image' | 'product' | 'source';
export type Target = 'image' | 'mask';

export interface Restriction {
  rule: string;
  level: Level;
  subject: string;
  scope: string;
}

export interface DisplayImage {
  image_id: string;
  // The head the image belongs to and every id that resolves to it.
  product_ids: string[];
  sources: string[];
  has_mask: boolean;
}

export interface Outcome {
  image: boolean;
  mask: boolean;
  denials: { rule: string; scope: string }[];
}

export interface DisplayCase {
  name: string;
  image: DisplayImage;
  restrictions: Restriction[];
  context: Context;
  expect: Outcome;
}

export interface DisplayVectors {
  contexts: Context[];
  levels: Level[];
  scopes: Record<string, { withholds: Target; from: Context[] }>;
  cases: DisplayCase[];
}

export const displayVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../golden/display-vectors.json', import.meta.url)), 'utf8'),
) as DisplayVectors;

export type Scopes = DisplayVectors['scopes'];

export const applies = (r: Restriction, img: DisplayImage): boolean => {
  switch (r.level) {
    case 'image':
      return r.subject === img.image_id;
    case 'product':
      return img.product_ids.includes(r.subject);
    case 'source':
      return img.sources.includes(r.subject);
  }
};

// Deny-only: every restriction that applies and covers the viewer context withholds its target and is logged.
export function evaluate(c: Pick<DisplayCase, 'image' | 'restrictions' | 'context'>, scopes: Scopes): Outcome {
  const denying = c.restrictions.filter((r) => applies(r, c.image) && scopes[r.scope]!.from.includes(c.context));
  const withheld = new Set(denying.map((r) => scopes[r.scope]!.withholds));
  const image = !withheld.has('image');
  return {
    image,
    mask: image && c.image.has_mask && !withheld.has('mask'),
    denials: denying.map((r) => ({ rule: r.rule, scope: r.scope })).sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)),
  };
}
