import { describe, expect, it } from 'vitest';
import { create, equals, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import {
  ImportMfcExportRequestSchema,
  ImportMfcExportResponseSchema,
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
      keptNewer: 3,
      removed: 2,
      facetsWritten: 1310,
    });
    const decoded = fromJson(ImportMfcExportResponseSchema, toJson(ImportMfcExportResponseSchema, msg));

    expect(equals(ImportMfcExportResponseSchema, msg, decoded)).toBe(true);
    expect(decoded.keptNewer).toBe(3);
    expect(decoded.unresolved[0]).toMatchObject({ mfcId: '3743689', status: 'Wished', line: 812, reason: 'no_product' });
    expect(decoded.unresolved[1]?.reason).toBe('count_over_99');
  });

  it('round-trips the 0.3.0 per-occurrence and conflict counters on their additive field numbers', () => {
    const counters = {
      occurrencesAdded: 1148,
      occurrencesStatusChanged: 3,
      occurrencesRemoved: 1,
      conflictsRaised: 2,
      conflictsPending: 5,
      keptApp: 7,
    };
    const msg = create(ImportMfcExportResponseSchema, counters);
    const decoded = fromBinary(ImportMfcExportResponseSchema, toBinary(ImportMfcExportResponseSchema, msg));
    expect(decoded).toMatchObject(counters);
    const numbers = Object.fromEntries(ImportMfcExportResponseSchema.fields.map((f) => [f.name, f.number]));
    expect(numbers).toMatchObject({
      occurrences_added: 9,
      occurrences_status_changed: 10,
      occurrences_removed: 11,
      conflicts_raised: 12,
      conflicts_pending: 13,
      kept_app: 14,
    });
    expect(Object.fromEntries(UnresolvedMfcRowSchema.fields.map((f) => [f.name, f.number]))).toMatchObject({ reason: 4 });
  });
});
