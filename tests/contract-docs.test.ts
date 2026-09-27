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
  it('says, where the merge rule is stated, that there is no exception: the import is decided on the server', () => {
    const header = prose(sync.slice(0, sync.indexOf('SEVEN RULES THIS SHAPE ENCODES')));
    expect(header).toMatch(/There is no exception: the MFC import is decided on the server, which places a late edit where it belongs by the basis it was made on \(rule 6, THE IMPORT, ON A CLIENT\), so a client only ever merges by LWW\./);
    for (const doc of [sync, importProto, readme]) expect(doc).not.toMatch(/IMPORT CROSSINGS|IMPORT CONFLICTS|ROW GRAIN|crosses an open edit/);
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
      expect(text).toMatch(/an event first APPLIED is answered DUPLICATE, one first REJECTED is REJECTED again with the same reason, one first STALE is STALE again, one first REVIEW is REVIEW again and one first HELD is HELD again/i);
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
    const order = /the server runs the REJECTED checks in the listed order \(version_malformed, version_future, facet_key_not_user_owned, device_mismatch, payload_invalid, basis_missing\), all before any STALE, REVIEW, HELD or APPLIED routing, so an event past server_now \+ 5 minutes is REJECTED version_future unless an earlier-listed check fails, whatever the field's policy and whatever the stored version/i;
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
    for (const code of ['version_malformed', 'version_future', 'facet_key_not_user_owned', 'device_mismatch', 'payload_invalid', 'basis_missing']) {
      expect(sync).toContain(code);
    }
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/facet_key_not_user_owned the key is not one of rule 6's user-owned forms \(a retired holding\/\* key included\)/);
    expect(sync).not.toMatch(/four forms|four user-owned/);
  });

  const rule6 = () => prose(sync.slice(sync.indexOf(' 6. USER-OWNED FACET KEYS'), sync.indexOf(' 7. TRANSACTIONS, AND WHAT IS DEFERRED')));

  it('documents the 0.3.0 user-owned key table and nothing of the holding grain but its retirement', () => {
    const text = rule6();
    for (const key of [
      'occ/{occ}/head', 'occ/{occ}/status', 'occ/{occ}/collection', 'occ/{occ}/disposal', 'occ/{occ}/tag/{tag}',
      'uf/{head_id}/score', 'uf/{head_id}/note', 'uf/{head_id}/wishability', 'uf/{head_id}/tag/{tag}',
      'uf/{head_id}/ktag/{kind}/{tag}', 'coll/{kind}/{cid|default}/name', 'tag/{tag}/name',
      'res/{site}/{head_id}', 'pref/{site}/import',
    ]) {
      expect(text).toContain(key);
    }
    expect(text).toMatch(/RETIRED: holding\/\{head_id\}\/status and holding\/\{head_id\}\/count \(0\.2\.x\) are no longer user-owned; a Push of either is REJECTED facet_key_not_user_owned/);
    expect(text).toMatch(/`default` is legal only as a collection id/);
    expect(text).toMatch(/edited_at/);
    expect(text).not.toMatch(/holding grain;|one status register per \(user, product\)/i);
  });

  it('names the server-owned keys a client reads and never pushes, the draft\'s import bases and conflicts gone', () => {
    const text = rule6();
    for (const key of ['occ/{occ}/origin', 'imp/{site}/figure/{head_id}', 'imp/{site}/held/{head_id}', 'imp/{site}/change/{head_id}', 'imp/{site}/align/{head_id}', 'imp/{site}/import'])
      expect(text).toContain(key);
    expect(text).toMatch(/SERVER-OWNED KEYS a client reads but never pushes/);
    expect(text).toContain("res/{site}/{head_id} answers one of the import's items on the figure {head_id}, naming the item and its rev; pref/{site}/import holds the import's preferences (import.proto THE SERVER DECIDES).");
    expect(text).toContain('res/{site}/{head_id} {"item": "figure"|"held"|"change"| "align", "rev", "choice": "keep"| "take"|"per_copy"|"undo"|"dismiss", "copies"?, "fields"?}');
    for (const doc of [sync, importProto, readme]) expect(doc).not.toMatch(/imp\/\{site\}\/(base|conflict)|imp\/mfc\/(base|conflict)/);
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

  it('lets a client decide nothing about an import: a basis on every edit, the overlay, push before pull, HELD, items and answers', () => {
    const text = rule6();
    expect(text).toMatch(/THE IMPORT, ON A CLIENT \(import\.proto THE SERVER DECIDES\)\. A client decides nothing about an import and never compares anything with MFC: it merges every event by LWW, as above\./);
    expect(text).toMatch(/\* Every edit is minted with its basis \(SyncEvent\.basis\): the commit_cursor of the last transaction the client had applied \(rule 7\), or "" when it has applied none\. The basis never changes afterwards, whatever is pulled, replayed or re-minted\./);
    expect(text).toMatch(/\* What the user sees is the replica with the unanswered outbox laid over it in minting order\. A newer remote event on the same key does not drop an outbox entry: the entry is still pushed, and the server decides\./);
    expect(text).toMatch(/\* The client pushes before it pulls, every outbox entry, oldest first, and adopts `current` on every outcome \(THE CLIENT RULE\), HELD included; a held edit is shown in its figure's held-edit card\./);
    expect(text).toContain("* After its own ImportMfcExport returns, it pulls until it has applied the import's transaction (its replica's marker imp/{site}/import holds an import at or above the response's import_number) before it presents the review set or mints any edit or answer, so what the user does about the review set is knowing (import.proto THE REVIEW SET).");
    expect(text).toMatch(/\* It shows every live figure item, held-edit card, change entry and align-MFC entry \(import\.proto THE REVIEW SET\), never blocks an edit while one is pending, and answers one by writing res\/\{site\}\/\{head_id\} through the outbox, offline or not\. An answer answered STALE means the item changed or another device answered first: the client shows what is there now\./);
    expect(text).toMatch(/\* A replay from an empty cursor re-applies the feed by LWW onto an empty replica, the outbox and its bases untouched, and presents nothing again: the items are server state\./);
  });

  it('keeps THE CLIENT RULE free of exceptions, and answers an edit a replay overrides STALE and a held one HELD', () => {
    const clientRule = prose(sync.slice(sync.indexOf('// PushResult — one per pushed event.'), sync.indexOf('message PushResult {')));
    expect(clientRule).not.toMatch(/exception/);
    const stale = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_DUPLICATE = 2;'), sync.indexOf('PUSH_OUTCOME_STALE = 3;')));
    expect(stale).toMatch(/An edit is STALE too when it landed but the replay of an import placed after it leaves the facet another value \(import\.proto LATE EDITS AND REPLAY\)\./);
    const held = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REJECTED = 5;'), sync.indexOf('PUSH_OUTCOME_HELD = 6;')));
    expect(held).toMatch(/Kept on the server but not applied: an edit the server holds for the user \(import\.proto HELD\): a late edit that would change an import's result another device acted on, or a decision made on its figure without it; or an edit that acted on a result a replay has since revised\. `current` is the facet as the server holds it, adopted like any outcome; the figure's held-edit card imp\/\{site\}\/held\/\{head_id\} shows the held edits for the user to keep or drop\./);
    const current = prose(sync.slice(sync.indexOf('message PushResult {'), sync.indexOf('SyncEvent current = 4;')));
    expect(current).toMatch(/Always set on APPLIED, DUPLICATE, STALE, REVIEW and HELD\./);
  });

  it('carries the basis on Push and the commit cursor on Delta', () => {
    const fields = prose(sync.slice(sync.indexOf('string payload = 4;'), sync.indexOf('string commit_cursor = 6;')));
    expect(fields).toMatch(/Push only, and required there: the commit_cursor of the last server transaction the client had applied when it minted this edit \(rule 7\), or "" when it had applied none\. It is set when the edit is minted and never changed afterwards; the server places a late edit by it \(import\.proto THE SERVER DECIDES\)\. A pushed event with no basis is REJECTED basis_missing\. Unset on Delta\./);
    expect(fields).toMatch(/Delta only: the cursor just after this event when it is the last event of a server transaction \(rule 7\); empty on every other event and on Push\./);
    const commit = prose(sync.slice(sync.indexOf('optional string basis = 5;'), sync.indexOf('string commit_cursor = 6;')));
    expect(commit).toContain('A client applies a transaction\'s events only once it has the one carrying commit_cursor, and resumes from the commit_cursor of the last transaction it applied: it is a legal DeltaRequest.cursor.');
    const cursor = prose(sync.slice(sync.indexOf('message DeltaRequest {'), sync.indexOf('string cursor = 1;')));
    expect(cursor).toContain('Opaque resume token: a previous DeltaResponse\'s next_cursor, or a SyncEvent\'s commit_cursor (rule 7).');
    expect(sync).toMatch(/optional string basis = 5;/);
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

  it('writes each server transaction consecutively and lets a client apply only whole transactions (F2)', () => {
    const rule7 = prose(sync.slice(sync.indexOf(' 7. TRANSACTIONS, AND WHAT IS DEFERRED'), sync.indexOf('syntax = "proto3";')));
    expect(rule7).toMatch(/Every server transaction \(one push, one import, the writes of one replay, one answer\) writes its events consecutively in the feed, and its last event carries commit_cursor, the cursor just after it\. A Delta page may end inside a transaction\./);
    expect(rule7).toMatch(/A client applies a transaction only once it has all of its events, and keeps the rest of the page staged until then, so what it shows, and the basis it mints an edit on, are always at a transaction boundary: it never shows half of an import and has the user react to it\./);
    expect(rule7).toMatch(/A prune, when one comes, keeps nothing for the import's sake: the server keeps its frames itself \(import\.proto HELD\)\./);
    expect(rule7).toContain('A commit_cursor is a legal DeltaRequest.cursor: a client resumes, after a restart included, from the commit_cursor of the last transaction it applied, and fetches what it had staged again; it parks a next_cursor past staged events only if it persists those events with it.');
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
    expect(text).toMatch(/Which side's change stands is not decided by version: THE SERVER DECIDES below decides, and each write of a decision or an answer is minted above the facet's current version\./);
  });

  it('is asked for online, after the client pushed and had every push answered, and runs as one transaction (R1)', () => {
    expect(header()).toMatch(/ONLINE ONLY \(R1; Ross, 2026-09-27\)\. A client calls ImportMfcExport only while online, after it has pushed its whole outbox and has every push answered, so the import sees every edit of the device that asks for it\. The coordinator resolves each MFC id to a spine product, decides what the export means for each figure \(THE SERVER DECIDES below\) under the per-user lock and as one server transaction \(sync\.proto rule 7\)/);
    expect(header()).toMatch(/Other devices may still be offline with edits the import has not seen; LATE EDITS AND REPLAY below gives them the result they would have had by pushing first\./);
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

  it('decides on the server, at figure grain, with a frame for every figure an import decides (F1)', () => {
    const text = header();
    expect(text).toMatch(/THE SERVER DECIDES \(Ross, 2026-09-27: design A, with the review's fixes F1 to F3\)\. A client never compares anything with MFC: it sends every edit with the basis it was made on, shows the server's state, and shows and answers the items the server raises/);
    expect(text).toMatch(/FRAME \(F1\): every import writes one marker event last, imp\/\{site\}\/import\. For every figure the import decides, whether it writes to it or only moves its bases, last_seq\(I, S\) is the marker's position\./);
    expect(text).toMatch(/LATE EDIT: a pushed edit to a copy or field of S whose basis is before last_seq\(I, S\) for an import I that arrived before it: the device made it without having seen what I decided for S\. Any other edit is KNOWING\./);
    expect(text).toMatch(/ROW BASE \(server-internal, per MFC id\)/);
    for (const removed of [/THE THREE-WAY RULE/, /ADOPTION IN PLACE/, /`against`/, /COUNT other-row/, /raises the whole difference for removal/]) expect(importProto).not.toMatch(removed);
  });

  it('decides each figure once: counts by transitions and matching, fields per row, and one decision for the whole figure', () => {
    const text = header();
    expect(text).toMatch(/\* M == B for every kind: MFC changed no count\. Nothing is written and no base moves, so an app change stays an app change\./);
    expect(text).toMatch(/\* A == M for every kind: both sides reached the same counts\. Nothing is written, and every copy of S takes its current state as its base\./);
    expect(text).toMatch(/d_k = M_k - B_k gives, in this order, ordered->owned \(arrivals\), wished->ordered and wished->owned, as many as both sides allow, then k->OUT for each remaining negative d_k and OUT->k for each remaining positive d_k\./);
    expect(text).toMatch(/MATCHING pairs each MFC transition with an app transition of the same \(from, to\), the app's copies taken in occ-id order: a pair is the same change on both sides\./);
    expect(text).toMatch(/- No app transition is left, or none shares a kind with an MFC one left: only MFC made the rest, and the import MATERIALIZES it\. - Otherwise the counts are a CONFLICT\./);
    expect(text).toMatch(/So MFC's change to one of several merged rows is found against that row's own base, never mistaken for another row's value\./);
    expect(text).toMatch(/ONE DECISION PER FIGURE\. If any part is a CONFLICT, nothing of S is written and none of its bases move\./);
  });

  it('materializes on unchanged copies, a new copy going to the lowest row whose Count exceeds its live copies (4.5)', () => {
    const text = header();
    expect(text).toMatch(/else a copy is created for the lowest-numbered row of S whose Count exceeds its live copies of kind y, counting the copies created in this decision, at that row's lowest unused ordinal: its origin, head and status, in that order\./);
    expect(text).toMatch(/The import never restores a former copy, never writes former or a disposal, and never touches a copy with no base unless the decision counted or paired it\./);
    expect(text).toMatch(/ROW MOVED\. A row whose base head and new head resolve to different survivors, with no merge between them, was moved by the spine: MFC did not change it\./);
  });

  it('projects the app onto what MFC can hold, and never raises anything for app-only richness (R2)', () => {
    const text = header();
    expect(text).toContain("MFC's side of a figure S is its MFC ROWS: the export's rows of S, and each row base of S the export lacks, at Count 0, each with the field values it states.");
    expect(text).toContain("The app's side, as MFC could state it, is what THE ALIGN PLAN (ALIGN-MFC) makes of those rows for the app's live copies per kind and its displayed score, note and wishability. The two sides are compared part by part, the rows' kinds and Counts and each field, and a part differs exactly when the plan would change it on some row.");
    expect(text).toContain('What no row can take is APP-ONLY RICHNESS MFC cannot express: a wished or ordered copy beside owned ones when no row is free for its kind (a one-row figure, or merged rows all in use), former copies and their dispositions, filings and tags. Richness never raises an item or an align-MFC entry by itself.');
    expect(text).not.toMatch(/only for as many kinds as S has MFC ids known/);
  });

  it('turns each decision into a conflict, an applied and listed MFC change, or a divergence, by the user\'s preferences (R3, R4, R5)', () => {
    const text = header();
    expect(text).toMatch(/\* A CONFLICT is a figure item imp\/\{site\}\/figure\/\{S\} of kind "conflict" when import_policy is ASK, the default\. With FAVOR_APP or FAVOR_MFC the import answers it keep or take itself \(ITEMS AND ANSWERS\), writes a change entry imp\/\{site\}\/change\/\{S\} of kind "favor_app" or "favor_mfc", and the user can undo it like an answer \(R5\)\. A preference applies to conflicts only, never to a change only one side made\./);
    expect(text).toContain('* A decision that writes, because only MFC changed, on a figure the import had a row base for is written to the copies the app left untouched, and listed with its undo as a change entry of kind "applied" (R3; Ross, CT4 (a)). A figure new to the import (no row base) is added, counted in `added` and never listed.');
    // Ross, CT4 (a): no HOLD mode, no mfc_only preference and no held MFC change (0.3.0 is unpublished; its field and enum value are reserved)
    for (const doc of [importProto, sync]) expect(doc).not.toMatch(/mfc_only|APPLY_AND_LIST|"mfc_change"|held for confirmation|kind mfc_change/);
    expect(text).toContain('* Every other decision settles. Then, when a part of the projection differs and is not acknowledged at its present values (ACKNOWLEDGED), the difference is the app\'s: MFC has not caught up with it. It writes nothing and is one figure item of kind "divergence" (R4), which an import of the same export neither raises again nor duplicates.');
    expect(text).toContain("A SPINE MERGE re-derives the merged figure: when a redirect makes a head no longer a survivor, the figure item, change entry, align-MFC entry and acknowledgement of that head and of its survivor end (an answer to one is then STALE), and the next import decides the merged figure as one, its rows together. Held edits follow their copies to the survivor's card.");
  });

  it('replays a late edit where it belongs, and answers it APPLIED or STALE by what stands after the replay', () => {
    const text = header();
    expect(text).toMatch(/CANONICAL ORDER: imports, answers and spine redirects in arrival order; each late edit just before the earliest import it is late for; every other edit at its arrival\./);
    expect(text).toMatch(/The PushResult \(sync\.proto\) of such an edit is APPLIED when its value stands after the replay and STALE, with `current`, when the replay leaves another value \(an import placed after it changed the facet, or another device's edit won\)\./);
  });

  it('holds a late edit on reaction or after an answer, an edit made on a revised result, and one past retention (F3, 5.4)', () => {
    const text = header();
    expect(text).toContain("HELD. The server decides HELD once, when a push arrives, for each UNIT of the push in push order: the push's edits to one copy's head, status, collection and disposal are one unit, held or replayed together; every other edit (a tag, a figure value) is a unit by itself. A unit is late when an edit of it is late.");
    expect(text).toContain("The RELEVANCE TEST of a late unit: the server replays S both ways, the unit's late edits before their import I and at their arrival, every earlier input as decided and the push's later units as if not held, and compares S's LIVE COPIES (each copy's figure and kind, or out: a former or removed copy is out whatever facets it keeps; the unit's own copies count too) and S's ITEMS (its figure item, change entry and align-MFC entry, each by its rev: an item changes when it appears, ends or takes a new rev, not when it only shows the app's side anew); the unit passes when they differ.");
    expect(text).toContain("A REACTION to a result is an edit, made after that result without having seen what withdraws it, that writes a copy whose live state the two sides leave different, that adds a copy to S (writes the head or status of a copy that had no head when the import ran), or that writes the status or head of a copy of S while S had an item, as its device saw it, that the two sides leave different.");
    expect(text).toContain("(i) it is late, it passes the relevance test, and a reaction to I's result arrived before it or in the same push: an edit made after I without having seen the unit's replay (knowing for I, whether or not it is late for a later import), the two sides being the two placements. HOLD ON REACTION: another device acted on the result the late edit would withdraw;");
    expect(text).toContain("(ii) a knowing edit of it was made before a REVISION of S that its device had not seen, and is a reaction to the result the revision changed, the two sides being S before and after the revision. A revision is a push that replays a late edit and so changes S's live copies or items; an answer's writes are no revision. An edit that is no reaction (a tag on a copy the revision left alone, a figure value) is applied;");
    expect(text).toContain("(iii) it is late, its basis is before the commit of an answer on S that the server accepted (to any of S's items; a device that had applied the answer's transaction made its edit after the answer), and it passes the relevance test: the user decided without it; or (iv) it is late for a frame the server no longer keeps. Frames are kept at least 180 days and while any enrolled device's cursor is before them.");
    expect(text).toContain("The decision is final: a held unit stays held, whatever arrives later, until its card is answered, and a unit replayed is never held later. An answer holds no knowing edit: (iii) is for late units, and an answer's writes are no revision.");
    expect(text).toContain("The card lists the held units of S whole, oldest first, as many as fit in 16 edits, and `more` counts the held edits it does not list. Its keep writes the listed edits now, as an answer's writes (above each facet's current version, so over any edit made before the keep), each then a knowing edit; its take drops them; the card then lists the next.");
    expect(text).not.toMatch(/has its basis before a replay's revision of S \(a withdrawal the device had not seen\)|Its keep applies the listed edits now, as knowing edits/);
    expect(text).not.toMatch(/\(iii\) it is late and its basis is before an answer on S: the user decided without it/);
  });

  it('answers items by rev: keep, take, per_copy, undo and dismiss, then realigns the bases', () => {
    const text = header();
    expect(text).toContain('The user answers an item by writing res/{site}/{S} through Push, naming the item (figure, held, change or align), its rev and a choice. An answer is accepted only while that item of S is pending with that rev; otherwise it is STALE, with `current`');
    expect(text).not.toMatch(/An mfc_change\. take/);
    expect(text).toMatch(/A copy with no base is never changed, and a disputed field takes MFC's value\. per_copy: the final statuses listed and "app" or "mfc" per disputed field, exactly\./);
    expect(text).toMatch(/After any answer the bases REALIGN to MFC's side: the row bases become the export's rows, the field bases MFC's values, and per kind the live copies with the lowest occ ids, up to MFC's Count, get that base; other copies get base OUT, and MFC's Counts beyond the app's copies become placeholders\./);
    expect(text).toMatch(/\* A change entry\. undo: an applied or favor_mfc change is reverted, each write restored while it still holds the value the import wrote \(else STALE\), and a favor_app settlement is taken now\. dismiss: it goes\. \* An align-MFC entry: dismiss\./);
    expect(text).toContain("REVS. An answer names an item's rev, which is: * A conflict: the raising import with MFC's side and the disputed parts it found. An import that finds MFC's side unchanged keeps it, whatever the app did meanwhile. * A divergence: the raising import with both sides' values of the parts that differ. An import that finds the same values keeps it; other values, on either side, give a new rev. * A change entry: the import that made it, its kind and its writes. * A held-edit card: the edits it lists. * An align-MFC entry: its actions, so a dismissed entry returns only when they change.");
    expect(text).toContain("So a figure item or change entry raised again after it ended has a new rev, even when it is identical, and an answer to the old one is STALE. A knowing edit never changes a figure item's rev, and a late edit changes it only when its replay changes what the raising import found.");
    expect(text).toContain('An item ends by an answer naming it and its rev, when a later import finds MFC back at the base or the two sides agreeing, when a knowing edit makes the sides of a conflict agree, or at a spine merge (WHAT AN IMPORT DOES).');
    expect(text).toContain("The sides of a conflict agree when, decided again against the export that raised it, every part of the figure is one MFC did not change or one the app now holds at MFC's value (for the counts, as many live copies of each kind as MFC's Counts). The item then ends and nothing else happens: nothing is written, no base moves, and the next import decides the figure. A knowing edit that leaves the sides differing leaves the conflict standing, and a late edit leaves it to the import it is replayed before.");
    expect(text).toContain("A replay re-derives items like the rest of S: a late edit replayed before the import that raised an item can withdraw the item or change its rev, and every device sees that as ordinary events (the item's tombstone, or its new rev). An answer to an item a replay withdrew or re-revved is void: its writes go with it, its recorded PushResult stands, and the client shows the item and the facets as they now are. A replay voids an accepted answer only when S's live copies and items end the same either way; otherwise HELD (iii) holds the late edit.");
    expect(text).not.toMatch(/never by a replay, another device's write or an older edit/);
  });

  it('acknowledges a figure the user kept, so an unchanged re-import raises nothing and a new change re-opens it (R4, R7)', () => {
    expect(header()).toContain("the server records MFC's rows and, for each part of the projection that differs, both sides' values, as they stand.");
    expect(header()).toContain("An import raises nothing for a part acknowledged at its present values, and records MFC's rows as it found them, so a partial catch-up on MFC leaves the rest acknowledged. A part that comes to differ at other values, by a new MFC change or a new app change, re-opens the figure (a new item, with a new rev); an import that finds every part equal ends the acknowledgement.");
  });

  it('keeps an align-MFC entry of MFC-expressible actions only where the MFC id is known, never writing to MFC (R8)', () => {
    const text = header();
    expect(text).toContain("For an acknowledged figure that has an MFC id, the server keeps an align-MFC entry imp/{site}/align/{S} while THE ALIGN PLAN changes a row: what to change on MFC, by hand, so that MFC holds the app's side as it stands now. The entry follows every change of the app's side, knowing edits included.");
    expect(text).toContain('and add_to_list on a row whose Count the entry lowers, or which leaves the collection, when the user has configured a disposition list (disposition_list, e.g. 206369) and a former copy of that row (by its origin) is disposed of as sold or traded.');
    expect(text).toContain("Per kind, while the rows of that kind hold more than the app's live copies of it, they give up the excess first from the Count beyond their own live copies of the kind (copies whose origin is the row), the row with the most such Count first and the highest-numbered on a tie, then from the highest-numbered row; a row left with none leaves the collection. A kind the app has more of grows its lowest-numbered row of that kind, or takes the lowest-numbered row out of the collection.");
    expect(text).toContain("The server never writes to MFC; a client links each action to the item's page on MFC. An entry clears itself when an import finds MFC matching, and a dismissed entry is not shown again until its actions change.");
  });

  it('returns one ordered review set right after the import (R7)', () => {
    expect(header()).toContain('THE REVIEW SET (R7). The response carries, in this order, the pending figure items of kind conflict, then divergence, then the held-edit cards, then the align-MFC entries as a separate, dismissable group; each group in head_id order, each item with the answers it allows, and a bulk answer per group (conflict: keep or take; divergence: keep or take; held edits: keep or take; align-MFC: dismiss).');
    expect(header()).toMatch(/What the user skips stays pending on every device and is badged, and an answered or acknowledged item never recurs on an import of an unchanged row\./);
    expect(header()).toContain("Before it presents the review set, or mints any edit or answer, the client that asked for the import pulls until it has applied the import's transaction: until its replica's marker imp/{site}/import holds an import at or above import_number.");
    expect(header()).toContain("The response carries the review set (R7), which the client presents once it has pulled the import's transaction (THE REVIEW SET).");
    expect(importProto).not.toMatch(/present(s)? (it|them) at once/);
  });

  it('resets a filing beside a kind change, and keeps disposals to the configured disposition list', () => {
    const text = header();
    expect(text).toMatch(/FILING\. Whenever the import upserts a copy's status to a kind its filing is not of, it writes occ\/\{occ\}\/collection \{"collection": "\{status\}\/default"\} in the same batch, as a device kind change does\. That is the only filing it writes, and it never compares one\./);
    expect(text).toMatch(/DISPOSITIONS\. Ross tracks dispositions on MFC as a list plus a note in a user field \(GR-Q3\)\. The import MAY write status former and occ\/\{occ\}\/disposal for rows of the user's configured disposition list; how that list and its note map to a disposal is desk item DL, so a 0\.3\.0 import writes neither, whatever pref disposition_list says\. No other row, and nothing else on the server, writes a former status or a disposal\./);
    expect(text).not.toMatch(/The import never writes a filing|maps no column to `former`/);
    const doc = prose(vocabSource.slice(vocabSource.indexOf('export const SERVER_FACET_FAMILIES'), vocabSource.indexOf('export const IMPORT_ITEMS')));
    expect(doc).toMatch(/The per-figure items the import keeps on the feed \(import\.proto THE SERVER DECIDES\), keyed imp\/\{site\}\/\{item\}\/\{head_id\}: a figure item, held edits, a change entry and an align-MFC entry\./);
  });

  it('keeps the row counters partitioning resolved rows, and reserves the removed held-change counter and review kind', () => {
    expect(prose(importProto)).toMatch(/added \+ moved \+ unchanged \+ kept_newer == resolved/);
    expect(prose(importProto)).toContain('Resolved rows, not added, of a figure whose decision is a conflict this import left for the user (ASK), the app\'s side kept meanwhile. The 0.2.x name, a 0.3.0 meaning.');
    expect(importProto).toMatch(/reserved 15;\s+reserved "changes_held";/);
    expect(importProto).toMatch(/reserved 2;\s+reserved "IMPORT_REVIEW_KIND_MFC_CHANGE";/);
    expect(prose(importProto)).toContain('MFC ids of earlier imports absent from this export, of a figure whose decision tombstoned at least one occurrence status.');
    expect(prose(importProto)).toContain('The rev an answer names (res/{site}/{head_id} `rev`), with the item it names (`item`: figure, held, change or align, as facet_key has it).');
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
    expect(text).toMatch(/An `enum` gained where there was none narrows what the schema accepts, so it is flagged too\./);
  });

  it('says the server decides the import, and what comes back for the user', () => {
    const text = readme.replace(/\s+/g, ' ');
    expect(text).toContain("**The server decides** (`import.proto` THE SERVER DECIDES): every pushed event carries the basis it was made on, a late edit is replayed where it belongs, a change only MFC made is applied and listed with its undo, and conflicts, divergences, held edits and what to change on MFC by hand come back as items the client shows right after the import, once it has pulled the import's transaction. A late edit another device has already reacted to is held, a copy's head, status, filing and disposal together, until the user keeps or drops it.");
    expect(text).not.toMatch(/changes held for confirmation/);
    expect(text).toContain('golden/import-vectors.json replayed server scenarios, re-imports and review cases (R1-R8)');
    expect(text).not.toMatch(/import-crossing cases/);
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
