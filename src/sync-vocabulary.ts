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
  'res/answer',
  'pref/import',
] as const;
export type UserFacetFamily = (typeof USER_FACET_FAMILIES)[number];

export const SERVER_FACET_FAMILIES = ['occ/origin', 'imp/figure', 'imp/held', 'imp/change', 'imp/align', 'imp/import'] as const;
export type ServerFacetFamily = (typeof SERVER_FACET_FAMILIES)[number];
export type FacetFamily = UserFacetFamily | ServerFacetFamily;

/**
 * The per-figure items the import keeps on the feed (import.proto THE SERVER DECIDES), keyed
 * imp/{site}/{item}/{head_id}: a figure item, held edits, a change entry and an align-MFC entry.
 */
export const IMPORT_ITEMS = ['figure', 'held', 'change', 'align'] as const;
export type ImportItem = (typeof IMPORT_ITEMS)[number];

export const PUSH_REJECT_REASONS = [
  'version_malformed',
  'version_future',
  'facet_key_not_user_owned',
  'device_mismatch',
  'payload_invalid',
  'basis_missing',
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
  | { family: 'tag/name'; tagId: string }
  | { family: 'res/answer'; site: string; headId: string }
  | { family: 'pref/import'; site: string };

export type ServerFacetKey =
  | { family: 'occ/origin'; occId: string }
  | { family: `imp/${ImportItem}`; site: string; headId: string }
  | { family: 'imp/import'; site: string };

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
  'res/answer': 'schemas/res-answer.schema.json',
  'pref/import': 'schemas/pref-import.schema.json',
};

/** Package-relative path of each server-owned family's payload JSON Schema. */
export const SERVER_FACET_PAYLOAD_SCHEMAS: Readonly<Record<ServerFacetFamily, string>> = {
  'occ/origin': 'schemas/occ-origin.schema.json',
  'imp/figure': 'schemas/imp-figure.schema.json',
  'imp/held': 'schemas/imp-held.schema.json',
  'imp/change': 'schemas/imp-change.schema.json',
  'imp/align': 'schemas/imp-align.schema.json',
  'imp/import': 'schemas/imp-import.schema.json',
};

/** The payload schema a facet's UPSERT must satisfy. */
export function payloadSchemaPath(key: FacetKey): string {
  return (SERVER_FACET_PAYLOAD_SCHEMAS as Readonly<Record<string, string>>)[key.family] ?? USER_FACET_PAYLOAD_SCHEMAS[key.family as UserFacetFamily];
}

// ---------------------------------------------------------------------------
// Grammars: one anchored pattern per family. The property test checks no string matches two.
// ---------------------------------------------------------------------------
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KIND = `(?:${OCCURRENCE_STATUSES.join('|')})`;
const SITE = '[a-z][a-z0-9-]{0,31}';
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
const imp = (item: ImportItem): Rule => ({
  family: `imp/${item}`,
  owner: 'server',
  pattern: new RegExp(`^imp/(?<site>${SITE})/${item}/(?<head>${UUID})$`),
  from: (g) => ({ family: `imp/${item}`, site: g.site!, headId: g.head! }),
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
    family: 'res/answer',
    owner: 'user',
    pattern: new RegExp(`^res/(?<site>${SITE})/(?<head>${UUID})$`),
    from: (g) => ({ family: 'res/answer', site: g.site!, headId: g.head! }),
  },
  {
    family: 'pref/import',
    owner: 'user',
    pattern: new RegExp(`^pref/(?<site>${SITE})/import$`),
    from: (g) => ({ family: 'pref/import', site: g.site! }),
  },
  {
    family: 'occ/origin',
    owner: 'server',
    pattern: new RegExp(`^occ/(?<occ>${UUID})/origin$`),
    from: (g) => ({ family: 'occ/origin', occId: g.occ! }),
  },
  ...IMPORT_ITEMS.map(imp),
  {
    family: 'imp/import',
    owner: 'server',
    pattern: new RegExp(`^imp/(?<site>${SITE})/import$`),
    from: (g) => ({ family: 'imp/import', site: g.site! }),
  },
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

const siteOf = (value: unknown): string => (typeof value === 'string' && SITE_RE.test(value) ? value : fail('an import site', value));
/** One of the import's per-figure items: imp/{site}/{item}/{head_id} (import.proto THE SERVER DECIDES). */
export function importItemKey(site: string, item: ImportItem, headId: string): string {
  return `imp/${siteOf(site)}/${oneOf(IMPORT_ITEMS, item, 'an import item')}/${uuid(headId, 'a head id')}`;
}
/** The marker every import writes last: imp/{site}/import. */
export function importMarkerKey(site: string): string {
  return `imp/${siteOf(site)}/import`;
}
/** The user's answer to one of the figure's import items: res/{site}/{head_id}. */
export function answerKey(site: string, headId: string): string {
  return `res/${siteOf(site)}/${uuid(headId, 'a head id')}`;
}
/** The import's preferences: pref/{site}/import. */
export function importPrefKey(site: string): string {
  return `pref/${siteOf(site)}/import`;
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
    case 'res/answer':
      return answerKey(k.site as string, k.headId as string);
    case 'pref/import':
      return importPrefKey(k.site as string);
    case 'imp/import':
      return importMarkerKey(k.site as string);
    case 'imp/figure':
    case 'imp/held':
    case 'imp/change':
    case 'imp/align':
      return importItemKey(k.site as string, family.slice(4) as ImportItem, k.headId as string);
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
// The MFC import's ids (import.proto ROWS and OCCURRENCE IDS). An occurrence id is
// importOccIdFromMac(HMAC-SHA256(key, mfcImportOccName(...))) under a key only the coordinator holds.
// ---------------------------------------------------------------------------
/** The canonical MFC item id: leading zeros stripped, then 1 to 64 ASCII digits. TypeError otherwise. */
export function canonicalMfcId(raw: string): string {
  const id = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? raw.replace(/^0+/, '') : '';
  return /^[1-9][0-9]{0,63}$/.test(id) ? id : fail('an MFC item id', raw);
}

/** The HMAC message naming copy `ordinal` of an MFC row: "{user_id}:mfc:{canonical mfc_id}:{ordinal}". */
export function mfcImportOccName(userId: string, mfcId: string, ordinal: number): string {
  const user = uuid(userId, 'a user id');
  const id = canonicalMfcId(mfcId);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99) fail('an ordinal 1..99', ordinal);
  return `${user}:mfc:${id}:${ordinal}`;
}

/** An import copy's occ id from its HMAC-SHA256: the first 16 bytes as an RFC 9562 version 8 uuid. */
export function importOccIdFromMac(mac: Uint8Array): string {
  if (!(mac instanceof Uint8Array) || mac.length !== 32) fail('a 32-byte HMAC-SHA256', mac);
  const b = Uint8Array.from(mac.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
