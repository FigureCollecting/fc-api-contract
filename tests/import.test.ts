import { describe, expect, it } from 'vitest';
import { create, equals, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import {
  ImportAnswer,
  ImportMfcExportRequestSchema,
  ImportMfcExportResponseSchema,
  ImportReviewGroupSchema,
  ImportReviewItemSchema,
  ImportReviewKind,
  ImportService,
  UnresolvedMfcRowSchema,
} from '../src/index.js';

describe('ImportService', () => {
  it('exposes ImportMfcExport', () => {
    expect(ImportService.typeName).toBe('coordinator.v1.ImportService');
    expect(Object.keys(ImportService.method)).toEqual(['importMfcExport']);
    expect(ImportService.method.importMfcExport.input).toBe(ImportMfcExportRequestSchema);
    expect(ImportService.method.importMfcExport.output).toBe(ImportMfcExportResponseSchema);
  });

  it('round-trips the CSV text byte for byte, delimiter and quoting intact', () => {
    const csv = 'ID;Status;"Title, with comma";Price;Price\r\n1144;Owned;"Miku ""V2""";12800;12800\r\n';
    const msg = create(ImportMfcExportRequestSchema, { csvText: csv, exportDate: '2026-09-09' });
    const decoded = fromBinary(ImportMfcExportRequestSchema, toBinary(ImportMfcExportRequestSchema, msg));

    expect(decoded.csvText).toBe(csv);
    expect(decoded.exportDate).toBe('2026-09-09');
  });

  it('round-trips the counts and the unresolved rows', () => {
    const msg = create(ImportMfcExportResponseSchema, {
      resolved: 1100,
      unresolved: [
        { mfcId: '3743689', status: 'Wished', line: 812, reason: 'no_product' },
        { mfcId: '1144', status: 'Owned', line: 2, reason: 'count_over_99' },
      ],
      added: 1090,
      moved: 4,
      unchanged: 3,
      held: 3,
      removed: 2,
      facetsWritten: 1310,
    });
    const decoded = fromJson(ImportMfcExportResponseSchema, toJson(ImportMfcExportResponseSchema, msg));

    expect(equals(ImportMfcExportResponseSchema, msg, decoded)).toBe(true);
    expect(decoded.held).toBe(3);
    expect(decoded.unresolved[0]).toMatchObject({ mfcId: '3743689', status: 'Wished', line: 812, reason: 'no_product' });
    expect(decoded.unresolved[1]?.reason).toBe('count_over_99');
  });

  it('round-trips the 0.3.0 per-occurrence, review and align counters on their additive field numbers', () => {
    const counters = {
      held: 4,
      occurrencesAdded: 1148,
      occurrencesStatusChanged: 3,
      occurrencesRemoved: 1,
      conflictsRaised: 2,
      conflictsPending: 5,
      divergencesPending: 7,
      changesHeld: 1,
      alignPending: 6,
      importNumber: 12,
    };
    const msg = create(ImportMfcExportResponseSchema, counters);
    const decoded = fromBinary(ImportMfcExportResponseSchema, toBinary(ImportMfcExportResponseSchema, msg));
    expect(decoded).toMatchObject(counters);
    const numbers = Object.fromEntries(ImportMfcExportResponseSchema.fields.map((f) => [f.name, f.number]));
    expect(numbers).toEqual({
      resolved: 1,
      unresolved: 2,
      added: 3,
      moved: 4,
      unchanged: 5,
      removed: 6,
      facets_written: 7,
      held: 8,
      occurrences_added: 9,
      occurrences_status_changed: 10,
      occurrences_removed: 11,
      conflicts_raised: 12,
      conflicts_pending: 13,
      divergences_pending: 14,
      changes_held: 15,
      align_pending: 16,
      import_number: 17,
      review: 18,
      applied: 19,
    });
    expect(Object.fromEntries(UnresolvedMfcRowSchema.fields.map((f) => [f.name, f.number]))).toMatchObject({ reason: 4 });
  });

  it('carries the review set (R7): ordered groups, each item with the answers it allows, a bulk answer per kind, and the applied changes with their undo', () => {
    expect(ImportReviewKind).toMatchObject({ UNSPECIFIED: 0, CONFLICT: 1, MFC_CHANGE: 2, DIVERGENCE: 3, HELD_EDITS: 4, ALIGN_MFC: 5 });
    expect(ImportAnswer).toMatchObject({ UNSPECIFIED: 0, KEEP: 1, TAKE: 2, PER_COPY: 3, UNDO: 4, DISMISS: 5 });
    expect(Object.fromEntries(ImportReviewGroupSchema.fields.map((f) => [f.name, f.number]))).toEqual({ kind: 1, items: 2, bulk: 3 });
    expect(Object.fromEntries(ImportReviewItemSchema.fields.map((f) => [f.name, f.number]))).toEqual({ facet_key: 1, head_id: 2, rev: 3, answers: 4, payload: 5 });
    const card = { facetKey: 'imp/mfc/figure/5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b', headId: '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b', rev: 'I2:owned1', payload: '{}' };
    const msg = create(ImportMfcExportResponseSchema, {
      review: [
        { kind: ImportReviewKind.CONFLICT, items: [{ ...card, answers: [ImportAnswer.KEEP, ImportAnswer.TAKE, ImportAnswer.PER_COPY] }], bulk: [ImportAnswer.KEEP, ImportAnswer.TAKE] },
        { kind: ImportReviewKind.ALIGN_MFC, items: [{ ...card, facetKey: card.facetKey.replace('figure', 'align'), answers: [ImportAnswer.DISMISS] }], bulk: [ImportAnswer.DISMISS] },
      ],
      applied: [{ ...card, facetKey: card.facetKey.replace('figure', 'change'), answers: [ImportAnswer.UNDO, ImportAnswer.DISMISS] }],
    });
    const decoded = fromJson(ImportMfcExportResponseSchema, toJson(ImportMfcExportResponseSchema, msg));
    expect(equals(ImportMfcExportResponseSchema, msg, decoded)).toBe(true);
    expect(decoded.review.map((g) => g.kind)).toEqual([ImportReviewKind.CONFLICT, ImportReviewKind.ALIGN_MFC]);
    expect(decoded.applied[0]?.answers).toEqual([ImportAnswer.UNDO, ImportAnswer.DISMISS]);
  });
});
