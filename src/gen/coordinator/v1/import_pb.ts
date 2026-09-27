// ============================================================================
// coordinator.v1 — importing a user's MyFigureCollection export.
//
// ONLINE ONLY. The phone uploads the CSV text; the coordinator resolves each
// MFC id to a spine product and writes the user's facets (sync.proto rule 6)
// through the same apply path as SyncService.Push, under the per-user lock,
// so the import reaches every device as ordinary Delta events.
//
// VERSIONING (0.3.0). Every write of one import is versioned
//
//     <instant>#<per-user import counter>#<reserved server device>
//
// where <instant> is the server's clock when the import starts (at most
// server_now) and the reserved server device is the all-zero id (sync.proto
// rule 5). The per-user import counter increases with every import. Which
// side's change stands is no longer decided by version: THE THREE-WAY RULE
// below decides, and a phone catches an import write that crosses an edit it
// has not pushed or seen come back (sync.proto rule 6, IMPORT CROSSINGS). A
// facet whose stored version is not below the import's (a device edit minted
// within the clock skew of the import) is left, base included, for the next
// import. The import stamps edited_at as midnight UTC of export_date
// ("YYYY-MM-DDT00:00:00Z") and tz as "UTC".
//
// ROWS. An ID is made canonical first (canonicalMfcId): leading zeros are
// stripped, and what remains must be 1 to 64 ASCII digits. Every later step,
// occurrence ids and origin facets included, uses the canonical id. A row is
// unresolved, with the first reason that applies, in this order:
// "invalid_id" (no canonical id: "0", a sign, a space, a non-ASCII digit),
// "duplicate_id" (an earlier row has the same canonical id; the first row
// stands), "invalid_count" (Count is neither blank nor ASCII digits),
// "count_over_99", "no_product". An unresolved row writes nothing, and the
// import leaves its id's earlier copies and their figure values alone. Count
// blank means 1; Count 0 states no copies, and the row still states its
// figure values. Owned, Ordered and Wished map to the kinds owned, ordered
// and wished. A row's figure values are uf/{head_id}/score ("N/10"), note
// and wishability (1..5; 0 or blank is no value).
//
// OCCURRENCE IDS. A copy the import creates at ordinal k gets
//
//     occ_id = importOccIdFromMac(HMAC-SHA256(key, "{user_id}:mfc:{mfc_id}:{k}"))
//
// the MAC's first 16 bytes as an RFC 9562 version 8 uuid, lowercase and
// dashed (user_id the coordinator's user uuid, mfc_id the canonical id;
// mfcImportOccName builds the name). The key is the import occ-id key, held
// by the coordinator alone: never sent to a client, logged or shipped in this
// package (golden/key-vectors.json uses a published test key that is never
// the production one). So an occurrence key and a user id do not reveal an
// MFC id, and a retry of an import mints the same ids. With a copy it creates
// the import writes occ/{occ}/origin {site "mfc", native_id, ordinal},
// server-owned, and it finds its copies later through origin facets, never by
// recomputing ids: rotating or losing the key changes only the ids of copies
// created afterwards, and duplicates or re-keys nothing. The key never
// changes during an import.
//
// THE THREE-WAY RULE (Ross, 2026-09-27: a field changed both in the app and
// on MFC is presented to the user and not written until resolved). For each
// facet K the import compares (IMPORT_WRITTEN_FAMILIES: a copy's head and
// status, a disposal, a figure's score, note and wishability), the server
// keeps K's BASE, the value the last import took from MFC, in
// imp/mfc/base/{K} (K's own payload schema; a tombstone means MFC had no
// value). An import compares, over K's own fields and never edited_at or tz:
// M, what this export states; B, the base; and A, K as the server holds it
// (a tombstone or no facet is no value).
//
//   * M == B: MFC did not change it. Nothing is written.
//   * M != B and A == B: only MFC changed it. K and the base are set to M.
//   * M != B and A == M: both changed it alike. Only the base moves to M.
//   * M != B, A != B and A != M: both changed it differently, a CONFLICT.
//     K is not written. The base moves to M, so it holds MFC's side, and
//     imp/mfc/conflict/{K} is upserted {against: K's version, export_date}.
//
// ER MERGES. Heads are compared through the spine's redirect chain: two
// heads are equal when they resolve to one survivor, so a spine merge alone
// changes no M, B or A, writes nothing and re-keys nothing. A row's figure is
// the survivor its id resolves to. Rows resolving to one survivor each add
// their copies, and its figure values come from the numerically lowest MFC
// id among them; a survivor no row resolves to states no score, note or
// wishability. For a figure field, B is the base with the higher version
// among the heads resolving to the survivor, A is the value rule 6 displays,
// and K is rule 6's write target among those heads (the head of the live
// facet with the higher version, else the survivor): the head its base was
// written under unless the app deleted the field since. The import writes K,
// its base and its conflict there, and tombstones a field, as a device delete
// does, on every one of those heads holding it live.
//
// A ROW'S COPIES. The row's copies are the occurrences whose origin names its
// canonical id. A copy is UNCHANGED when its status and head, as the server
// holds them when the import starts, equal their bases then (absent equals
// absent). B_kind is the kind of the row's copies with a live base status,
// and B_count their number. A row absent from this export, or with Count 0,
// has M_count 0 and B_kind as its kind; otherwise M_count is its Count.
//
//   HEAD. For a row in this export, each of its copies with a base head runs
//   the three-way on its head, M being the row's figure.
//   KIND. When M_count > 0 and the row's kind differs from B_kind, each copy
//   with a live base status runs the three-way on its status, M being the
//   row's kind.
//   COUNT. Then A_count is the number of the row's copies that are live with
//   the row's kind and whose head resolves to the row's figure (for an absent
//   row, the survivor of its base heads).
//   * M_count == B_count: nothing more.
//   * A_count == M_count: only bases move.
//   * A_count == B_count: only MFC changed the count, and the import adds or
//     removes the difference by rule 6's PICKS, never writing the status of a
//     copy the app changed. To add, it upserts the status of the row's
//     unchanged copies of its figure that have no live status, lowest occ id
//     first; then adopts the live copies of the row's figure and kind that
//     carry no origin (added in the app), lowest occ id first, writing only
//     their origin; then creates copies (origin, head and status) at the
//     lowest unused ordinals. To remove, it tombstones the status of the
//     row's unchanged live copies of its figure and kind, highest occ id
//     first; any it still lacks it raises for removal, as below.
//   * Otherwise the count is a CONFLICT, held per copy so that each is
//     resolved by an ordinary write to that copy's status. For each copy MFC
//     has and the app lacks, the import raises for addition the row's copies
//     of its figure with no live status, lowest occ id first, then new copies
//     (origin and head written, status not); for each copy the app has and
//     MFC lacks, it raises for removal the row's live copies of its figure and
//     kind, unchanged ones first, highest occ id first. A raised copy's status
//     is not written, and imp/mfc/conflict/occ/{occ}/status is upserted; under
//     CONFLICTS below, a copy's M is the base status the row's bases give it.
//   Whenever M_count != B_count, the row's bases then describe MFC: a copy
//   raised for addition, or left live with the row's kind, its head resolving
//   to the row's figure and not raised for removal, gets the row's kind as
//   its base status and the row's figure as its base head; every other copy
//   of the row gets a tombstone base status.
//
// FILING. Whenever the import upserts a copy's status to a kind its filing is
// not of, it writes occ/{occ}/collection {"collection": "{status}/default"}
// in the same batch, as a device kind change does. That is the only filing it
// writes, and it never compares one.
//
// DISPOSITIONS. Ross tracks dispositions on MFC as a list plus a note in a
// user field (GR-Q3). The import MAY write status former and
// occ/{occ}/disposal for rows of the user's configured disposition list; its
// list and field names are desk item DL, and no request field carries them
// yet, so a 0.3.0 import writes neither. No other row, and nothing else on
// the server, writes a former status or a disposal. The import never writes
// a tag, a collection name or a tag name.
//
// CONFLICTS. A conflict is PENDING while its facet is live and K's version is
// still `against`; `against` is absent when K had no version, and the
// conflict is then pending while K has none. The user resolves it with an
// ordinary write to K through Push: keep the app's value (write it again) or
// take MFC's (the base's value, or a tombstone when the base is one). Any
// write to K after the conflict was raised resolves it, so a client shows a
// pending conflict wherever K is edited. Before its three-way, each import
// tombstones every conflict facet that is no longer pending; the base already
// holds the value the user decided against or took. A pending conflict is
// re-upserted, with the same `against`, only when M changed again, and
// tombstoned when M now equals A. A re-import of the same export writes
// nothing beyond those tombstones. golden/import-vectors.json has the cases.
//
// SEMANTIC CHANGE (0.3.0), SAFE ONLY BECAUSE NO IMPORT HAS RUN. 0.2.x wrote
// per-figure holding facets versioned at the export date, and any later
// device edit won. The row counters keep their names; their 0.3.0 meanings
// are on the fields below.
// ============================================================================

// @generated by protoc-gen-es v2.15.0 with parameter "target=ts,import_extension=js"
// @generated from file coordinator/v1/import.proto (package coordinator.v1, syntax proto3)
/* eslint-disable */

import type { GenFile, GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";
import { fileDesc, messageDesc, serviceDesc } from "@bufbuild/protobuf/codegenv2";
import type { Message } from "@bufbuild/protobuf";

/**
 * Describes the file coordinator/v1/import.proto.
 */
export const file_coordinator_v1_import: GenFile = /*@__PURE__*/
  fileDesc("Chtjb29yZGluYXRvci92MS9pbXBvcnQucHJvdG8SDmNvb3JkaW5hdG9yLnYxIj8KFkltcG9ydE1mY0V4cG9ydFJlcXVlc3QSEAoIY3N2X3RleHQYASABKAkSEwoLZXhwb3J0X2RhdGUYAiABKAki8gIKF0ltcG9ydE1mY0V4cG9ydFJlc3BvbnNlEhAKCHJlc29sdmVkGAEgASgNEjQKCnVucmVzb2x2ZWQYAiADKAsyIC5jb29yZGluYXRvci52MS5VbnJlc29sdmVkTWZjUm93Eg0KBWFkZGVkGAMgASgNEg0KBW1vdmVkGAQgASgNEhEKCXVuY2hhbmdlZBgFIAEoDRIPCgdyZW1vdmVkGAYgASgNEhYKDmZhY2V0c193cml0dGVuGAcgASgNEhIKCmtlcHRfbmV3ZXIYCCABKA0SGQoRb2NjdXJyZW5jZXNfYWRkZWQYCSABKA0SIgoab2NjdXJyZW5jZXNfc3RhdHVzX2NoYW5nZWQYCiABKA0SGwoTb2NjdXJyZW5jZXNfcmVtb3ZlZBgLIAEoDRIYChBjb25mbGljdHNfcmFpc2VkGAwgASgNEhkKEWNvbmZsaWN0c19wZW5kaW5nGA0gASgNEhAKCGtlcHRfYXBwGA4gASgNIlAKEFVucmVzb2x2ZWRNZmNSb3cSDgoGbWZjX2lkGAEgASgJEg4KBnN0YXR1cxgCIAEoCRIMCgRsaW5lGAMgASgNEg4KBnJlYXNvbhgEIAEoCTJzCg1JbXBvcnRTZXJ2aWNlEmIKD0ltcG9ydE1mY0V4cG9ydBImLmNvb3JkaW5hdG9yLnYxLkltcG9ydE1mY0V4cG9ydFJlcXVlc3QaJy5jb29yZGluYXRvci52MS5JbXBvcnRNZmNFeHBvcnRSZXNwb25zZWIGcHJvdG8z");

/**
 * @generated from message coordinator.v1.ImportMfcExportRequest
 */
export type ImportMfcExportRequest = Message<"coordinator.v1.ImportMfcExportRequest"> & {
  /**
   * The export as UTF-8 text, verbatim. At most 2 MiB; larger is
   * INVALID_ARGUMENT. Columns are found by header, because MFC lets the user
   * choose them: ID and Status are required, a ';' delimiter and quoted
   * fields are accepted, and a duplicated header (MFC writes Price twice) is
   * tolerated.
   *
   * @generated from field: string csv_text = 1;
   */
  csvText: string;

  /**
   * The calendar date MFC stamped on the export, "YYYY-MM-DD".
   *
   * @generated from field: string export_date = 2;
   */
  exportDate: string;
};

/**
 * Describes the message coordinator.v1.ImportMfcExportRequest.
 * Use `create(ImportMfcExportRequestSchema)` to create a new message.
 */
export const ImportMfcExportRequestSchema: GenMessage<ImportMfcExportRequest> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_import, 0);

/**
 * @generated from message coordinator.v1.ImportMfcExportResponse
 */
export type ImportMfcExportResponse = Message<"coordinator.v1.ImportMfcExportResponse"> & {
  /**
   * Rows not returned in `unresolved`: a canonical id first in the export, a
   * valid Count and a product. added + moved + unchanged + kept_newer ==
   * resolved.
   *
   * @generated from field: uint32 resolved = 1;
   */
  resolved: number;

  /**
   * Rows the import skipped, each with its reason (ROWS above). Nothing is
   * written for them.
   *
   * @generated from field: repeated coordinator.v1.UnresolvedMfcRow unresolved = 2;
   */
  unresolved: UnresolvedMfcRow[];

  /**
   * Resolved rows with no occurrence from an earlier import.
   *
   * @generated from field: uint32 added = 3;
   */
  added: number;

  /**
   * Resolved rows, not added, where this import wrote at least one
   * occurrence status: a kind change, e.g. Ordered to Owned, or a Count
   * change that added or removed copies.
   *
   * @generated from field: uint32 moved = 4;
   */
  moved: number;

  /**
   * Resolved rows neither added, moved nor kept_newer.
   *
   * @generated from field: uint32 unchanged = 5;
   */
  unchanged: number;

  /**
   * MFC ids of earlier imports absent from this export for which this import
   * tombstoned at least one occurrence status.
   *
   * @generated from field: uint32 removed = 6;
   */
  removed: number;

  /**
   * Feed events this import produced, server-owned facets included. A
   * re-import of the same export produces none beyond the tombstones of
   * conflicts resolved since.
   *
   * @generated from field: uint32 facets_written = 7;
   */
  facetsWritten: number;

  /**
   * Resolved rows, not added or moved, where at least one occurrence status
   * is held as a pending conflict: the app changed it too (0.3.0; see
   * conflicts_pending).
   *
   * @generated from field: uint32 kept_newer = 8;
   */
  keptNewer: number;

  /**
   * Copies this import made live: created, or restored after an earlier
   * import removed them. An adopted app copy was live already and is not
   * counted.
   *
   * @generated from field: uint32 occurrences_added = 9;
   */
  occurrencesAdded: number;

  /**
   * Existing occurrences whose status this import changed to another kind.
   *
   * @generated from field: uint32 occurrences_status_changed = 10;
   */
  occurrencesStatusChanged: number;

  /**
   * Occurrences whose status this import tombstoned.
   *
   * @generated from field: uint32 occurrences_removed = 11;
   */
  occurrencesRemoved: number;

  /**
   * Facets this import held as a new conflict.
   *
   * @generated from field: uint32 conflicts_raised = 12;
   */
  conflictsRaised: number;

  /**
   * Conflicts pending after this import, earlier ones included.
   *
   * @generated from field: uint32 conflicts_pending = 13;
   */
  conflictsPending: number;

  /**
   * Facets the app changed and this export did not, kept as the app has
   * them.
   *
   * @generated from field: uint32 kept_app = 14;
   */
  keptApp: number;
};

/**
 * Describes the message coordinator.v1.ImportMfcExportResponse.
 * Use `create(ImportMfcExportResponseSchema)` to create a new message.
 */
export const ImportMfcExportResponseSchema: GenMessage<ImportMfcExportResponse> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_import, 1);

/**
 * @generated from message coordinator.v1.UnresolvedMfcRow
 */
export type UnresolvedMfcRow = Message<"coordinator.v1.UnresolvedMfcRow"> & {
  /**
   * The MFC item id as it appears in the export.
   *
   * @generated from field: string mfc_id = 1;
   */
  mfcId: string;

  /**
   * The export's Status value for the row, verbatim.
   *
   * @generated from field: string status = 2;
   */
  status: string;

  /**
   * 1-based line number in csv_text, header included.
   *
   * @generated from field: uint32 line = 3;
   */
  line: number;

  /**
   * Why nothing was written, the first that applies: "invalid_id",
   * "duplicate_id", "invalid_count", "count_over_99" or "no_product" (ROWS
   * above). Empty from a 0.2.x server, meaning "no_product".
   *
   * @generated from field: string reason = 4;
   */
  reason: string;
};

/**
 * Describes the message coordinator.v1.UnresolvedMfcRow.
 * Use `create(UnresolvedMfcRowSchema)` to create a new message.
 */
export const UnresolvedMfcRowSchema: GenMessage<UnresolvedMfcRow> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_import, 2);

/**
 * ---------------------------------------------------------------------------
 * ImportService
 *
 * ERROR CONTRACT:
 *   * a missing ID or Status column -> INVALID_ARGUMENT naming the column.
 *   * csv_text over 2 MiB, or export_date not "YYYY-MM-DD" -> INVALID_ARGUMENT.
 *   * export_date later than the server's current UTC date plus one day
 *     -> INVALID_ARGUMENT. MFC stamps the date in its own zone, which can run
 *     a day ahead of UTC; anything later is a typo or a parse bug.
 *   * missing or invalid OIDC token or DPoP proof -> UNAUTHENTICATED.
 *   * spine unreachable -> UNAVAILABLE; nothing is written. A retry is safe:
 *     re-importing the same export writes nothing new.
 * ---------------------------------------------------------------------------
 *
 * @generated from service coordinator.v1.ImportService
 */
export const ImportService: GenService<{
  /**
   * @generated from rpc coordinator.v1.ImportService.ImportMfcExport
   */
  importMfcExport: {
    methodKind: "unary";
    input: typeof ImportMfcExportRequestSchema;
    output: typeof ImportMfcExportResponseSchema;
  },
}> = /*@__PURE__*/
  serviceDesc(file_coordinator_v1_import, 0);

