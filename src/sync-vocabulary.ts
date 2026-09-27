// The facet-key grammar (sync.proto rule 6, 0.3.0) and the REJECTED reason codes. One spelling
// per facet: a second spelling of a key would be a second facet, so the parsers are strict, only
// the builders fold case, and no string is claimed by two families (golden/key-vectors.json).

export const OCCURRENCE_STATUSES = ['owned', 'ordered', 'wished', 'former'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** A collection's kind is the status of the copies it holds. */
export const COLLECTION_KINDS = OCCURRENCE_STATUSES;
export type CollectionKind = OccurrenceStatus;

/** The id of each kind's implicit collection, and the only non-uuid id a key may carry. */
export const DEFAULT_COLLECTION_ID = 'default';

export const DISPOSAL_REASONS = ['sold', 'traded', 'gifted', 'damaged', 'lost', 'stolen', 'other'] as const;
export type DisposalReason = (typeof DISPOSAL_REASONS)[number];

export const OCC_FIELDS = ['head', 'status', 'collection', 'disposal'] as const;
export type OccField = (typeof OCC_FIELDS)[number];

export const UF_FIELDS = ['score', 'note', 'wishability'] as const;
export type UfField = (typeof UF_FIELDS)[number];

export const USER_FACET_FAMILIES = [
  'occ/head',
  'occ/status',
  'occ/collection',
  'occ/disposal',
  'occ/tag',
  'uf/score',
  'uf/note',
  'uf/wishability',
  'uf/tag',
  'uf/ktag',
  'coll/name',
  'tag/name',
] as const;
export type UserFacetFamily = (typeof USER_FACET_FAMILIES)[number];

export const SERVER_FACET_FAMILIES = ['occ/origin', 'imp/base', 'imp/conflict'] as const;
export type ServerFacetFamily = (typeof SERVER_FACET_FAMILIES)[number];
export type FacetFamily = UserFacetFamily | ServerFacetFamily;

/** The user-owned families the MFC import writes; it never writes a filing, a tag or a name. */
export const IMPORT_WRITTEN_FAMILIES = ['occ/head', 'occ/status', 'occ/disposal', 'uf/score', 'uf/note', 'uf/wishability'] as const;
export type ImportWrittenFamily = (typeof IMPORT_WRITTEN_FAMILIES)[number];

/** uuidv5 namespace of the MFC import's occurrence ids (import.proto): uuidv5(this, mfcImportOccName(...)). */
export const MFC_IMPORT_OCC_NAMESPACE = '43aafcfa-3970-4244-ac59-0b380a374980';

export const PUSH_REJECT_REASONS = [
  'version_malformed',
  'version_future',
  'facet_key_not_user_owned',
  'device_mismatch',
  'payload_invalid',
] as const;
export type PushRejectReason = (typeof PUSH_REJECT_REASONS)[number];

// A pushed SyncEvent payload over this many UTF-8 bytes is REJECTED payload_invalid
// ("payload over 65536 bytes"); every schema-valid payload JSON.stringify writes fits under it.
export const MAX_PAYLOAD_BYTES = 65_536;

export type UserFacetKey =
  | { family: `occ/${OccField}`; occId: string }
  | { family: 'occ/tag'; occId: string; tagId: string }
  | { family: `uf/${UfField}`; headId: string }
  | { family: 'uf/tag'; headId: string; tagId: string }
  | { family: 'uf/ktag'; headId: string; collKind: CollectionKind; tagId: string }
  | { family: 'coll/name'; collKind: CollectionKind; collId: string }
  | { family: 'tag/name'; tagId: string };

/** A user-owned key the import writes: the target of an imp/{site}/base|conflict key. */
export type ImportTargetKey =
  | { family: 'occ/head' | 'occ/status' | 'occ/disposal'; occId: string }
  | { family: 'uf/score' | 'uf/note' | 'uf/wishability'; headId: string };

export type ServerFacetKey =
  | { family: 'occ/origin'; occId: string }
  | { family: 'imp/base' | 'imp/conflict'; site: string; target: ImportTargetKey };

export type FacetKey = UserFacetKey | ServerFacetKey;

export interface CollectionRef {
  kind: CollectionKind;
  collId: string;
}

/** Package-relative path of each user-owned family's payload JSON Schema (exported as ./schemas/*). */
export const USER_FACET_PAYLOAD_SCHEMAS: Readonly<Record<UserFacetFamily, string>> = {
  'occ/head': 'schemas/occ-head.schema.json',
  'occ/status': 'schemas/occ-status.schema.json',
  'occ/collection': 'schemas/occ-collection.schema.json',
  'occ/disposal': 'schemas/occ-disposal.schema.json',
  'occ/tag': 'schemas/occ-tag.schema.json',
  'uf/score': 'schemas/uf-score.schema.json',
  'uf/note': 'schemas/uf-note.schema.json',
  'uf/wishability': 'schemas/uf-wishability.schema.json',
  'uf/tag': 'schemas/uf-tag.schema.json',
  'uf/ktag': 'schemas/uf-ktag.schema.json',
  'coll/name': 'schemas/coll-name.schema.json',
  'tag/name': 'schemas/tag-name.schema.json',
};

/** The server-owned families with a schema of their own; an imp/base payload uses its target's. */
export const SERVER_FACET_PAYLOAD_SCHEMAS: Readonly<Record<'occ/origin' | 'imp/conflict', string>> = {
  'occ/origin': 'schemas/occ-origin.schema.json',
  'imp/conflict': 'schemas/imp-conflict.schema.json',
};

/** The payload schema a facet's UPSERT must satisfy. */
export function payloadSchemaPath(key: FacetKey): string {
  if (key.family === 'imp/base') return USER_FACET_PAYLOAD_SCHEMAS[key.target.family];
  if (key.family === 'occ/origin' || key.family === 'imp/conflict') return SERVER_FACET_PAYLOAD_SCHEMAS[key.family];
  return USER_FACET_PAYLOAD_SCHEMAS[key.family];
}

// ---------------------------------------------------------------------------
// Grammars: one anchored pattern per family. The property test checks no string matches two.
// ---------------------------------------------------------------------------
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KIND = `(?:${OCCURRENCE_STATUSES.join('|')})`;
const SITE = '[a-z][a-z0-9-]{0,31}';
const importFields = (prefix: 'occ' | 'uf') =>
  IMPORT_WRITTEN_FAMILIES.filter((f) => f.startsWith(`${prefix}/`)).map((f) => f.slice(prefix.length + 1)).join('|');
const IMPORT_TARGET = `occ/${UUID}/(?:${importFields('occ')})|uf/${UUID}/(?:${importFields('uf')})`;
const UUID_RE = new RegExp(`^${UUID}$`);
const SITE_RE = new RegExp(`^${SITE}$`);

export interface FacetKeyGrammar {
  family: FacetFamily;
  owner: 'user' | 'server';
  pattern: RegExp;
}

type Groups = Record<string, string>;
interface Rule extends FacetKeyGrammar {
  from(g: Groups): FacetKey;
}

const occ = (field: OccField): Rule => ({
  family: `occ/${field}`,
  owner: 'user',
  pattern: new RegExp(`^occ/(?<occ>${UUID})/${field}$`),
  from: (g) => ({ family: `occ/${field}`, occId: g.occ! }),
});
const uf = (field: UfField): Rule => ({
  family: `uf/${field}`,
  owner: 'user',
  pattern: new RegExp(`^uf/(?<head>${UUID})/${field}$`),
  from: (g) => ({ family: `uf/${field}`, headId: g.head! }),
});
const imp = (family: 'imp/base' | 'imp/conflict'): Rule => ({
  family,
  owner: 'server',
  pattern: new RegExp(`^imp/(?<site>${SITE})/${family.slice(4)}/(?<target>${IMPORT_TARGET})$`),
  from: (g) => ({ family, site: g.site!, target: parseUserFacetKey(g.target!) as ImportTargetKey }),
});

const RULES: readonly Rule[] = [
  ...OCC_FIELDS.map(occ),
  {
    family: 'occ/tag',
    owner: 'user',
    pattern: new RegExp(`^occ/(?<occ>${UUID})/tag/(?<tag>${UUID})$`),
    from: (g) => ({ family: 'occ/tag', occId: g.occ!, tagId: g.tag! }),
  },
  ...UF_FIELDS.map(uf),
  {
    family: 'uf/tag',
    owner: 'user',
    pattern: new RegExp(`^uf/(?<head>${UUID})/tag/(?<tag>${UUID})$`),
    from: (g) => ({ family: 'uf/tag', headId: g.head!, tagId: g.tag! }),
  },
  {
    family: 'uf/ktag',
    owner: 'user',
    pattern: new RegExp(`^uf/(?<head>${UUID})/ktag/(?<kind>${KIND})/(?<tag>${UUID})$`),
    from: (g) => ({ family: 'uf/ktag', headId: g.head!, collKind: g.kind as CollectionKind, tagId: g.tag! }),
  },
  {
    family: 'coll/name',
    owner: 'user',
    pattern: new RegExp(`^coll/(?<kind>${KIND})/(?<coll>${UUID}|${DEFAULT_COLLECTION_ID})/name$`),
    from: (g) => ({ family: 'coll/name', collKind: g.kind as CollectionKind, collId: g.coll! }),
  },
  {
    family: 'tag/name',
    owner: 'user',
    pattern: new RegExp(`^tag/(?<tag>${UUID})/name$`),
    from: (g) => ({ family: 'tag/name', tagId: g.tag! }),
  },
  {
    family: 'occ/origin',
    owner: 'server',
    pattern: new RegExp(`^occ/(?<occ>${UUID})/origin$`),
    from: (g) => ({ family: 'occ/origin', occId: g.occ! }),
  },
  imp('imp/base'),
  imp('imp/conflict'),
];

/** Every family's grammar, user-owned first. Exposed so consumers can test the same no-overlap property. */
export const FACET_KEY_GRAMMARS: readonly FacetKeyGrammar[] = RULES.map(({ family, owner, pattern }) => ({ family, owner, pattern }));

function parseAs(owner: 'user' | 'server', key: unknown): FacetKey | undefined {
  if (typeof key !== 'string') return undefined;
  for (const rule of RULES) {
    if (rule.owner !== owner) continue;
    const m = rule.pattern.exec(key);
    if (m !== null) return rule.from(m.groups!);
  }
  return undefined;
}

/** Parse a user-owned facet key; undefined for anything else, a server-owned or retired key included. */
export function parseUserFacetKey(key: string): UserFacetKey | undefined {
  return parseAs('user', key) as UserFacetKey | undefined;
}

/** Parse a server-owned key this contract names (the client reads it and never pushes it). */
export function parseServerFacetKey(key: string): ServerFacetKey | undefined {
  return parseAs('server', key) as ServerFacetKey | undefined;
}

// ---------------------------------------------------------------------------
// Builders: the only place case is folded. Each throws TypeError on anything outside the grammar.
// ---------------------------------------------------------------------------
const fail = (what: string, value: unknown): never => {
  throw new TypeError(`not ${what}: ${JSON.stringify(value)}`);
};
const uuid = (value: unknown, what: string): string => {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  return UUID_RE.test(v) ? v : fail(what, value);
};
const collId = (value: unknown): string => {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  return v === DEFAULT_COLLECTION_ID || UUID_RE.test(v) ? v : fail('a collection id', value);
};
const kindOf = (value: unknown): CollectionKind =>
  (COLLECTION_KINDS as readonly unknown[]).includes(value) ? (value as CollectionKind) : fail('a collection kind', value);
const oneOf = <T extends string>(list: readonly T[], value: unknown, what: string): T =>
  (list as readonly unknown[]).includes(value) ? (value as T) : fail(what, value);

export function occFacetKey(occId: string, field: OccField): string {
  return `occ/${uuid(occId, 'an occurrence id')}/${oneOf(OCC_FIELDS, field, 'an occurrence field')}`;
}
export function occTagKey(occId: string, tagId: string): string {
  return `occ/${uuid(occId, 'an occurrence id')}/tag/${uuid(tagId, 'a tag id')}`;
}
export function ufFacetKey(headId: string, field: UfField): string {
  return `uf/${uuid(headId, 'a head id')}/${oneOf(UF_FIELDS, field, 'a figure field')}`;
}
export function ufTagKey(headId: string, tagId: string): string {
  return `uf/${uuid(headId, 'a head id')}/tag/${uuid(tagId, 'a tag id')}`;
}
export function ufKindTagKey(headId: string, kind: CollectionKind, tagId: string): string {
  return `uf/${uuid(headId, 'a head id')}/ktag/${kindOf(kind)}/${uuid(tagId, 'a tag id')}`;
}
export function collNameKey(kind: CollectionKind, id: string): string {
  return `coll/${kindOf(kind)}/${collId(id)}/name`;
}
export function tagNameKey(tagId: string): string {
  return `tag/${uuid(tagId, 'a tag id')}/name`;
}
export function occOriginKey(occId: string): string {
  return `occ/${uuid(occId, 'an occurrence id')}/origin`;
}

const importKey = (kind: 'base' | 'conflict', site: string, target: string): string => {
  if (typeof site !== 'string' || !SITE_RE.test(site)) fail('an import site', site);
  const parsed = parseUserFacetKey(typeof target === 'string' ? target.toLowerCase() : '');
  if (parsed === undefined || !(IMPORT_WRITTEN_FAMILIES as readonly string[]).includes(parsed.family)) {
    fail('a key the import writes', target);
  }
  return `imp/${site}/${kind}/${buildFacetKey(parsed!)}`;
};
export function importBaseKey(site: string, target: string): string {
  return importKey('base', site, target);
}
export function importConflictKey(site: string, target: string): string {
  return importKey('conflict', site, target);
}

/** Build the canonical key of any family. parse(buildFacetKey(x)) deep-equals x with its ids lowercased. */
export function buildFacetKey(key: FacetKey): string {
  const k = (key ?? {}) as Record<string, unknown>;
  const family = k.family;
  if (typeof family === 'string' && family.startsWith('occ/') && (OCC_FIELDS as readonly string[]).includes(family.slice(4))) {
    return occFacetKey(k.occId as string, family.slice(4) as OccField);
  }
  if (typeof family === 'string' && family.startsWith('uf/') && (UF_FIELDS as readonly string[]).includes(family.slice(3))) {
    return ufFacetKey(k.headId as string, family.slice(3) as UfField);
  }
  switch (family) {
    case 'occ/tag':
      return occTagKey(k.occId as string, k.tagId as string);
    case 'uf/tag':
      return ufTagKey(k.headId as string, k.tagId as string);
    case 'uf/ktag':
      return ufKindTagKey(k.headId as string, k.collKind as CollectionKind, k.tagId as string);
    case 'coll/name':
      return collNameKey(k.collKind as CollectionKind, k.collId as string);
    case 'tag/name':
      return tagNameKey(k.tagId as string);
    case 'occ/origin':
      return occOriginKey(k.occId as string);
    case 'imp/base':
    case 'imp/conflict':
      return importKey(family === 'imp/base' ? 'base' : 'conflict', k.site as string, buildFacetKey(k.target as FacetKey));
    default:
      return fail('a facet family', family);
  }
}

// ---------------------------------------------------------------------------
// Collection refs: the occ/{occ}/collection payload's "{kind}/{cid|default}".
// ---------------------------------------------------------------------------
const REF_RE = new RegExp(`^(?<kind>${KIND})/(?<coll>${UUID}|${DEFAULT_COLLECTION_ID})$`);

export function parseCollectionRef(ref: string): CollectionRef | undefined {
  const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
  return m === null ? undefined : { kind: m.groups!.kind as CollectionKind, collId: m.groups!.coll! };
}

export function collectionRef(kind: CollectionKind, id: string): string {
  return `${kindOf(kind)}/${collId(id)}`;
}

// ---------------------------------------------------------------------------
// The MFC import's occurrence ids: uuidv5(MFC_IMPORT_OCC_NAMESPACE, this name), k = 1..Count.
// ---------------------------------------------------------------------------
export function mfcImportOccName(userId: string, mfcId: string, ordinal: number): string {
  const user = uuid(userId, 'a user id');
  if (typeof mfcId !== 'string' || !/^[0-9]+$/.test(mfcId)) fail('an MFC item id', mfcId);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99) fail('an ordinal 1..99', ordinal);
  return `${user}:mfc:${mfcId}:${ordinal}`;
}
