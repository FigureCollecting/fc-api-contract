// import.proto CONFLICTS and sync.proto rule 6, IMPORT CONFLICTS, on the server: a Push landing on a key K that
// holds an import conflict, written the simplest way so golden/import-vectors.json `conflictPushes` are
// executed here, not only stated. `now` is the server's clock when it applies the push.
import { compareVersion } from '../../src/index.js';
import type { Facet } from './crossing-model.js';

/** imp/{site}/conflict/{K}: its `against` and the facet's own version. */
export interface ConflictFacet {
  against?: string;
  version: string;
}
export interface ConflictState {
  K?: Facet;
  conflict: ConflictFacet;
}

const pending = (s: ConflictState) => (s.conflict.against === undefined ? s.K === undefined : s.K?.version === s.conflict.against);

export function pushOnConflict(state: ConflictState, event: Facet, now: string) {
  if (state.K !== undefined && compareVersion(event.version, state.K.version) <= 0) {
    return { outcome: 'STALE' as const, K: state.K, conflict: state.conflict, pending: pending(state) };
  }
  let conflict = state.conflict;
  // Only a write above the conflict facet's own version resolves it; an older one that lands has not seen it.
  if (pending(state) && compareVersion(event.version, conflict.version) <= 0) {
    if (compareVersion(now, conflict.version) <= 0) throw new Error('a conflict is re-upserted above its current version');
    conflict = { against: event.version, version: now };
  }
  const after = { K: event, conflict };
  return { outcome: 'APPLIED' as const, ...after, pending: pending(after) };
}
