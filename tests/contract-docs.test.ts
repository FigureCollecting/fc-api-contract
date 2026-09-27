import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const sync = read('proto/coordinator/v1/sync.proto');
const catalog = read('proto/coordinator/v1/catalog.proto');
const importProto = read('proto/coordinator/v1/import.proto');
const readme = read('README.md');
const hlcSource = read('src/hlc.ts');
const vocabSource = read('src/sync-vocabulary.ts');
const genSync = read('src/gen/coordinator/v1/sync_pb.ts');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  files: string[];
  exports: Record<string, unknown>;
  description: string;
  scripts: Record<string, string>;
};

// Collapse comment markers and whitespace so a rule reflowed across lines still matches.
const prose = (proto: string) => proto.replace(/^\s*(\/\/|\*) ?/gm, '').replace(/\s+/g, ' ');
// The SyncService ERROR CONTRACT, one string per bullet, so an assertion cannot be met by a neighbouring entry.
const errorEntries = () =>
  prose(sync.slice(sync.indexOf('ERROR CONTRACT:') + 'ERROR CONTRACT:'.length, sync.indexOf('service SyncService {')))
    .replace(/ -{10,} ?$/, '')
    .split(' * ')
    .map((e) => e.trim())
    .filter((e) => e !== '');
const errorEntry = (start: string) => {
  const found = errorEntries().filter((e) => e.startsWith(start));
  expect(found, start).toHaveLength(1);
  return found[0]!;
};

describe('sync.proto', () => {
  it('names the one exception to plain LWW where the merge rule is stated', () => {
    const header = prose(sync.slice(0, sync.indexOf('SEVEN RULES THIS SHAPE ENCODES')));
    expect(header).toMatch(/The one exception is an import write that crosses an open edit of the client's own \(rule 6, IMPORT CROSSINGS\): it is presented to the user, neither applied nor dropped\./);
  });

  it('no longer tells a client to keep its losing payload under the server version', () => {
    expect(sync).not.toMatch(/whatever the outcome/);
    expect(prose(sync)).toMatch(/adopt `current` whole/i);
    expect(prose(sync)).toMatch(/never pair the server's version with the client's losing payload/i);
  });

  it('writes the version grammar and its ordering table into the comment', () => {
    const text = prose(sync);
    expect(text).toMatch(/<instant>#<10-digit counter>#<32-hex device id>/);
    expect(sync).toContain('2026-09-14T11:30:00.123456Z#0000000000#00000000000000000000000000000000');
    expect(text).toMatch(/lowercase, dashless uuid/i);
    expect(text).toMatch(/reserved all-zero device id/i);
    expect(text).toMatch(/COLLATE "C"/);
  });

  it('trusts the wall clock after a forward gap and recovers a jump through rebase', () => {
    const text = prose(sync);
    expect(text).toMatch(/clamped only when the offset looks suspect/i);
    expect(text).toMatch(/a sleep \(monotonic time stalls\) or a wall-clock jump/i);
    expect(text).toMatch(/calls Hlc\.rebase\(\), adopts `current` and re-mints with Hlc\.tick\(base\)/i);
    expect(text).toMatch(/never clamps a base or an observed token/i);
  });

  it('states the bound the Hlc keeps, and when only the server backs it', () => {
    const text = prose(sync);
    expect(text).toMatch(/once anchored and rebased, a tick never passes server-now plus the clamp \(assuming the client's monotonic time keeps server rate\) while the anchor is fresh and every earlier edit minted past the bound has been answered, or re-minted after a rebase if unpushed, and re-minted if REJECTED version_future or dropped, after a rebase if past the fresh Status sample, for any other code/i);
    expect(text).not.toMatch(/while the anchor is fresh \(bar a 1 us carry/i);
    const firstStatus = /the client calls Hlc\.rebase\(\) after each session's first Status \(a no-op when the clock is not ahead\)/i;
    expect(text).toMatch(firstStatus);
    expect(prose(hlcSource.slice(hlcSource.indexOf('Drop whatever the clock holds'), hlcSource.indexOf('rebase(): boolean')))).toMatch(/call it after each session's first Status \(a no-op when the clock is not ahead\)/i);
    expect(text).toMatch(/a stale anchor may tick past server-now plus the clamp, and the server's version_future check is the backstop only when the push precedes real time catching up/i);
    expect(text).not.toMatch(/version_future check catches a jump/i);
    expect(text).toMatch(/the offset restored from the last one/i);
    expect(text).toMatch(/a phone on automatic time keeps its offset near zero and is unaffected/i);
  });

  it('floors every tick at the Status sample and every edit at its facet\'s version', () => {
    const text = prose(sync);
    expect(text).toMatch(/never below that Status sample plus the monotonic time elapsed since it/i);
    expect(text).toMatch(/before minting any edit the client hands the facet's current local version to Hlc\.tick\(base\)/i);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/re-mints with Hlc\.tick\(base\)/);
    expect(rejected).toMatch(/before minting any edit, not only a re-mint, the client hands Hlc\.tick the facet's current local version/i);
  });

  it('re-mints every unpushed edit past the new present after a rebase, not only the rejected one', () => {
    const text = prose(sync);
    expect(text).toMatch(/after any rebase, re-mint every unpushed edit past the new present, on its facet's server version/i);
    expect(text).toMatch(/a later edit on that facet takes the re-minted version as its base/i);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/re-mints the same way, on its facet's server version, every other unpushed edit minted before the rebase whose version is past the new present/i);
    const rebaseDoc = prose(hlcSource.slice(hlcSource.indexOf('Drop whatever the clock holds'), hlcSource.indexOf('rebase(): boolean')));
    expect(rebaseDoc).toMatch(/after any rebase, re-mint every unpushed edit past the new present \(above snapshot\(\)\), on its facet's server version/i);
    expect(rebaseDoc).toMatch(/a later edit on that facet takes the re-minted version as its base/i);
  });

  it('says a tick past the bound carries later ticks past it, through the clock and as a base, until it is answered', () => {
    const text = prose(sync);
    expect(text).toMatch(/it holds the clock ahead, and as a base it lifts the next edit on its facet/i);
    expect(text).toMatch(/until real time overtakes it or it has been answered, or re-minted after a rebase if unpushed, and re-minted if REJECTED version_future or dropped, after a rebase if past the fresh Status sample, for any other code, later ticks may pass the bound even on a fresh anchor/i);
    expect(text).not.toMatch(/it is answered, and re-minted if REJECTED, later ticks/i);
  });

  it('states the precondition of the bound wherever the bound is stated, and leaves an unanswered push to its retry', () => {
    const precondition = /every earlier edit minted past the bound has been answered, or re-minted after a rebase if unpushed, and re-minted if REJECTED version_future or dropped, after a rebase if past the fresh Status sample, for any other code/i;
    const inFlight = /an edit pushed but not yet answered is not re-minted in place: its retry carries the same client_id/i;
    const untilAnswered = /until it is answered, later ticks on that facet, and through the clock every later tick, may pass the bound/i;
    const text = prose(sync);
    expect(text).toMatch(precondition);
    expect(text).toMatch(inFlight);
    expect(text).toMatch(untilAnswered);
    const rebaseDoc = prose(hlcSource.slice(hlcSource.indexOf('Drop whatever the clock holds'), hlcSource.indexOf('rebase(): boolean')));
    expect(rebaseDoc).toMatch(precondition);
    expect(rebaseDoc).toMatch(inFlight);
    expect(rebaseDoc).toMatch(untilAnswered);
  });

  it('answers a replayed client_id with each event\'s recorded outcome and reason, and `current` re-read at the replay', () => {
    const clientId = prose(sync.slice(sync.indexOf('message PushRequest {'), sync.indexOf('string client_id = 1;')));
    const duplicate = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_APPLIED = 1;'), sync.indexOf('PUSH_OUTCOME_DUPLICATE = 2;')));
    const result = prose(sync.slice(sync.indexOf('message PushResult {'), sync.indexOf('SyncEvent current = 4;')));
    for (const text of [clientId, duplicate, result]) {
      expect(text).toMatch(/a replay \(same client_id, same events\) returns each event's recorded outcome and reason/i);
      expect(text).toMatch(/an event first APPLIED is answered DUPLICATE, one first REJECTED is REJECTED again with the same reason, one first STALE is STALE again and one first REVIEW is REVIEW again/i);
      expect(text).toMatch(/`current` on every replayed user-owned result is the facet as the server holds it at the replay/i);
    }
    for (const text of [sync, genSync]) expect(text).not.toMatch(/byte-identical/i);
    expect(duplicate).toMatch(/DUPLICATE answers only an event that was written/i);
    expect(clientId).toMatch(/the same client_id with different events is INVALID_ARGUMENT/i);
    const errors = prose(sync.slice(sync.indexOf('ERROR CONTRACT:'), sync.indexOf('service SyncService {')));
    expect(errors).toMatch(/a client_id already recorded with different events -> INVALID_ARGUMENT/i);
  });

  it('states the client_id grammar, that anything else is INVALID_ARGUMENT, and that it is checked before the transaction', () => {
    const clientId = prose(sync.slice(sync.indexOf('message PushRequest {'), sync.indexOf('string client_id = 1;')));
    expect(clientId).toMatch(/1 to 128 characters, each printable ASCII 0x21-0x7E \(no space, control or non-ASCII character\); anything else is INVALID_ARGUMENT, checked before the transaction opens/i);
    expect(errorEntry('a client_id that is not')).toMatch(/^a client_id that is not 1 to 128 characters, each printable ASCII 0x21-0x7E -> INVALID_ARGUMENT, checked before the transaction opens:/i);
  });

  it('rebases after any REJECTED edit past the fresh Status sample, not only version_future', () => {
    const any = /after any REJECTED edit, whatever the code, the client takes a fresh Status and, if the edit's version is past the fresh Status sample \(server_now_iso\), calls Hlc\.rebase\(\) before it mints again/i;
    expect(prose(sync)).toMatch(any);
    expect(sync).not.toMatch(/past the present,/);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(any);
    expect(rejected).toMatch(/a replay under the same client_id is REJECTED again with the same reason/i);
  });

  it('pins the server\'s check order: every REJECTED check before any STALE, REVIEW or APPLIED routing', () => {
    const order = /the server runs the REJECTED checks in the listed order \(version_malformed, version_future, facet_key_not_user_owned, device_mismatch, payload_invalid\), all before any STALE, REVIEW or APPLIED routing, so an event past server_now \+ 5 minutes is REJECTED version_future unless an earlier-listed check fails, whatever the field's policy and whatever the stored version/i;
    const rule5 = prose(sync.slice(sync.indexOf(' 5. THE VERSION GRAMMAR'), sync.indexOf(' 6. USER-OWNED FACET KEYS')));
    expect(rule5).toMatch(order);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(order);
  });

  it('bounds every version the server emits, since the Hlc folds tokens unclamped', () => {
    const emitted = /every version the server emits, in Delta or as `current`, is at most server_now \+ 5 minutes when emitted: a pushed one by the check order, and every server write, the import and server-owned facets included, at most server_now\. The Hlc folds tokens unclamped, so the bound depends on this\./i;
    const rule5 = prose(sync.slice(sync.indexOf(' 5. THE VERSION GRAMMAR'), sync.indexOf(' 6. USER-OWNED FACET KEYS')));
    expect(rule5).toMatch(emitted);
    const observeDoc = prose(hlcSource.slice(hlcSource.indexOf('Fold in a token seen from elsewhere'), hlcSource.indexOf('observe(version: string)')));
    expect(observeDoc).toMatch(emitted);
    expect(sync).not.toMatch(/bounds every token on the feed/);
    expect(hlcSource).not.toMatch(/bounds every token on the feed/);
    for (const text of [sync, hlcSource, importProto]) expect(text).not.toMatch(/min\(export_date, server_now\)/);
  });

  it('pins server_now to one clock that never steps back, and the bound to client monotonic time keeping server rate', () => {
    const rule5 = prose(sync.slice(sync.indexOf(' 5. THE VERSION GRAMMAR'), sync.indexOf(' 6. USER-OWNED FACET KEYS')));
    expect(rule5).toMatch(/server_now is one clock that never steps back: the one Status samples and the one version_future checks against\./i);
    expect(rule5).toMatch(/a tick never passes server-now plus the clamp \(assuming the client's monotonic time keeps server rate\)/i);
  });

  it('rests the collation rule on out-of-grammar tokens, which is where collations disagree', () => {
    const text = prose(sync);
    expect(text).not.toMatch(/ignores '#' at the first level/);
    expect(text).toMatch(/order the same under C, glibc and ICU/i);
    expect(text).toMatch(/rejects an out-of-grammar token before it is stored/i);
    expect(text).toMatch(/COLLATE "C"/);
  });

  it('states the future-skew bound as a number', () => {
    expect(prose(sync)).toMatch(/server_now \+ 5 minutes/);
  });

  it('lists every REJECTED reason code', () => {
    for (const code of ['version_malformed', 'version_future', 'facet_key_not_user_owned', 'device_mismatch', 'payload_invalid']) {
      expect(sync).toContain(code);
    }
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/facet_key_not_user_owned the key is not one of rule 6's user-owned forms \(a retired holding\/\* key included\)/);
    expect(sync).not.toMatch(/four forms|four user-owned/);
  });

  const rule6 = () => prose(sync.slice(sync.indexOf(' 6. USER-OWNED FACET KEYS'), sync.indexOf(' 7. DEFERRED, DELIBERATELY')));

  it('documents the 0.3.0 user-owned key table and nothing of the holding grain but its retirement', () => {
    const text = rule6();
    for (const key of [
      'occ/{occ}/head', 'occ/{occ}/status', 'occ/{occ}/collection', 'occ/{occ}/disposal', 'occ/{occ}/tag/{tag}',
      'uf/{head_id}/score', 'uf/{head_id}/note', 'uf/{head_id}/wishability', 'uf/{head_id}/tag/{tag}',
      'uf/{head_id}/ktag/{kind}/{tag}', 'coll/{kind}/{cid|default}/name', 'tag/{tag}/name',
    ]) {
      expect(text).toContain(key);
    }
    expect(text).toMatch(/RETIRED: holding\/\{head_id\}\/status and holding\/\{head_id\}\/count \(0\.2\.x\) are no longer user-owned; a Push of either is REJECTED facet_key_not_user_owned/);
    expect(text).toMatch(/`default` is legal only as a collection id/);
    expect(text).toMatch(/edited_at/);
    expect(text).not.toMatch(/holding grain;|one status register per \(user, product\)/i);
  });

  it('names the server-owned keys a client reads and never pushes', () => {
    const text = rule6();
    for (const key of ['occ/{occ}/origin', 'imp/{site}/base/{key}', 'imp/{site}/conflict/{key}']) expect(text).toContain(key);
    expect(text).toMatch(/SERVER-OWNED KEYS a client reads but never pushes/);
  });

  it('counts copies, keeps a removed copy\'s head, and never counts former as held', () => {
    const text = rule6();
    expect(text).toMatch(/one record per copy and no quantity field/i);
    expect(text).toMatch(/a move can never create or lose a copy/i);
    expect(text).toMatch(/An occurrence is live while its status facet is live and its head facet is present; one with a live status and no head \(a partial batch\) is hidden, flagged and never counted/);
    expect(text).toMatch(/never tombstoned by an ordinary removal/);
    expect(text).toMatch(/`former` is a live status \(no longer owned\) and is never counted as held/);
    expect(text).toMatch(/A disposal describes a former copy; it is kept, and hidden, while the status is anything else/);
  });

  it('states the display rule, the kind-change rule and collection deletion', () => {
    const text = rule6();
    expect(text).toMatch(/A copy is shown in its filed collection if that collection exists and its kind equals the copy's status; otherwise in \{status\}\/default/);
    expect(text).toMatch(/every live copy shows in exactly one collection/i);
    expect(text).toMatch(/A device write that changes a copy's kind also writes or tombstones its filing in the same batch, and an import write that sets a status of another kind than the filing writes it \{status\}\/default \(import\.proto FILING\)/);
    expect(text).not.toMatch(/the import never writes filing/);
    expect(text).toMatch(/Deleting a collection tombstones its name only: its copies show in the default, and undo restores them/);
  });

  it('states the three tag scopes, read-time figure-by-kind membership and effective tags', () => {
    const text = rule6();
    expect(text).toMatch(/Membership is one facet per \(target, tag\): upsert = member, tombstone = not/);
    expect(text).toMatch(/evaluated at read time, so a copy that arrives later picks it up and one that leaves drops it with no write/);
    expect(text).toMatch(/The effective tags of a copy are its own, its figure's, and its figure's tags for its status/);
  });

  it('states library presence, the reader rule, deterministic picks and privacy', () => {
    const text = rule6();
    expect(text).toMatch(/A figure is in the library while any live user facet references it: a live occurrence's head or any live uf\/\{head_id\} facet/);
    expect(text).toMatch(/A reader stores an unknown key form, kind, status or reason, hides it, never counts it and never pushes it, and re-parses its stored rows on every local-store upgrade/);
    expect(text).toMatch(/picks by occurrence id alone: the lowest to receive or keep, the highest to remove/);
    expect(text).toMatch(/Neither the coordinator nor a client logs a payload or a name facet/);
    expect(text).toMatch(/An import copy's occ id is a keyed MAC \(import\.proto OCCURRENCE IDS\), so a key and a user id do not reveal an MFC id/);
  });

  it('makes a client present, never silently resolve, an import write that crosses an open edit of its own', () => {
    const text = rule6();
    expect(text).toMatch(/IMPORT CROSSINGS\. An import write is an event whose version carries the reserved all-zero device \(rule 5\)\. The import's three-way rule \(import\.proto\) sees only edits the server holds, so a client catches the rest\./);
    expect(text).toMatch(/An edit of its own to K is OPEN from when the client mints it until its Delta delivers K at or above the edit's version, and a key's open edits CHANGE it unless the latest restates the value the client showed for the key before the oldest was minted\./);
    expect(text).toMatch(/An arriving event is NEW to an open edit when the client had not taken that version of the event's key, or a higher one, before the edit was minted\./);
    expect(text).toMatch(/An import write to K, or a conflict raised on K \(a write to imp\/mfc\/conflict\/\{K\}, MFC's side being imp\/mfc\/base\/\{K\}\), arriving in Delta or as `current` on a STALE result, is checked against the open edits it is new to\./);
    expect(text).toMatch(/Of those, the ones to K are dropped when none of them has been pushed and together they do not change K\./);
    expect(text).toMatch(/Then, when MFC's side differs from the value the client shows for K \(K's own fields, never edited_at or tz; a tombstone is no value\), it CROSSES: \* the open edits to K; \* ROW GRAIN,/);
    expect(text).not.toMatch(/with a value different from the latest one's/);
    expect(text).toMatch(/An event that crosses no edit follows the ordinary rules\. One that crosses is neither applied nor dropped: the client keeps showing its own value, holds the event as MFC's side of a pending import conflict on K, stored with the outbox so a reload keeps it, and pushes no edit to K, or to the key of an edit it crossed, until the conflict ends\./);
    expect(text).toMatch(/A later import write to K, or conflict on K, only replaces MFC's side; a write to K by any other device ends the conflict and follows the ordinary rules, and so do the held edits\./);
    expect(text).toMatch(/The user resolves it with an ordinary write to K, minted with Hlc\.tick\(base\) on the higher of the local and MFC's side's version, that replaces the unpushed edits to K: keep the app's value \(write it again\) or take MFC's \(its value, or a tombstone\)\. The client then pushes the held edits to other keys, unless another pending conflict holds them\./);
    expect(text).toMatch(/An edit already pushed cannot be recalled; if it lands the conflict stays until the user resolves it\./);
    expect(text).toMatch(/A client that calls ImportMfcExport first pushes its outbox, held edits aside, and has every push answered, so the import's three-way sees its own edits\. golden\/import-vectors\.json has the cases\./);
  });

  it('crosses at the row grain: an import that removes or adds a copy crosses a changed status of another copy of its row', () => {
    const text = rule6();
    expect(text).toMatch(/\* ROW GRAIN, when it writes occ\/\{x\}\/status and removes a copy the client shows live or adds one the client shows with none: the open edits that change the status of another copy of x's row \(a copy whose origin names x's MFC id\), and, for an addition, those that set a copy with no origin, of x's figure, to the kind it adds\./);
    expect(text).toMatch(/The import writes a copy's origin and head before its status, so the client knows both when the status arrives\./);
  });

  it('resolves a pending import conflict only by a write above the conflict facet, and moves `against` for an older one', () => {
    const text = rule6();
    expect(text).toMatch(/IMPORT CONFLICTS\. A pending imp\/\{site\}\/conflict\/\{key\} is resolved only by a write to \{key\} above the conflict facet's own version\./);
    expect(text).toMatch(/A write to \{key\} at or below that version that lands \(an edit minted before the conflict reached the server, pushed after it\) has not seen the conflict: in the same transaction the server re-upserts the conflict facet, above its current version, with `against` moved to that write's version, and the conflict stays pending \(import\.proto CONFLICTS\)\./);
  });

  it('carves the crossing out of THE CLIENT RULE, so adopting `current` whole never drops a crossed edit', () => {
    const clientRule = prose(sync.slice(sync.indexOf('// PushResult — one per pushed event.'), sync.indexOf('message PushResult {')));
    expect(clientRule).toMatch(/the one exception: `current` that is an import write crossing the client's open edits to facet_key \(rule 6, IMPORT CROSSINGS\) is held as MFC's side of a pending import conflict, and neither bullet applies/);
  });

  it('restates the ER-merge rules for occurrences: counts sum, no status tiebreak, tags union', () => {
    const text = rule6();
    expect(text).toMatch(/written against the ids of their time and never re-keyed/i);
    expect(text).toMatch(/A card groups occurrences whose head is any of its requested_as, and their counts sum; there is no status tiebreak/);
    expect(text).toMatch(/For each uf field the live facet with the higher version among requested_as is displayed, the lower head_id \(bytewise\) between equal versions \(one import's writes under heads merged later\), and new writes go to its head_id \(a card with none uses card\.head_id\); a delete tombstones that field on every requested_as head holding it live, each minted on its own facet's version/);
    expect(text).toMatch(/Tag sets union across requested_as, and an untag tombstones the membership on every head that holds it/);
    expect(text).not.toMatch(/the status with the higher version is displayed/i);
  });

  it('applies the merged-card rules to requested_as unioned across every GetProducts call', () => {
    expect(prose(sync)).toMatch(/groups cards by head_id across every call and page and unions their requested_as; the display, write-target and delete rules apply to that union/i);
  });

  it('closes every payload schema forever: a new attribute is a new key, never a property', () => {
    const text = prose(sync);
    expect(text).toMatch(/The schemas check writes only/);
    expect(text).toMatch(/A published payload schema never gains a property; a new attribute is a new facet key/);
    expect(text).not.toMatch(/a property added later cannot break an installed phone/i);
    expect(text).toMatch(/10,000 code points/);
  });

  it('carries the 0.3.0 SEMANTIC CHANGE note', () => {
    expect(rule6()).toMatch(/SEMANTIC CHANGE, SAFE ONLY BECAUSE NO DEVICE HAS INSTALLED AND NO IMPORT HAS RUN\. 0\.3\.0 replaces 0\.2\.x's per-figure holding grain \(one status per user and product\) with per-copy occurrences\. buf cannot see a key change: the wire is unchanged, and this comment, golden\/key-vectors\.json and the vocabulary tests are the guard/);
  });

  it('caps a pushed payload at MAX_PAYLOAD_BYTES of UTF-8 and names the reject', () => {
    const text = prose(sync);
    expect(text).toMatch(/a pushed payload over 65,536 bytes \(MAX_PAYLOAD_BYTES, counted as UTF-8\) is REJECTED payload_invalid: payload over 65536 bytes/i);
    expect(text).toMatch(/a schema-valid payload as JSON\.stringify writes it is at most 60,133 bytes/i);
    const payloadDoc = prose(sync.slice(sync.indexOf('message SyncEvent'), sync.indexOf('string payload = 4;')));
    expect(payloadDoc).toMatch(/at most MAX_PAYLOAD_BYTES \(65,536\) UTF-8 bytes on Push/i);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/payload_invalid .*is over MAX_PAYLOAD_BYTES/i);
  });

  it('answers an oversized request RESOURCE_EXHAUSTED, and a full queue or a lock timeout UNAVAILABLE', () => {
    const oversized = errorEntry('a request message over 16 MiB');
    expect(oversized).toMatch(/^a request message over 16 MiB \(16,777,216 bytes\) -> RESOURCE_EXHAUSTED\. /);
    expect(oversized).toMatch(/The limit applies to the PushRequest as the server reads it: its bytes in the encoding sent, binary or JSON, after decompression\. /);
    expect(oversized).toMatch(/Nothing is written and nothing is recorded under the client_id; the client splits the batch and pushes each part under a new client_id\. /);
    expect(oversized).toMatch(/A conforming client keeps each batch's binary-encoded size at or under 8 MiB \(8,388,608 bytes\); /);
    const queue = errorEntry("the user's push queue is full");
    expect(queue).toMatch(/^the user's push queue is full -> UNAVAILABLE: /);
    expect(queue).toMatch(/Nothing is written and nothing is recorded under the client_id; like a lock timeout, the client backs off and retries later with the same client_id and the same events\.$/);
    const lock = errorEntry('a lock timeout');
    expect(lock).toMatch(/^a lock timeout -> UNAVAILABLE\. The transaction rolled back, so nothing is written and nothing is recorded under the client_id; the client retries with the same client_id and the same events/);
    // One code, one recovery: RESOURCE_EXHAUSTED always means split, UNAVAILABLE always means retry as is.
    expect(errorEntries().filter((e) => e.includes('RESOURCE_EXHAUSTED'))).toEqual([oversized]);
    const unavailable = errorEntries().filter((e) => e.includes('UNAVAILABLE'));
    expect(unavailable).toEqual([queue, lock]);
    for (const e of unavailable) expect(e).not.toMatch(/new client_id/);
  });

  it('keeps the deferred Resync and Ack out of the wire and says so', () => {
    expect(prose(sync)).toMatch(/Resync|prune/);
    expect(sync).not.toMatch(/rpc (Resync|Ack)\(/);
  });

  it('makes any future prune keep the import writes a crossing depends on', () => {
    const rule7 = prose(sync.slice(sync.indexOf(' 7. DEFERRED, DELIBERATELY'), sync.indexOf('syntax = "proto3";')));
    expect(rule7).toMatch(/A prune, when one comes, keeps every import write and every imp\/\{site\}\/conflict write, even one a later write to its key superseded: a client catches an import write or conflict that crossed an edit of its own only by seeing it \(rule 6, IMPORT CROSSINGS\)\./);
  });
});

describe('hlc.ts', () => {
  it('points its 1-3 line header at sync.proto rule 5 for the bound; the clamp doc says the clamp is the server skew', () => {
    const headerLines = hlcSource.slice(0, hlcSource.indexOf('import {')).trimEnd().split('\n');
    expect(headerLines.length).toBeLessThanOrEqual(3);
    expect(prose(headerLines.join('\n'))).toMatch(/the bound and its assumptions: sync\.proto rule 5/i);
    const clampDoc = prose(hlcSource.slice(hlcSource.indexOf('clampMs?: number;') - 400, hlcSource.indexOf('clampMs?: number;')));
    expect(clampDoc).toMatch(/must equal MAX_FUTURE_SKEW_MS/i);
    expect(clampDoc).toMatch(/a larger one lets a fresh tick be REJECTED/i);
    expect(clampDoc).not.toMatch(/may not be below/i);
  });

  it('calls the floor a lower bound on server time only assuming monotonic time keeps server rate', () => {
    const text = prose(hlcSource);
    const lowerBounds = text.match(/lower bound[^.]*\./gi) ?? [];
    expect(lowerBounds.length).toBe(2);
    for (const sentence of lowerBounds) expect(sentence).toMatch(/assuming monotonic time keeps server rate/i);
  });
});

describe('catalog.proto', () => {
  it('states that ProductCard carries no inventory_level and why', () => {
    const text = prose(catalog);
    expect(text).toMatch(/carries no inventory_level/i);
    expect(text).toMatch(/entitlement/i);
  });

  it('states how GetProducts paging works', () => {
    const text = prose(catalog);
    expect(text).toMatch(/follow next_page_token until it is empty/i);
    expect(text).toMatch(/first page only/i);
    expect(text).toMatch(/at most 200 refs/i);
  });

  it('states how ER redirects are exposed', () => {
    const text = prose(catalog);
    expect(text).toMatch(/survivor/i);
    expect(text).toMatch(/requested_as/);
    expect(text).toMatch(/never re-keyed/i);
    expect(text).toMatch(/whose copies it counts/i);
    expect(text).toMatch(/what a delete clears/i);
    expect(text).not.toMatch(/which status is shown|holding facets/i);
    expect(text).toMatch(/groups cards by head_id across every call and page and unions their requested_as; the display, write-target and delete rules of sync\.proto rule 6 apply to that union/i);
  });

  it('states the unit, rounding and presence of the physical dimensions', () => {
    const card = prose(catalog.slice(catalog.indexOf('message ProductCard {'), catalog.indexOf('// GetProducts')));
    expect(card).toMatch(/in whole millimetres, rounded half up from the spine's value\. Unset means unknown, never 0/);
    expect(card).toMatch(/the figure with its base, never the box/);
    expect(card).toMatch(/MFC's L is depth/);
  });

  it('describes the mask as a separate, non-destructive overlay and the grounding fields by how they are measured', () => {
    const image = prose(catalog.slice(catalog.indexOf('// One derivative the client may show.'), catalog.indexOf('// SearchProducts')));
    expect(image).toMatch(/non-destructive, display-time overlay; the derivative is never cut out/);
    expect(image).toMatch(/Unset when there is none or when a display restriction withholds it from this caller/);
    expect(image).toMatch(/0 is a measurement/);
    expect(image).toMatch(/opaque means alpha above 10 of 255/);
    expect(image).toMatch(/the lowest 8 % of the image's height/);
    expect(image).toMatch(/ThumbHash/);
    expect(image).toMatch(/"#rrggbb", lowercase/);
    expect(image).toMatch(/Same pixel dimensions as its derivative/);
  });

  it('never lets a withheld mask reach a caller through the fields derived from it', () => {
    const image = prose(catalog.slice(catalog.indexOf('// One derivative the client may show.'), catalog.indexOf('// SearchProducts')));
    expect(image).toMatch(/The grounding fields, thumbhash and dominant_color describe the image as THIS caller is shown it: when a display restriction withholds the mask from the caller they are computed without it \(the grounding fields on the derivative's own alpha, else unset\), so a withheld mask never reaches the caller through a field derived from it\./);
    expect(image).toMatch(/A ThumbHash \(github\.com\/evanw\/thumbhash\) of the image as this caller is shown it, the mask applied only when the caller is sent one/);
    expect(image).toMatch(/The dominant color of the image as this caller is shown it, as "#rrggbb", lowercase\./);
    expect(image).not.toMatch(/the mask applied when there is one/);
  });

  it('marks SearchProducts UNIMPLEMENTED until served', () => {
    expect(prose(catalog)).toMatch(/UNIMPLEMENTED/);
  });
});

describe('import.proto', () => {
  const header = () => prose(importProto.slice(0, importProto.indexOf('syntax = "proto3";')));

  it('versions import writes under the reserved server device with a per-user counter, at the server clock', () => {
    const text = header();
    expect(text).toMatch(/reserved server device/i);
    expect(text).toMatch(/per-user import counter/i);
    expect(text).toMatch(/<instant> is the server's clock when the import starts \(at most server_now\)/);
    expect(text).not.toMatch(/whichever is earlier|Any device edit made after that instant outranks the import/);
    expect(text).toMatch(/A facet whose stored version is not below the import's \(a device edit minted within the clock skew of the import\) is left, base included, for the next import/);
    expect(text).toMatch(/THE THREE-WAY RULE below decides over the edits the server holds, the client calling ImportMfcExport pushes its outbox first, and a phone catches an import write or conflict that crosses an edit it has not pushed or seen come back, on the facet or on the copy's row \(sync\.proto rule 6, IMPORT CROSSINGS\)/);
  });

  it('derives import occ ids with a key the coordinator alone holds, never a published namespace', () => {
    const text = header();
    expect(text).toMatch(/occ_id = importOccIdFromMac\(HMAC-SHA256\(key, "\{user_id\}:mfc:\{mfc_id\}:\{k\}"\)\) the MAC's first 16 bytes as an RFC 9562 version 8 uuid, lowercase and dashed/);
    expect(text).toMatch(/The key is the import occ-id key, held by the coordinator alone: never sent to a client, logged or shipped in this package \(golden\/key-vectors\.json uses a published test key that is never the production one\)\. So an occurrence key and a user id do not reveal an MFC id, and a retry of an import mints the same ids\./);
    expect(text).toMatch(/finds its copies later through origin facets, never by recomputing ids: rotating or losing the key changes only the ids of copies created afterwards, and duplicates or re-keys nothing\. The key never changes during an import\./);
    for (const doc of [importProto, sync, readme, vocabSource]) expect(doc).not.toMatch(/uuidv5|MFC_IMPORT_OCC_NAMESPACE/);
  });

  it('canonicalises MFC ids, orders the unresolved reasons and says what Count 0 and a duplicate mean', () => {
    const text = header();
    expect(text).toMatch(/An ID is made canonical first \(canonicalMfcId\): leading zeros are stripped, and what remains must be 1 to 64 ASCII digits\. Every later step, occurrence ids and origin facets included, uses the canonical id\./);
    expect(text).toMatch(/A row is unresolved, with the first reason that applies, in this order: "invalid_id" \(no canonical id: "0", a sign, a space, a non-ASCII digit\), "duplicate_id" \(an earlier row has the same canonical id; the first row stands\), "invalid_count" \(Count is neither blank nor ASCII digits\), "count_over_99", "no_product"\./);
    expect(text).toMatch(/An unresolved row writes nothing\. One unresolved for invalid_count, count_over_99 or no_product also leaves its id's earlier copies and their figure values alone; a duplicate_id row leaves its id to the first row, and an invalid_id row names no id\./);
    expect(text).not.toMatch(/An unresolved row writes nothing, and the import leaves/);
    expect(text).toMatch(/Count blank means 1; Count 0 states no copies, and the row still states its figure values\./);
    const reason = prose(importProto.slice(importProto.indexOf('message UnresolvedMfcRow {'), importProto.indexOf('// ImportService')));
    expect(reason).toMatch(/Why nothing was written, the first that applies: "invalid_id", "duplicate_id", "invalid_count", "count_over_99" or "no_product" \(ROWS above\)/);
  });

  it('states the three-way rule Ross decided and the four cases', () => {
    const text = header();
    expect(text).toMatch(/THE THREE-WAY RULE \(Ross, 2026-09-27: a field changed both in the app and on MFC is presented to the user and not written until resolved\)/);
    expect(text).toMatch(/M == B: MFC did not change it\. Nothing is written\./);
    expect(text).toMatch(/M != B and A == B: only MFC changed it\. K and the base are set to M\./);
    expect(text).toMatch(/M != B and A == M: both changed it alike\. Only the base moves to M\./);
    expect(text).toMatch(/M != B, A != B and A != M: both changed it differently, a CONFLICT\. K is not written\./);
    expect(text).toMatch(/imp\/mfc\/conflict\/\{K\} is upserted \{against: K's version, export_date\}/);
  });

  it('compares heads through the redirect chain, so a spine merge alone writes nothing and re-keys nothing', () => {
    const text = header();
    expect(text).toMatch(/ER MERGES\. Heads are compared through the spine's redirect chain: two heads are equal when they resolve to one survivor, so a spine merge alone changes no M, B or A, writes nothing and re-keys nothing\./);
    expect(text).toMatch(/Between equal versions, which one import's writes under heads merged later can have, the lower head_id wins \(bytewise, as rule 6 displays\)\./);
    expect(text).toMatch(/M is B when any row resolving to the survivor states B's value, else the value of the numerically lowest MFC id among them; a survivor no row resolves to states no score, note or wishability\./);
    expect(text).toMatch(/So MFC changes a merged figure only when none of its rows still states the base, and an unchanged export writes nothing whatever versions the merged heads' bases carry\./);
    expect(text).not.toMatch(/its figure values come from the numerically lowest MFC id among them/);
    expect(text).toMatch(/For a figure field, B is the base with the higher version among the heads resolving to the survivor, A is the value rule 6 displays, and K is rule 6's write target among those heads \(the head of the live facet with the higher version, else the survivor\): the head its base was written under unless the app deleted the field since\./);
    expect(text).toMatch(/tombstones a field, as a device delete does, on every one of those heads holding it live/);
    expect(text).not.toMatch(/the uf values come from the lowest MFC id among them/);
  });

  it('runs the three-way on a row\'s Count, never writing the status of a copy the app changed', () => {
    const text = header();
    expect(text).toMatch(/A copy is UNCHANGED when its status and head, as the server holds them when the import starts, equal their bases then \(absent equals absent\)\./);
    expect(text).toMatch(/A row absent from this export, or with Count 0, has M_count 0 and B_kind as its kind; otherwise M_count is its Count\./);
    expect(text).toMatch(/HEAD\. For a row in this export, each of its copies with a base head runs the three-way on its head, M being the row's figure\./);
    expect(text).toMatch(/KIND\. When M_count > 0 and the row's kind differs from B_kind, each copy with a live base status runs the three-way on its status, M being the row's kind\./);
    expect(text).toMatch(/\* M_count == B_count: nothing more\. \* A_count == M_count: only bases move\./);
    expect(text).toMatch(/\* A_count == B_count: only MFC changed the count, and the import adds or removes the difference by rule 6's PICKS, never writing the status of a copy the app changed\./);
    expect(text).not.toMatch(/never picking a copy the app changed/);
    expect(text).toMatch(/then adopts the live copies of the row's figure and kind that carry no origin \(added in the app\), lowest occ id first, writing only their origin, each at the lowest unused ordinal; then creates copies at the lowest unused ordinals, writing each one's origin, head and status in that order\./);
    expect(text).toMatch(/\* Otherwise the count is a CONFLICT, held per copy so that each is resolved by an ordinary write to that copy's status\./);
    expect(text).toMatch(/Whenever M_count != B_count, the row's bases then describe MFC/);
    expect(text).toMatch(/A raised copy's status is not written, and imp\/mfc\/conflict\/occ\/\{occ\}\/status is upserted; under CONFLICTS below, a copy's M is the base status the row's bases give it\./);
    expect(text).not.toMatch(/An ordinal absent from this export/);
  });

  it('resets a filing beside a kind change, and keeps disposals to the configured disposition list', () => {
    const text = header();
    expect(text).toMatch(/FILING\. Whenever the import upserts a copy's status to a kind its filing is not of, it writes occ\/\{occ\}\/collection \{"collection": "\{status\}\/default"\} in the same batch, as a device kind change does\. That is the only filing it writes, and it never compares one\./);
    expect(text).toMatch(/DISPOSITIONS\. Ross tracks dispositions on MFC as a list plus a note in a user field \(GR-Q3\)\. The import MAY write status former and occ\/\{occ\}\/disposal for rows of the user's configured disposition list; its list and field names are desk item DL, and no request field carries them yet, so a 0\.3\.0 import writes neither\. No other row, and nothing else on the server, writes a former status or a disposal\./);
    expect(text).not.toMatch(/The import never writes a filing|maps no column to `former`/);
    const doc = prose(vocabSource.slice(vocabSource.indexOf('export const DISPOSAL_REASONS'), vocabSource.indexOf('export const IMPORT_WRITTEN_FAMILIES')));
    expect(doc).toMatch(/only status former plus a disposal, for rows of the user's configured disposition list \(import\.proto DISPOSITIONS\)/);
    expect(doc).toMatch(/Besides these the import writes a filing only as \{status\}\/default beside a status of another kind, never compared\./);
  });

  it('makes a resolution an ordinary write and a re-import idempotent', () => {
    const text = header();
    expect(text).toMatch(/The user resolves it with an ordinary write to K through Push, minted with Hlc\.tick\(base\) on the higher of K's local version and the conflict facet's:/);
    expect(text).toMatch(/Only a write to K above the conflict facet's own version resolves it\. A write to K at or below that version that lands \(an edit minted before the conflict reached the server, pushed after it\) has not seen the conflict: in the same transaction the server re-upserts the conflict facet, above its current version, with `against` moved to that write's version, and the conflict stays pending\./);
    expect(text).toMatch(/A client shows a pending conflict wherever K is edited, and one raised on K crosses the client's open edits to K \(sync\.proto rule 6, IMPORT CROSSINGS\)\./);
    expect(text).not.toMatch(/Any write to K after the conflict was raised resolves it/);
    const schema = JSON.parse(read('schemas/imp-conflict.schema.json')) as { description: string; properties: { against: { description: string } } };
    expect(schema.description).toMatch(/Only a write to \{key\} above this facet's own version resolves it; an older one that lands moves `against` to its version \(import\.proto CONFLICTS\)\./);
    expect(schema.properties.against.description).toMatch(/^\{key\}'s version when the conflict was raised, or the version of a later write to \{key\} at or below this facet's own version that landed/);
    expect(text).toMatch(/`against` is absent when K had no version, and the conflict is then pending while K has none/);
    expect(text).toMatch(/A conflict is PENDING while its facet is live and K's version is still `against`/);
    expect(text).toMatch(/The user resolves it with an ordinary write to K through Push/);
    expect(text).toMatch(/each import tombstones every conflict facet that is no longer pending/);
    expect(text).toMatch(/A re-import of the same export writes nothing beyond those tombstones/);
  });

  it('keeps the row counters partitioning resolved rows', () => {
    expect(prose(importProto)).toMatch(/added \+ moved \+ unchanged \+ kept_newer == resolved/);
  });

  it('names the reason a row is unresolved', () => {
    const row = prose(importProto.slice(importProto.indexOf('message UnresolvedMfcRow {'), importProto.indexOf('// ImportService')));
    for (const reason of ['no_product', 'count_over_99', 'invalid_count', 'invalid_id', 'duplicate_id']) expect(row).toContain(`"${reason}"`);
  });

  it('never versions an import in the future and still refuses a future export_date', () => {
    expect(prose(importProto)).toMatch(/export_date later than the server's current UTC date plus one day -> INVALID_ARGUMENT/);
  });
});

describe('README', () => {
  it('does not rest the collation rule on # being ignored', () => {
    expect(readme).not.toMatch(/which ignores `#`/);
    expect(readme).toMatch(/out-of-grammar token/);
  });

  it('names the key helpers and the key vectors, and records the 0.3.0 semantic change', () => {
    expect(readme).toMatch(/golden\/key-vectors\.json/);
    expect(readme).toMatch(/golden\/import-vectors\.json/);
    expect(readme).toMatch(/canonicalMfcId/);
    expect(readme).toMatch(/importOccIdFromMac/);
    expect(readme).toMatch(/parseUserFacetKey/);
    expect(readme).toMatch(/buildFacetKey/);
    expect(readme).not.toMatch(/userFacetKey`|holding states/);
    expect(readme).toMatch(/0\.3\.0 made one/);
  });
});

describe('README: the schema guard', () => {
  it('says the payload schemas are guarded mechanically, like the protos', () => {
    expect(readme).toMatch(/scripts\/schema-growth\.ts/);
    expect(readme).toMatch(/npm run schema-growth/);
  });

  it('says only annotations may change and an enum may only grow', () => {
    const text = readme.replace(/\s+/g, ' ');
    expect(text).toMatch(/every keyword must be unchanged at every depth except the annotations \(`title`, `description`, `\$comment`, `examples`\), which no validator reads, and `enum`, which may only grow/);
    expect(text).toMatch(/no property, pattern property or subschema is added or removed, a closed object stays closed, and no type, bound, pattern or format changes/);
    expect(text).not.toMatch(/the properties and `required` sets must be unchanged at every depth/);
  });

  it('says a crossing is caught on the facet or on the copy\'s row', () => {
    expect(readme.replace(/\s+/g, ' ')).toMatch(/An import write or conflict that crosses an edit still on a phone, on the facet or on the copy's row, is presented to the user there, never silently adopted \(rule 6, IMPORT CROSSINGS\)/);
  });
});

describe('package', () => {
  it('is 0.3.0', () => {
    expect(pkg.version).toBe('0.3.0');
  });

  it('runs the schema growth guard in verify, right after the proto breaking check', () => {
    expect(pkg.scripts['schema-growth']).toBe('node scripts/schema-growth.ts');
    expect(pkg.scripts.verify).toContain('npm run breaking && npm run schema-growth && ');
  });

  it('ships and exports the new protos, the golden vectors and the payload schemas', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['proto', 'dist', 'golden', 'schemas']));
    for (const key of [
      './proto/coordinator/v1/catalog.proto',
      './proto/coordinator/v1/import.proto',
      './golden/version-vectors.json',
      './golden/key-vectors.json',
      './golden/import-vectors.json',
      './schemas/*',
    ]) {
      expect(pkg.exports, key).toHaveProperty([key]);
    }
  });
});
