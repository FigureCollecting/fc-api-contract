// The user-owned facet-key grammar (sync.proto rule 6) and the REJECTED reason
// codes. One spelling per facet: a second spelling of a key would be a second
// facet, so the parser is strict and only the builder folds case.

export const USER_FACET_FIELDS = ['status', 'count', 'score', 'note'] as const;
export type UserFacetField = (typeof USER_FACET_FIELDS)[number];

export const HOLDING_STATUSES = ['owned', 'ordered', 'wished'] as const;
export type HoldingStatus = (typeof HOLDING_STATUSES)[number];

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

/** Package-relative path of each field's payload JSON Schema (exported as ./schemas/*). */
export const USER_FACET_PAYLOAD_SCHEMAS: Readonly<Record<UserFacetField, string>> = {
  status: 'schemas/holding-status.schema.json',
  count: 'schemas/holding-count.schema.json',
  score: 'schemas/uf-score.schema.json',
  note: 'schemas/uf-note.schema.json',
};

export interface UserFacetKey {
  headId: string;
  field: UserFacetField;
}

const PREFIX: Readonly<Record<UserFacetField, 'holding' | 'uf'>> = {
  status: 'holding',
  count: 'holding',
  score: 'uf',
  note: 'uf',
};

const KEY_RE =
  /^(holding|uf)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(status|count|score|note)$/;
const HEAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parse a user-owned facet key; undefined for anything else, including a server-owned key. */
export function parseUserFacetKey(key: string): UserFacetKey | undefined {
  const m = KEY_RE.exec(key);
  if (m === null) return undefined;
  const field = m[3] as UserFacetField;
  if (PREFIX[field] !== m[1]) return undefined;
  return { headId: m[2]!, field };
}

/** Build the canonical key for a head id and field. Throws TypeError on anything else. */
export function userFacetKey(headId: string, field: UserFacetField): string {
  const head = headId.toLowerCase();
  if (!HEAD_RE.test(head)) throw new TypeError(`not a head id: ${JSON.stringify(headId)}`);
  if (!Object.hasOwn(PREFIX, field)) throw new TypeError(`not a user facet field: ${JSON.stringify(field)}`);
  return `${PREFIX[field]}/${head}/${field}`;
}
