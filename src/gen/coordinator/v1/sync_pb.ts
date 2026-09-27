// ============================================================================
// coordinator.v1 — the sync feed.
//
// fc-mobile is offline-first: it holds a local copy, accepts edits with no
// network, and reconciles later. The feed below is the whole reconciliation
// surface. Three RPCs:
//
//   Delta   pull everything the server has that the client has not seen
//   Push    hand the server the edits made while offline
//   Status  where the server's head is, and what its clock reads
//
// THE WIRE EVENT is {facet_key, version, op, payload} and nothing else. The
// merge rule it serves is LWW-per-facet: the client applies an event when
// `version > local[facet_key]`, and drops it otherwise. Per-facet, not
// per-record — two devices editing different facets of the same record both
// win, which is the property bare record-level LWW throws away. The one
// exception is an import write that crosses an open edit of the client's own
// (rule 6, IMPORT CROSSINGS): it is presented to the user, neither applied
// nor dropped.
//
// SEVEN RULES THIS SHAPE ENCODES:
//
//  1. PAGING IS ON A SERVER SEQUENCE, NEVER A TIMESTAMP. `cursor` is opaque
//     to the client and positional server-side. Timestamp paging silently
//     skips records whose write commits after a reader has already passed
//     their timestamp — catalog-api's SyncService has exactly that bug. An
//     opaque cursor also means the server can change its paging basis
//     without a wire break.
//
//  2. `version` IS AN OPAQUE, LEXICOGRAPHICALLY-ORDERED STRING TOKEN — the
//     facet's `as_of` plus the HLC suffix of rule 5, never
//     google.protobuf.Timestamp. Same fidelity doctrine as the spine: a
//     PG-arbitrated instant must not round-trip through epoch seconds+nanos.
//
//     The merge rule is a STRING comparison, so the spelling is part of the
//     contract, not a formatting detail. The canonical form is UTC, a
//     trailing `Z`, and exactly six fractional digits:
//
//         2026-09-14T11:30:00.123456Z
//
//     Both halves are load-bearing. An offset form (+09:00) breaks the
//     identity between lexicographic order and instant order outright.
//     Variable precision breaks it more quietly: PostgreSQL renders a zero
//     fraction as `...:00Z`, and since '.' (0x2E) sorts below 'Z' (0x5A),
//     `2026-09-14T11:30:00Z` sorts GREATER than
//     `2026-09-14T11:30:00.000000Z` — one instant, two spellings, inverted.
//     A re-delivered event in the other spelling then satisfies
//     `version > local[facet]` and re-applies, destroying the property the
//     slice-2 acceptance names: a replay from cursor 0 must reach the same
//     state. Emitting the canonical form is the SERVER's obligation.
//
//     Because the token is opaque and compared only as text, it can carry
//     more than an instant (rule 5), provided every extension is a
//     fixed-width sortable suffix.
//
//  3. `payload` IS JSON TEXT, never google.protobuf.Struct. Struct folds
//     every JSON number to float64. Facet payloads carry prices and
//     identifiers as strings and must stay that way end to end.
//
//     A pushed payload over 65,536 bytes (MAX_PAYLOAD_BYTES, counted as
//     UTF-8) is REJECTED payload_invalid: payload over 65536 bytes. The cap
//     bounds what the server parses before any schema runs. A schema-valid
//     payload as JSON.stringify writes it is at most 60,133 bytes (a
//     10,000-code-point note of six-byte escapes, rule 6), so a client that
//     writes that way never meets the cap; one that adds whitespace or
//     escapes more characters can.
//
//  4. DISPLAY TIME IS NEVER RESTAMPED. `version` is a merge token, not the
//     thing the UI shows. The user's local edit time travels inside
//     `payload` (edited_at plus tz) and is shown as the user wrote it.
//     Conflating the two is how "edited just now" appears on a record edited
//     last Tuesday.
//
//  5. THE VERSION GRAMMAR (0.2.0). A user-owned facet is versioned by an HLC
//     anchored to a measured per-connection server offset
//     (StatusResponse.server_now_iso) and clamped only when the offset looks
//     suspect. Its token is the instant plus two fixed-width suffixes:
//
//         <instant>#<10-digit counter>#<32-hex device id>
//         2026-09-14T11:30:00.123456Z#0000000007#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e
//
//     The device id is the DPoP-enrolled device's uuid spelled as a
//     lowercase, dashless uuid (32 hex digits). Server-originated writes to a
//     user facet (the MFC import) use the reserved all-zero device id. The
//     bare <instant> form remains legal for server-owned facets; a Push of a
//     user-owned facet must carry the full form. The 0.1.0 sketch
//     `<instant>#<counter>` with no device id is not a valid token.
//
//     Without the device id two devices could mint equal versions for
//     different values, and each replica would keep whichever arrived first.
//     With it, the order is total. Every segment is fixed width over ASCII,
//     so a bytewise comparison of the text IS the order:
//
//       2026-09-14T11:30:00.123456Z                                       bare instant
//     < 2026-09-14T11:30:00.123456Z#0000000000#00000000000000000000000000000000
//                                                          server (import) device
//     < 2026-09-14T11:30:00.123456Z#0000000000#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e
//     < 2026-09-14T11:30:00.123456Z#0000000000#9c1e3a5b7d9f1b3d5f7a9c1e3b5d7f9a
//                                                          device breaks the tie
//     < 2026-09-14T11:30:00.123456Z#0000000009#ffffffffffffffffffffffffffffffff
//     < 2026-09-14T11:30:00.123456Z#0000000010#00000000000000000000000000000000
//                                               counter outranks device; #10 > #9
//     < 2026-09-14T11:30:00.123457Z                     a later instant beats any suffix
//
//     Compare versions bytewise and nowhere else. Tokens in the grammar order
//     the same under C, glibc and ICU collations, because every segment is
//     fixed-width digits or lowercase hex at a fixed position. Tokens outside
//     it need not: an uppercase or a dashed device id can order differently
//     under en_US. So the server rejects an out-of-grammar token before it is
//     stored (version_malformed), and PostgreSQL compares on a column
//     declared TEXT COLLATE "C" or in the handler, never with `<` under a
//     locale collation. The package ships compareVersion() and
//     golden/version-vectors.json, whose collationTraps are the pairs to test
//     that rejection with; every implementation tests against it.
//
//     THE CLOCK. The client's Hlc ticks on its wall clock plus the offset
//     measured from the latest Status, and never below that Status sample
//     plus the monotonic time elapsed since it, so a backward wall-clock
//     correction mid-session cannot mint below the sample. While the anchor
//     is fresh (since the sample, the wall clock has not run ahead of
//     monotonic time by more than 5 minutes) a tick is also capped at the
//     sample plus elapsed monotonic time plus 5 minutes, which binds only
//     when a long round trip makes the offset suspect. The client calls
//     Hlc.rebase() after each session's first Status (a no-op when the clock
//     is not ahead). So once anchored and rebased, a tick never passes
//     server-now plus the clamp (assuming the client's monotonic time keeps
//     server rate) while the anchor is fresh and every earlier edit minted
//     past the bound has been answered, or re-minted after a rebase if
//     unpushed, and re-minted if REJECTED version_future or dropped, after a
//     rebase if past the fresh Status sample, for any other code (bar a 1 us
//     carry past a token at the bound whose counter is exhausted). That rests
//     on the server's check order: the server runs the REJECTED checks in the
//     listed order (version_malformed, version_future,
//     facet_key_not_user_owned, device_mismatch, payload_invalid), all
//     before any STALE, REVIEW or APPLIED routing, so an event past
//     server_now + 5 minutes is REJECTED version_future unless an
//     earlier-listed check fails, whatever the field's policy and whatever
//     the stored version. Every version the server emits, in Delta or as
//     `current`, is at most server_now + 5 minutes when emitted: a pushed
//     one by the check order, and every server write, the import and
//     server-owned facets included, at most server_now. The Hlc folds tokens
//     unclamped, so the bound depends on this. server_now is one clock that never steps back: the one Status
//     samples and the one version_future checks against.
//
//     A larger forward gap is a sleep (monotonic time stalls) or a wall-clock
//     jump, and two clocks cannot tell them apart, so the Hlc trusts the wall:
//     an edit made after a sleep still outranks one made before it. The
//     trade-off: a stale anchor may tick past server-now plus the clamp, and
//     the server's version_future check is the backstop only when the push
//     precedes real time catching up. An edit pushed later is accepted at its
//     inflated version and outranks edits other devices made in between. A
//     tick past the bound is carried two ways: it holds the clock ahead, and
//     as a base it lifts the next edit on its facet. Until real time overtakes
//     it or it has been answered, or re-minted after a rebase if unpushed,
//     and re-minted if REJECTED version_future or dropped, after a rebase if
//     past the fresh Status sample, for any other code, later ticks may pass
//     the bound even on a fresh anchor.
//     The same holds before a session's first Status, when the Hlc runs on
//     the offset restored from the last one: if the wall clock was corrected
//     in between, ticks are off by that old offset. A phone on automatic time
//     keeps its offset near zero and is unaffected by either.
//
//     THE FACET FLOOR. Before minting any edit the client hands the facet's
//     current local version to Hlc.tick(base) (undefined when it holds none),
//     so the edit lands above it even after rebase() has lowered the clock
//     below versions the client already holds. After a push is REJECTED
//     version_future the client takes a fresh Status, calls Hlc.rebase(),
//     adopts `current` and re-mints with Hlc.tick(base). After any REJECTED
//     edit, whatever the code, the client takes a fresh Status and, if the
//     edit's version is past the fresh Status sample (server_now_iso), calls
//     Hlc.rebase() before it mints again: a dropped edit held the clock ahead
//     too. After any rebase, re-mint every unpushed edit past the new present,
//     on its facet's server version with Hlc.tick(base), the first Status's
//     rebase included, and a later edit on that facet takes the re-minted
//     version as its base: handed to tick as a base, the old version would
//     carry the rebased clock past the bound. An edit pushed but not yet
//     answered is not re-minted in place: its retry carries the same
//     client_id and the server answers with each event's recorded outcome
//     (PushRequest.client_id), so it is
//     re-minted only if that answer is REJECTED. Until it is answered, later
//     ticks on that facet, and through the clock every later tick, may pass
//     the bound. The Hlc never clamps a base or an observed token: a clamp
//     there would mint an edit below its base, and every version the server
//     emits is bounded (THE CLOCK).
//
//     SEMANTIC CHANGE, SAFE ONLY BECAUSE NOTHING CONSUMES 0.1.0 SyncService.
//     buf cannot see a grammar change; this comment and the golden vectors
//     are the guard. From 0.2.0 on the grammar is frozen: extend it only by a
//     further fixed-width suffix, never by a separate field.
//
//  6. USER-OWNED FACET KEYS (0.3.0). The client may write only the keys in
//     this table; every other key is server-owned and a Push of one is
//     REJECTED facet_key_not_user_owned. {occ}, {cid} and {tag} are
//     device-minted uuids and {head_id} is the spine product id, all spelled
//     as PostgreSQL renders a uuid: lowercase, dashed. {kind} is owned,
//     ordered, wished or former. `default` is legal only as a collection id.
//
//         occ/{occ}/head                    {"head_id": uuid}
//         occ/{occ}/status                  {"status": "owned"|"ordered"|"wished"|"former"}
//         occ/{occ}/collection              {"collection": "{kind}/{cid|default}"}
//         occ/{occ}/disposal                {"reason": "sold"|"traded"|"gifted"|"damaged"|
//                                            "lost"|"stolen"|"other", "on"?, "note"?,
//                                            "counterparty"?, "price"?: {"amount", "currency"}}
//         occ/{occ}/tag/{tag}               {}
//         uf/{head_id}/score                {"score": 1..10}
//         uf/{head_id}/note                 {"note": "<= 10,000 code points"}
//         uf/{head_id}/wishability          {"wishability": 1..5}
//         uf/{head_id}/tag/{tag}            {}
//         uf/{head_id}/ktag/{kind}/{tag}    {}
//         coll/{kind}/{cid|default}/name    {"name": "1..100 code points"}
//         tag/{tag}/name                    {"name": "1..100 code points"}
//
//     Every payload in this table also carries edited_at (ISO-8601 with the
//     device's local offset) and tz (IANA name), for display only; {} carries
//     nothing else.
//
//     SERVER-OWNED KEYS a client reads but never pushes:
//
//         occ/{occ}/origin                  {"site", "native_id", "ordinal"}: the
//                                           import row the copy came from
//         imp/{site}/base/{key}             the import's base for {key}
//         imp/{site}/conflict/{key}         a re-import conflict on {key}
//
//     ({key} is a key the import writes; import.proto has the rule.)
//
//     RETIRED: holding/{head_id}/status and holding/{head_id}/count (0.2.x)
//     are no longer user-owned; a Push of either is REJECTED
//     facet_key_not_user_owned. Rows already stored stay inert.
//
//     OCCURRENCES. An occurrence is one copy, physical or intended (wished
//     or ordered): one record per copy and no quantity field. A quantity, per
//     figure and kind or per collection, is the count of live occurrences, so
//     a move can never create or lose a copy. An occurrence is live while its
//     status facet is live and its head facet is present; one with a live
//     status and no head (a partial batch) is hidden, flagged and never
//     counted. The head is written with the first status and never tombstoned
//     by an ordinary removal, so a removed copy keeps its figure and undo
//     (re-upserting the status) restores it whole. A wrong-variant fix or an
//     ER un-merge re-points a copy with one write of its head. Removing a copy
//     tombstones its status (soft delete). `former` is a live status (no
//     longer owned) and is never counted as held. A disposal describes a
//     former copy; it is kept, and hidden, while the status is anything else.
//
//     COLLECTIONS AND THE DISPLAY RULE. A collection's kind is part of its
//     key. Every user has the four {kind}/default collections implicitly:
//     they need no create and cannot be deleted, and a name facet only
//     renames one. A user collection exists while its name facet is live. A
//     copy is shown in its filed collection if that collection exists and its
//     kind equals the copy's status; otherwise in {status}/default, flagged
//     when the filing is dangling or of another kind. So every live copy
//     shows in exactly one collection, and a stale filing can lose a move but
//     never an arrival. A device write that changes a copy's kind also writes
//     or tombstones its filing in the same batch, and an import write that
//     sets a status of another kind than the filing writes it {status}/default
//     (import.proto FILING). Deleting a collection tombstones its name only:
//     its copies show in the default, and undo restores them.
//
//     TAGS. A tag exists while tag/{tag}/name is live. Membership is one facet
//     per (target, tag): upsert = member, tombstone = not. Three scopes:
//     occ/{occ}/tag/{tag} is one copy; uf/{head_id}/tag/{tag} is the figure as
//     a whole, with or without copies; uf/{head_id}/ktag/{kind}/{tag} is every
//     copy of the figure whose status is {kind}, evaluated at read time, so a
//     copy that arrives later picks it up and one that leaves drops it with no
//     write. The effective tags of a copy are its own, its figure's, and its
//     figure's tags for its status. Tags never change a status or a filing.
//
//     LIBRARY. A figure is in the library while any live user facet
//     references it: a live occurrence's head or any live uf/{head_id} facet.
//
//     READERS. A reader stores an unknown key form, kind, status or reason,
//     hides it, never counts it and never pushes it, and re-parses its stored
//     rows on every local-store upgrade, so a later release's keys need no
//     device migration.
//
//     PICKS. An action on one of N identical copies picks by occurrence id
//     alone: the lowest to receive or keep, the highest to remove. Two
//     devices acting on the same intent then converge on the same copy.
//
//     PAYLOADS. JSON Schemas ship in schemas/, every one closed
//     (additionalProperties false). The schemas check writes only: the client
//     before it mints, the server on Push. A published payload schema never
//     gains a property; a new attribute is a new facet key. Every write
//     replaces the whole payload, so an older writer would silently drop a
//     property it does not know.
//
//     ER MERGES. Keys are written against the ids of their time and never
//     re-keyed, and occurrence, collection and tag ids are never reused. A
//     card groups occurrences whose head is any of its requested_as, and
//     their counts sum; there is no status tiebreak. For each uf field the
//     live facet with the higher version among requested_as is displayed,
//     the lower head_id (bytewise) between equal versions (one import's
//     writes under heads merged later), and new writes go to its head_id (a
//     card with none uses card.head_id); a delete tombstones that field on
//     every requested_as head holding it live, each minted on its own facet's
//     version. Tag sets union across requested_as, and an untag tombstones
//     the membership on every head that holds it. A client that hydrates over
//     several GetProducts calls groups cards by head_id across every call and
//     page and unions their requested_as; the display, write-target and
//     delete rules apply to that union.
//
//     IMPORT CROSSINGS. An import write is an event whose version carries the
//     reserved all-zero device (rule 5). The import's three-way rule
//     (import.proto) sees only edits the server holds, so a client catches
//     the rest. An edit of its own to K is OPEN from when the client mints it
//     until its Delta delivers K at or above the edit's version, and a key's
//     open edits CHANGE it unless the latest restates the value the client
//     showed for the key before the oldest was minted. An edit crossed or
//     held by a pending import conflict stays OPEN until that conflict ends,
//     whatever the Delta delivers meanwhile: the event that crosses it never
//     closes it, and a delivery at or above its version meanwhile closes it
//     when the conflict ends. An arriving event is NEW when the client has
//     not taken that version of its key, or a higher one; one that is not (a
//     replay from an empty cursor, or a `current` already taken) crosses
//     nothing again, even once the user has resolved what it crossed. A new
//     import write to K, or a new conflict raised on K (a write to
//     imp/mfc/conflict/{K}, MFC's side being imp/mfc/base/{K}), arriving in
//     Delta or as `current` on a STALE result, is checked against the
//     client's open edits. Of those, the ones to K are dropped when none of
//     them has been pushed and together they do not change K, and K's local
//     facet reverts to the value and version it had before the oldest of them
//     was minted. Then, when MFC's side differs from the value the client
//     shows for K (K's own fields, never edited_at or tz; a tombstone is no
//     value), it CROSSES:
//
//       * the open edits to K;
//       * ROW GRAIN, when it writes occ/{x}/status and removes a copy the
//         client shows live or adds one the client shows with none: the open
//         edits that change the status of another copy of x's row (a copy
//         whose origin names x's MFC id). For a removal, also those that
//         change the status of another copy with an origin on x's figure
//         (another MFC row for the same figure) or re-point a copy with an
//         origin off x's figure (a wrong-variant fix). For an addition, also
//         those that set another copy of x's figure, with no origin or of
//         another row, to the kind it adds, or re-point a copy showing that
//         kind onto x's figure. The import writes a copy's origin and head
//         before its status, so the client knows both when the status
//         arrives. A ROW GRAIN crossing is presented with the row's counts,
//         the client's after its open edits beside MFC's (the row's copies
//         with a live base status), since the two can agree while the copies
//         differ; the user then keeps the app's side.
//
//     An event that crosses no edit follows the ordinary rules. One that
//     crosses is neither applied nor dropped: the client keeps showing its
//     own value, holds the event as MFC's side of a pending import conflict
//     on K, stored with the outbox so a reload keeps it, and pushes no edit to
//     K, or to the key of an edit it crossed, until the conflict ends. A later
//     import write to K, or conflict on K, only replaces MFC's side; a write
//     to K by any other device ends the conflict and follows the ordinary
//     rules, and so do the held edits. The user resolves it with an ordinary
//     write to K, minted with Hlc.tick(base) on the higher of the local and
//     MFC's side's version, that replaces the unpushed edits to K: keep the
//     app's value (write it again) or take MFC's (its value, or a tombstone).
//     The client then pushes the held edits to other keys, unless another
//     pending conflict holds them. An edit already pushed cannot be recalled;
//     if it lands the conflict stays until the user resolves it. Keeping the
//     app's side moves no base: a copy kept against a removal keeps its
//     tombstone base, so a later import that lowers the Count raises it
//     rather than removing it (presented, never silent: an accepted cost), and
//     MFC's copy removed by keeping an addition gives way to the app's copy
//     at the next import that changes the row (import.proto ADOPTION IN
//     PLACE). A client that calls ImportMfcExport first pushes its outbox,
//     held edits aside, and has every push answered, so the import's
//     three-way sees its own edits. golden/import-vectors.json has the cases.
//
//     IMPORT CONFLICTS. A pending imp/{site}/conflict/{key} is resolved only
//     by a write to {key} above the conflict facet's own version. A write to
//     {key} at or below that version that lands (an edit minted before the
//     conflict reached the server, pushed after it) has not seen the
//     conflict: in the same transaction the server re-upserts the conflict
//     facet, above its current version, with `against` moved to that write's
//     version, and the conflict stays pending (import.proto CONFLICTS). So a
//     resolution another device minted after seeing the conflict, but below
//     the re-upserted version, is taken as unseen and presented again: an
//     accepted cost, since presenting is the safe side (GR-Q1).
//
//     PRIVACY. Every user-owned facet is private to its user. Neither the
//     coordinator nor a client logs a payload or a name facet. An import
//     copy's occ id is a keyed MAC (import.proto OCCURRENCE IDS), so a key and
//     a user id do not reveal an MFC id.
//
//     SEMANTIC CHANGE, SAFE ONLY BECAUSE NO DEVICE HAS INSTALLED AND NO IMPORT
//     HAS RUN. 0.3.0 replaces 0.2.x's per-figure holding grain (one status per
//     user and product) with per-copy occurrences. buf cannot see a key
//     change: the wire is unchanged, and this comment, golden/key-vectors.json
//     and the vocabulary tests are the guard. 0.2.x is deprecated.
//
//  7. DEFERRED, DELIBERATELY. There is no Resync or prune signal and no Ack
//     RPC in 0.2.0: the feed never prunes yet. The recovery for an unreadable
//     cursor is INVALID_ARGUMENT followed by a replay from an empty cursor.
//     A prune, when one comes, keeps every import write and every
//     imp/{site}/conflict write, even one a later write to its key
//     superseded: a client catches an import write or conflict that crossed
//     an edit of its own only by seeing it (rule 6, IMPORT CROSSINGS).
// ============================================================================

// @generated by protoc-gen-es v2.15.0 with parameter "target=ts,import_extension=js"
// @generated from file coordinator/v1/sync.proto (package coordinator.v1, syntax proto3)
/* eslint-disable */

import type { GenEnum, GenFile, GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";
import { enumDesc, fileDesc, messageDesc, serviceDesc } from "@bufbuild/protobuf/codegenv2";
import type { Message } from "@bufbuild/protobuf";

/**
 * Describes the file coordinator/v1/sync.proto.
 */
export const file_coordinator_v1_sync: GenFile = /*@__PURE__*/
  fileDesc("Chljb29yZGluYXRvci92MS9zeW5jLnByb3RvEg5jb29yZGluYXRvci52MSJkCglTeW5jRXZlbnQSEQoJZmFjZXRfa2V5GAEgASgJEg8KB3ZlcnNpb24YAiABKAkSIgoCb3AYAyABKA4yFi5jb29yZGluYXRvci52MS5TeW5jT3ASDwoHcGF5bG9hZBgEIAEoCSItCgxEZWx0YVJlcXVlc3QSDgoGY3Vyc29yGAEgASgJEg0KBWxpbWl0GAIgASgNImEKDURlbHRhUmVzcG9uc2USKQoGZXZlbnRzGAEgAygLMhkuY29vcmRpbmF0b3IudjEuU3luY0V2ZW50EhMKC25leHRfY3Vyc29yGAIgASgJEhAKCGhhc19tb3JlGAMgASgIIksKC1B1c2hSZXF1ZXN0EhEKCWNsaWVudF9pZBgBIAEoCRIpCgZldmVudHMYAiADKAsyGS5jb29yZGluYXRvci52MS5TeW5jRXZlbnQimgEKClB1c2hSZXN1bHQSEQoJZmFjZXRfa2V5GAEgASgJEiwKB291dGNvbWUYAiABKA4yGy5jb29yZGluYXRvci52MS5QdXNoT3V0Y29tZRIPCgd2ZXJzaW9uGAMgASgJEioKB2N1cnJlbnQYBCABKAsyGS5jb29yZGluYXRvci52MS5TeW5jRXZlbnQSDgoGcmVhc29uGAUgASgJIjsKDFB1c2hSZXNwb25zZRIrCgdyZXN1bHRzGAEgAygLMhouY29vcmRpbmF0b3IudjEuUHVzaFJlc3VsdCIPCg1TdGF0dXNSZXF1ZXN0IlAKDlN0YXR1c1Jlc3BvbnNlEg4KBmN1cnNvchgBIAEoCRIWCg5wZW5kaW5nX3JldmlldxgCIAEoBBIWCg5zZXJ2ZXJfbm93X2lzbxgDIAEoCSpJCgZTeW5jT3ASFwoTU1lOQ19PUF9VTlNQRUNJRklFRBAAEhIKDlNZTkNfT1BfVVBTRVJUEAESEgoOU1lOQ19PUF9ERUxFVEUQAiqtAQoLUHVzaE91dGNvbWUSHAoYUFVTSF9PVVRDT01FX1VOU1BFQ0lGSUVEEAASGAoUUFVTSF9PVVRDT01FX0FQUExJRUQQARIaChZQVVNIX09VVENPTUVfRFVQTElDQVRFEAISFgoSUFVTSF9PVVRDT01FX1NUQUxFEAMSFwoTUFVTSF9PVVRDT01FX1JFVklFVxAEEhkKFVBVU0hfT1VUQ09NRV9SRUpFQ1RFRBAFMt8BCgtTeW5jU2VydmljZRJECgVEZWx0YRIcLmNvb3JkaW5hdG9yLnYxLkRlbHRhUmVxdWVzdBodLmNvb3JkaW5hdG9yLnYxLkRlbHRhUmVzcG9uc2USQQoEUHVzaBIbLmNvb3JkaW5hdG9yLnYxLlB1c2hSZXF1ZXN0GhwuY29vcmRpbmF0b3IudjEuUHVzaFJlc3BvbnNlEkcKBlN0YXR1cxIdLmNvb3JkaW5hdG9yLnYxLlN0YXR1c1JlcXVlc3QaHi5jb29yZGluYXRvci52MS5TdGF0dXNSZXNwb25zZWIGcHJvdG8z");

/**
 * ---------------------------------------------------------------------------
 * SyncEvent — one facet at one version. The only event shape on this feed,
 * in both directions: the server emits these in Delta, the client emits the
 * same message in Push.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.SyncEvent
 */
export type SyncEvent = Message<"coordinator.v1.SyncEvent"> & {
  /**
   * Stable identity of the facet being replaced; the key of the client's
   * local version map. Never reused for a different facet, because a reused
   * key would make a stale event win. User-owned keys follow rule 6.
   *
   * @generated from field: string facet_key = 1;
   */
  facetKey: string;

  /**
   * The merge token, in the grammar of rule 5, compared bytewise. The client
   * applies this event iff version > local[facet_key].
   *
   * @generated from field: string version = 2;
   */
  version: string;

  /**
   * Upsert or tombstone.
   *
   * @generated from field: coordinator.v1.SyncOp op = 3;
   */
  op: SyncOp;

  /**
   * The facet value as JSON TEXT (rule 3), at most MAX_PAYLOAD_BYTES (65,536)
   * UTF-8 bytes on Push. Empty when op is SYNC_OP_DELETE.
   *
   * @generated from field: string payload = 4;
   */
  payload: string;
};

/**
 * Describes the message coordinator.v1.SyncEvent.
 * Use `create(SyncEventSchema)` to create a new message.
 */
export const SyncEventSchema: GenMessage<SyncEvent> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 0);

/**
 * ---------------------------------------------------------------------------
 * Delta — pull. Resume is exact: replaying from an empty cursor must reach
 * the same state as any partial replay, which is the property the two-device
 * acceptance checks.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.DeltaRequest
 */
export type DeltaRequest = Message<"coordinator.v1.DeltaRequest"> & {
  /**
   * Opaque resume token from a previous DeltaResponse. Empty means "from the
   * beginning of this user's feed".
   *
   * @generated from field: string cursor = 1;
   */
  cursor: string;

  /**
   * Maximum events to return. 0 means the server's default; the server may
   * return fewer, and `has_more` — not a short page — is what says whether
   * to ask again.
   *
   * @generated from field: uint32 limit = 2;
   */
  limit: number;
};

/**
 * Describes the message coordinator.v1.DeltaRequest.
 * Use `create(DeltaRequestSchema)` to create a new message.
 */
export const DeltaRequestSchema: GenMessage<DeltaRequest> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 1);

/**
 * @generated from message coordinator.v1.DeltaResponse
 */
export type DeltaResponse = Message<"coordinator.v1.DeltaResponse"> & {
  /**
   * In feed order. Applying them in order is required: two events for the
   * same facet_key may appear in one page.
   *
   * @generated from field: repeated coordinator.v1.SyncEvent events = 1;
   */
  events: SyncEvent[];

  /**
   * Pass to the next DeltaRequest. Always set, including on the last page,
   * so a caller can park it and resume later.
   *
   * @generated from field: string next_cursor = 2;
   */
  nextCursor: string;

  /**
   * Whether more events are already waiting. False does not mean "nothing
   * will ever arrive"; it means the client has caught up to the head.
   *
   * @generated from field: bool has_more = 3;
   */
  hasMore: boolean;
};

/**
 * Describes the message coordinator.v1.DeltaResponse.
 * Use `create(DeltaResponseSchema)` to create a new message.
 */
export const DeltaResponseSchema: GenMessage<DeltaResponse> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 2);

/**
 * ---------------------------------------------------------------------------
 * Push — the offline edits. Idempotent per user: replaying an identical
 * batch after a dropped response must not double-apply.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.PushRequest
 */
export type PushRequest = Message<"coordinator.v1.PushRequest"> & {
  /**
   * Client-chosen idempotency key, unique per user: 1 to 128 characters, each
   * printable ASCII 0x21-0x7E (no space, control or non-ASCII character);
   * anything else is INVALID_ARGUMENT, checked before the transaction opens.
   * A retry of the same batch MUST carry the same client_id and the same
   * events. A replay (same client_id, same events) returns each event's
   * recorded outcome and reason, and never re-applies: an event first APPLIED
   * is answered DUPLICATE, one first REJECTED is REJECTED again with the same
   * reason, one first STALE is STALE again and one first REVIEW is REVIEW
   * again. `current` on every replayed user-owned result is the facet as the
   * server holds it at the replay. The same client_id with different events
   * is INVALID_ARGUMENT. This is what makes an unacknowledged push safe to
   * retry on reconnect.
   *
   * @generated from field: string client_id = 1;
   */
  clientId: string;

  /**
   * The edits, oldest first. Order matters for the same reason as in
   * DeltaResponse.
   *
   * @generated from field: repeated coordinator.v1.SyncEvent events = 2;
   */
  events: SyncEvent[];
};

/**
 * Describes the message coordinator.v1.PushRequest.
 * Use `create(PushRequestSchema)` to create a new message.
 */
export const PushRequestSchema: GenMessage<PushRequest> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 3);

/**
 * ---------------------------------------------------------------------------
 * PushResult — one per pushed event.
 *
 * THE CLIENT RULE: adopt `current` whole — version, op and payload together.
 * Never pair the server's version with the client's losing payload. (0.1.0
 * told the client to store `version` alone; a STALE or REVIEW client then held
 * its losing value under the server's version, and the Delta event at that
 * version was dropped as not newer. That device never converged.)
 *
 *   * local[facet_key] still holds the event this result answers (same
 *     version): replace it with `current` on every outcome, regardless of
 *     which of the two versions is higher. REVIEW and REJECTED can hand back an
 *     OLDER version; the server did not keep the client's write, so the
 *     local copy must not keep it either. When `current` is unset, drop the
 *     local value and its version so any later Delta event applies.
 *   * local has moved past that event since the push (a Delta event or a
 *     newer local edit): treat `current` as a Delta event and apply it only
 *     if current.version > local[facet_key].
 *   * the one exception: `current` that is an import write crossing the
 *     client's open edits to facet_key (rule 6, IMPORT CROSSINGS) is held as
 *     MFC's side of a pending import conflict, and neither bullet applies.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.PushResult
 */
export type PushResult = Message<"coordinator.v1.PushResult"> & {
  /**
   * Echoes the facet_key of the event this result answers. Results are
   * returned in request order, one per event; the echo makes a client-side
   * mismatch loud rather than silent.
   *
   * @generated from field: string facet_key = 1;
   */
  facetKey: string;

  /**
   * @generated from field: coordinator.v1.PushOutcome outcome = 2;
   */
  outcome: PushOutcome;

  /**
   * Equals current.version when `current` is set, and is empty when it is
   * not. Kept for 0.1.0 wire compatibility; do not use it on its own.
   *
   * @generated from field: string version = 3;
   */
  version: string;

  /**
   * The server's authoritative facet for facet_key after this push. Always
   * set on APPLIED, DUPLICATE, STALE and REVIEW. On REJECTED it is set only
   * when the key is user-owned and the server holds a value for it. A replay
   * (same client_id, same events) returns each event's recorded outcome and
   * reason: an event first APPLIED is answered DUPLICATE, one first REJECTED
   * is REJECTED again with the same reason, one first STALE is STALE again
   * and one first REVIEW is REVIEW again. `current` on every replayed
   * user-owned result is the facet as the server holds it at the replay.
   *
   * @generated from field: coordinator.v1.SyncEvent current = 4;
   */
  current?: SyncEvent | undefined;

  /**
   * Set only on REJECTED: a code from PushOutcome, then optional detail.
   * Branch on the code (the text before the first ':'), show the rest.
   *
   * @generated from field: string reason = 5;
   */
  reason: string;
};

/**
 * Describes the message coordinator.v1.PushResult.
 * Use `create(PushResultSchema)` to create a new message.
 */
export const PushResultSchema: GenMessage<PushResult> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 4);

/**
 * @generated from message coordinator.v1.PushResponse
 */
export type PushResponse = Message<"coordinator.v1.PushResponse"> & {
  /**
   * One per PushRequest.events entry, same order.
   *
   * @generated from field: repeated coordinator.v1.PushResult results = 1;
   */
  results: PushResult[];
};

/**
 * Describes the message coordinator.v1.PushResponse.
 * Use `create(PushResponseSchema)` to create a new message.
 */
export const PushResponseSchema: GenMessage<PushResponse> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 5);

/**
 * ---------------------------------------------------------------------------
 * Status — the cheap poll. Answers "am I behind?" without pulling a page,
 * and carries the clock sample the client's HLC is anchored to.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.StatusRequest
 */
export type StatusRequest = Message<"coordinator.v1.StatusRequest"> & {
};

/**
 * Describes the message coordinator.v1.StatusRequest.
 * Use `create(StatusRequestSchema)` to create a new message.
 */
export const StatusRequestSchema: GenMessage<StatusRequest> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 6);

/**
 * @generated from message coordinator.v1.StatusResponse
 */
export type StatusResponse = Message<"coordinator.v1.StatusResponse"> & {
  /**
   * The server's head cursor. A client whose stored cursor differs is
   * behind; comparing cursors is the only supported use — the value is
   * otherwise opaque.
   *
   * @generated from field: string cursor = 1;
   */
  cursor: string;

  /**
   * How many of this user's pushes are sitting in the review queue awaiting
   * a decision. 0 means nothing to review.
   *
   * @generated from field: uint64 pending_review = 2;
   */
  pendingReview: bigint;

  /**
   * The server's clock as a bare canonical instant (rule 2), sampled when
   * this response was built. The client measures its offset from this at the
   * midpoint of the round trip and anchors its HLC to it (rule 5). Never used
   * to restamp anything the user sees.
   *
   * @generated from field: string server_now_iso = 3;
   */
  serverNowIso: string;
};

/**
 * Describes the message coordinator.v1.StatusResponse.
 * Use `create(StatusResponseSchema)` to create a new message.
 */
export const StatusResponseSchema: GenMessage<StatusResponse> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_sync, 7);

/**
 * ---------------------------------------------------------------------------
 * SyncOp — what the event does to the facet.
 * ---------------------------------------------------------------------------
 *
 * @generated from enum coordinator.v1.SyncOp
 */
export enum SyncOp {
  /**
   * Never emitted by a conforming server; present so an old client that has
   * not learned a newer op can tell "unknown to me" from "upsert".
   *
   * @generated from enum value: SYNC_OP_UNSPECIFIED = 0;
   */
  UNSPECIFIED = 0,

  /**
   * Replace the facet's value with `payload`. There is no partial update:
   * the facet is the unit of merge, so a facet is always carried whole.
   *
   * @generated from enum value: SYNC_OP_UPSERT = 1;
   */
  UPSERT = 1,

  /**
   * Tombstone the facet. A SOFT delete — the estate's retention policy is
   * soft-delete only, so this marks the facet absent at `version` and never
   * instructs anyone to destroy rows. `payload` is empty for a tombstone.
   *
   * @generated from enum value: SYNC_OP_DELETE = 2;
   */
  DELETE = 2,
}

/**
 * Describes the enum coordinator.v1.SyncOp.
 */
export const SyncOpSchema: GenEnum<SyncOp> = /*@__PURE__*/
  enumDesc(file_coordinator_v1_sync, 0);

/**
 * ---------------------------------------------------------------------------
 * PushOutcome — what the server did with one pushed event.
 *
 * Bare LWW would need only applied/stale. The extra two exist because this
 * feed carries a field-level conflict policy (AUTO_ACCEPT | REVIEW | LOCKED)
 * over user overrides: an enricher must not silently overwrite something the
 * user set deliberately, so some writes land in a review queue instead of in
 * the facet.
 * ---------------------------------------------------------------------------
 *
 * @generated from enum coordinator.v1.PushOutcome
 */
export enum PushOutcome {
  /**
   * @generated from enum value: PUSH_OUTCOME_UNSPECIFIED = 0;
   */
  UNSPECIFIED = 0,

  /**
   * Written. `current` is the event as the server stored it.
   *
   * @generated from enum value: PUSH_OUTCOME_APPLIED = 1;
   */
  APPLIED = 1,

  /**
   * A replay (same client_id, same events) returns each event's recorded
   * outcome and reason: an event first APPLIED is answered DUPLICATE, one
   * first REJECTED is REJECTED again with the same reason, one first STALE is
   * STALE again and one first REVIEW is REVIEW again. `current` on every
   * replayed user-owned result is the facet as the server holds it at the
   * replay. DUPLICATE answers only an event that was written, and nothing is
   * written a second time.
   *
   * @generated from enum value: PUSH_OUTCOME_DUPLICATE = 2;
   */
  DUPLICATE = 2,

  /**
   * The server already holds a version >= this event's. Nothing written.
   * `current` is the winning facet, so the client converges without a Delta.
   *
   * @generated from enum value: PUSH_OUTCOME_STALE = 3;
   */
  STALE = 3,

  /**
   * The field's policy is REVIEW or LOCKED, so the write went to the pending
   * review queue instead of to the facet. `current` is the facet the server
   * kept: the client must NOT show the edit as landed.
   *
   * @generated from enum value: PUSH_OUTCOME_REVIEW = 4;
   */
  REVIEW = 4,

  /**
   * The event is unacceptable as sent and nothing was written. `reason`
   * starts with one of these codes, then optionally ": " and detail:
   *   version_malformed         not the grammar of rule 5 (a user-owned key
   *                             needs the full <instant>#<counter>#<device>)
   *   version_future            instant later than server_now + 5 minutes
   *   facet_key_not_user_owned  the key is not one of rule 6's user-owned forms
   *                             (a retired holding/* key included)
   *   device_mismatch           the version's device id is not the caller's
   *                             DPoP-bound device
   *   payload_invalid           the payload is over MAX_PAYLOAD_BYTES (rule 3),
   *                             fails its JSON Schema, an UPSERT is empty, a
   *                             DELETE is not, or op is unknown
   * The server runs the REJECTED checks in the listed order (version_malformed,
   * version_future, facet_key_not_user_owned, device_mismatch,
   * payload_invalid), all before any STALE, REVIEW or APPLIED routing, so an
   * event past server_now + 5 minutes is REJECTED version_future unless an
   * earlier-listed check fails, whatever the field's policy and whatever the
   * stored version: rule 5's bound depends on it.
   * Retrying the same event cannot succeed: a replay under the same
   * client_id is REJECTED again with the same reason. For version_future the
   * client takes a fresh Status, calls Hlc.rebase(), adopts `current` and
   * re-mints with Hlc.tick(base) (rule 5), then re-mints the same way, on
   * its facet's server version, every other unpushed edit minted before the
   * rebase whose version is past the new present; for any other code it
   * drops the edit and tells the user. After any REJECTED edit, whatever the
   * code, the client takes a fresh Status and, if the edit's version is past
   * the fresh Status sample (server_now_iso), calls Hlc.rebase() before it
   * mints again. Before minting any edit,
   * not only a re-mint, the client hands Hlc.tick the facet's current local
   * version: a rebase can lower the clock below versions it holds for other
   * facets.
   *
   * @generated from enum value: PUSH_OUTCOME_REJECTED = 5;
   */
  REJECTED = 5,
}

/**
 * Describes the enum coordinator.v1.PushOutcome.
 */
export const PushOutcomeSchema: GenEnum<PushOutcome> = /*@__PURE__*/
  enumDesc(file_coordinator_v1_sync, 1);

/**
 * ---------------------------------------------------------------------------
 * SyncService — the whole offline-first reconciliation surface.
 *
 * ERROR CONTRACT:
 *   * an unreadable cursor -> INVALID_ARGUMENT. The client's recovery is a
 *     full replay from an empty cursor, which is always safe.
 *   * a client_id that is not 1 to 128 characters, each printable ASCII
 *     0x21-0x7E -> INVALID_ARGUMENT, checked before the transaction opens:
 *     without one a retry cannot be recognised, and a silently
 *     non-idempotent push is worse than a rejected one.
 *   * a client_id already recorded with different events ->
 *     INVALID_ARGUMENT: a replay must be the same batch, or its recorded
 *     outcomes would answer events it never carried.
 *   * a request message over 16 MiB (16,777,216 bytes) -> RESOURCE_EXHAUSTED.
 *     The limit applies to the PushRequest as the server reads it: its bytes
 *     in the encoding sent, binary or JSON, after decompression. Nothing is
 *     written and nothing is recorded under the client_id; the client splits
 *     the batch and pushes each part under a new client_id. A conforming
 *     client keeps each batch's binary-encoded size at or under 8 MiB
 *     (8,388,608 bytes); its JSON encoding is then within 16 MiB, so it never
 *     meets this error.
 *   * the user's push queue is full -> UNAVAILABLE: too many of that user's
 *     pushes are already waiting. Nothing is written and nothing is recorded
 *     under the client_id; like a lock timeout, the client backs off and
 *     retries later with the same client_id and the same events.
 *   * a lock timeout -> UNAVAILABLE. The transaction rolled back, so nothing
 *     is written and nothing is recorded under the client_id; the client
 *     retries with the same client_id and the same events, which is safe
 *     whether or not an earlier attempt landed.
 *   * a rejected individual event is NOT an RPC error. It comes back as a
 *     PushResult with a non-APPLIED outcome (STALE, REVIEW or REJECTED),
 *     because a batch with one bad event must not fail the other nineteen.
 * ---------------------------------------------------------------------------
 *
 * @generated from service coordinator.v1.SyncService
 */
export const SyncService: GenService<{
  /**
   * @generated from rpc coordinator.v1.SyncService.Delta
   */
  delta: {
    methodKind: "unary";
    input: typeof DeltaRequestSchema;
    output: typeof DeltaResponseSchema;
  },
  /**
   * @generated from rpc coordinator.v1.SyncService.Push
   */
  push: {
    methodKind: "unary";
    input: typeof PushRequestSchema;
    output: typeof PushResponseSchema;
  },
  /**
   * @generated from rpc coordinator.v1.SyncService.Status
   */
  status: {
    methodKind: "unary";
    input: typeof StatusRequestSchema;
    output: typeof StatusResponseSchema;
  },
}> = /*@__PURE__*/
  serviceDesc(file_coordinator_v1_sync, 0);

