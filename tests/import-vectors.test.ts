import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_DEVICE_ID, parseVersion } from '../src/index.js';
import { CrossingClient, type Facet, type Value } from './support/crossing-model.js';
import { reimport, type Copy, type Figures, type ReimportCase } from './support/reimport-model.js';

type Expect = { shows: Value; crossing: { mfc: Value } | null; outbox?: Value[] };
type Step = { expect?: Expect } & (
  | { take: Facet }
  | { edit: Facet }
  | { push: true }
  | { answer: { outcome: 'APPLIED' | 'STALE'; current: Facet } }
  | { resolve: { choice: 'keep' | 'take'; version: string } }
);
interface Vectors {
  devices: { self: string; import: string; other: string };
  crossings: { name: string; key?: string; steps: Step[] }[];
  reimports: (ReimportCase & {
    expect: {
      copies: Copy[];
      figures?: Figures;
      writes: string[];
      conflicts: string[];
      unresolved: { line: number; reason: string }[];
    };
  })[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/import-vectors.json', import.meta.url)), 'utf8'),
) as Vectors;

describe('golden import vectors: an import write crossing a client edit (sync.proto rule 6, IMPORT CROSSINGS)', () => {
  it('spell every version in the rule-5 grammar, the import under the reserved device', () => {
    expect(vectors.devices.import).toBe(SERVER_DEVICE_ID);
    const versions = JSON.stringify(vectors.crossings).match(/"version":"[^"]+"/g) ?? [];
    expect(versions.length).toBeGreaterThan(30);
    for (const v of versions) {
      const parsed = parseVersion(v.slice(11, -1));
      expect(parsed, v).toBeDefined();
      expect(Object.values(vectors.devices)).toContain(parsed!.deviceId);
    }
  });

  it('cover the losing, the landed, the held, the agreeing, the replayed, the other-device and the closed-window edit', () => {
    expect(vectors.crossings.length).toBeGreaterThanOrEqual(10);
    const outcomes = vectors.crossings.flatMap((c) => c.steps.flatMap((s) => ('answer' in s ? [s.answer.outcome] : [])));
    expect(new Set(outcomes)).toEqual(new Set(['APPLIED', 'STALE']));
    const choices = vectors.crossings.flatMap((c) => c.steps.flatMap((s) => ('resolve' in s ? [s.resolve.choice] : [])));
    expect(new Set(choices)).toEqual(new Set(['keep', 'take']));
  });

  it.each(vectors.crossings.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const client = new CrossingClient(vectors.devices.self);
    c.steps.forEach((step, i) => {
      if ('take' in step) client.take(step.take);
      else if ('edit' in step) client.edit(step.edit.value, step.edit.version);
      else if ('push' in step) client.push();
      else if ('answer' in step) client.answer(step.answer.outcome, step.answer.current);
      else client.resolve(step.resolve.choice, step.resolve.version);
      if (step.expect === undefined) return;
      const at = `step ${i + 1}`;
      expect(client.local?.value, at).toEqual(step.expect.shows);
      expect(client.crossing === null ? null : { mfc: client.crossing.mfc.value }, at).toEqual(step.expect.crossing);
      if (step.expect.outbox !== undefined) expect(client.outbox, at).toEqual(step.expect.outbox);
    });
  });
});

describe('golden import vectors: the re-import (import.proto)', () => {
  it('cover the three-way, ER merges, counts both ways, kinds, filing, absent rows, Count 0 and every unresolved reason', () => {
    const names = vectors.reimports.map((c) => c.name).join('\n');
    for (const topic of [/spine merge/, /GR-Q3/, /lowered the Count/, /raised the Count/, /adopted/, /conflict per copy/, /filing/, /gone from the export/, /Count 0/, /numerically lowest/]) {
      expect(names).toMatch(topic);
    }
    const reasons = new Set(vectors.reimports.flatMap((c) => c.expect.unresolved.map((u) => u.reason)));
    expect(reasons).toEqual(new Set(['no_product', 'count_over_99', 'invalid_count', 'invalid_id', 'duplicate_id']));
  });

  it.each(vectors.reimports.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = reimport(c);
    expect(result.copies).toEqual(Object.fromEntries(c.expect.copies.map((x) => [x.occ, x])));
    if (c.expect.figures !== undefined) expect(result.figures).toEqual(c.expect.figures);
    expect(result.writes).toEqual(c.expect.writes);
    expect(result.conflicts).toEqual(c.expect.conflicts);
    expect(result.unresolved).toEqual(c.expect.unresolved);
  });

  it('keeps GR-Q3\'s remaining owned copy whichever copy was sold', () => {
    const grq3 = vectors.reimports.find((c) => /GR-Q3/.test(c.name))!;
    const swapped: ReimportCase = {
      ...grq3,
      copies: grq3.copies.map((x) => ({ ...x, status: x.status === 'former' ? 'owned' : 'former' })),
    };
    for (const k of [grq3, swapped]) {
      const after = reimport(k);
      expect(Object.values(after.copies).filter((x) => x.status === 'owned')).toHaveLength(1);
      expect(Object.values(after.copies).filter((x) => x.status === 'former')).toHaveLength(1);
      expect(after.writes).toEqual([]);
      expect(after.conflicts).toEqual([]);
    }
  });

  it('writes nothing when the same export is imported again', () => {
    for (const c of vectors.reimports) {
      const once = reimport(c);
      const again = reimport({
        ...c,
        copies: Object.values(once.copies),
        figures: Object.fromEntries(
          Object.entries(once.figures).map(([h, cells]) => [
            h,
            Object.fromEntries(Object.entries(cells).map(([f, cell]) => [f, { ...cell, v: cell.v === 100 ? 99 : cell.v, baseV: cell.baseV === 100 ? 99 : cell.baseV }])),
          ]),
        ),
      });
      expect(again.writes, c.name).toEqual([]);
    }
  });
});
