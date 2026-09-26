import { describe, expect, it } from 'vitest';
import { create, equals, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import {
  ImportMfcExportRequestSchema,
  ImportMfcExportResponseSchema,
  ImportService,
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
      unresolved: [{ mfcId: '3743689', status: 'Wished', line: 812 }],
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
    expect(decoded.unresolved[0]).toMatchObject({ mfcId: '3743689', status: 'Wished', line: 812 });
  });
});
