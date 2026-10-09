// golden/display-vectors.json, typed, and a reference evaluation of catalog.proto DISPLAY RESTRICTIONS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Context = 'owner' | 'share_link' | 'anonymous';
export type Level = 'image' | 'product' | 'source';
export type Target = 'image' | 'mask';
export type GroundingFrom = 'mask' | 'own_alpha' | 'unset';

export interface Restriction {
  rule: string;
  // A Level or Scopes key when valid; anything else fails closed.
  level: string;
  subject: string;
  scope: string;
}

export interface DisplayImage {
  image_id: string;
  // The head the image belongs to and every id that resolves to it.
  product_ids: string[];
  sources: string[];
  has_mask: boolean;
  // The derivative carries an alpha channel of its own.
  has_own_alpha: boolean;
}

export interface Outcome {
  image: boolean;
  mask: boolean;
  // What the grounding fields (bottom_margin_frac, contact_band) are measured on.
  grounding_from: GroundingFrom;
  // thumbhash and dominant_color are computed with the mask applied.
  appearance_masked: boolean;
  denials: { rule: string; scope: string }[];
}

export interface DisplayCase {
  name: string;
  image: DisplayImage;
  restrictions: Restriction[];
  context: Context;
  expect: Outcome;
}

export interface ListImage extends DisplayImage {
  role: string;
  primary: boolean;
}

export interface ShownImage {
  image_id: string;
  role: string;
  primary: boolean;
}

export interface ListCase {
  name: string;
  // One product's images in render order, as the spine sends them: the primary first, then the gallery.
  images: ListImage[];
  restrictions: Restriction[];
  context: Context;
  expect: { images: ShownImage[] };
}

export interface DisplayVectors {
  contexts: Context[];
  levels: Level[];
  scopes: Record<string, { withholds: Target; from: Context[] }>;
  cases: DisplayCase[];
  lists: ListCase[];
}

export const displayVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../golden/display-vectors.json', import.meta.url)), 'utf8'),
) as DisplayVectors;

export type Scopes = DisplayVectors['scopes'];

const ALL_CONTEXTS: Context[] = ['owner', 'share_link', 'anonymous'];

// An unrecognised scope fails closed: it withholds the image from every viewer context. A scope is recognised only as an
// own key of the table, so a name such as "constructor" is unrecognised too.
export const scopeOf = (r: Restriction, scopes: Scopes): Scopes[string] =>
  Object.hasOwn(scopes, r.scope) ? scopes[r.scope]! : { withholds: 'image', from: ALL_CONTEXTS };

// ASCII case only: A-Z to a-z, no other character folded.
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));

// Subjects match without regard to ASCII case; an unrecognised level fails closed and matches any id of the image.
export const applies = (r: Restriction, img: DisplayImage): boolean => {
  const subject = asciiLower(r.subject);
  const is = (id: string) => asciiLower(id) === subject;
  switch (r.level) {
    case 'image':
      return is(img.image_id);
    case 'product':
      return img.product_ids.some(is);
    case 'source':
      return img.sources.some(is);
    default:
      return [img.image_id, ...img.product_ids, ...img.sources].some(is);
  }
};

const byRule = (a: { rule: string }, b: { rule: string }) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);

// Deny-only, the union of what every applying restriction that covers the viewer context names. A denial is logged
// only when something the image has was withheld, naming the rules that withheld it: the image's rules when the image
// is withheld, else the mask's rules when it has a mask. Anything else withheld nothing (logged at debug level only).
export function evaluate(c: Pick<DisplayCase, 'image' | 'restrictions' | 'context'>, scopes: Scopes): Outcome {
  const covering = c.restrictions.filter((r) => applies(r, c.image) && scopeOf(r, scopes).from.includes(c.context));
  const imageRules = covering.filter((r) => scopeOf(r, scopes).withholds === 'image');
  const maskRules = covering.filter((r) => scopeOf(r, scopes).withholds === 'mask');
  const image = imageRules.length === 0;
  const mask = image && c.image.has_mask && maskRules.length === 0;
  const logged = !image ? imageRules : c.image.has_mask ? maskRules : [];
  return {
    image,
    mask,
    grounding_from: mask ? 'mask' : image && c.image.has_own_alpha ? 'own_alpha' : 'unset',
    appearance_masked: mask,
    denials: logged.map((r) => ({ rule: r.rule, scope: r.scope })).sort(byRule),
  };
}

// The list a viewer is sent: withheld images dropped; when the spine's primary is withheld, the first image shown is
// sent as the primary (primary set, its spine role kept, since no role names the primary), so the list reads as if the
// withheld image never existed.
export function evaluateList(c: Pick<ListCase, 'images' | 'restrictions' | 'context'>, scopes: Scopes): { images: ShownImage[] } {
  const shown = c.images.filter((image) => evaluate({ image, restrictions: c.restrictions, context: c.context }, scopes).image);
  const promote = c.images.some((i) => i.primary) && !shown.some((i) => i.primary);
  return {
    images: shown.map((i, k) => ({ image_id: i.image_id, role: i.role, primary: i.primary || (promote && k === 0) })),
  };
}
