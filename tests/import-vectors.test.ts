import { describe, expect, it } from 'vitest';
import { reimport, type ReimportCase } from './support/reimport-model.js';
import { runScenario, type Step } from './support/trace-runner.js';
import { vectors } from './support/vectors.js';

// The 58-case corpus of rounds 1 to 4. These nine are outside the import rules (key-grammar vectors, the
// schema guard, ROWS as at head, the disposal register) and have no server scenario.
const STATIC = ['R1-07', 'R1-09', 'R1-10', 'R1-11', 'R1-12', 'R2-07', 'R2-11', 'R3-06', 'R4-13'];
const CORPUS = [
  ...['01', '02', '03', '04', '05', '06', '08', 'B1'].map((n) => `R1-${n}`),
  ...['01', '02', '03', '04', '05', '06', '08', '09', '10', 'B1', 'B2', 'B3'].map((n) => `R2-${n}`),
  ...['01', '02', '03', '04', '05', '07', '08', '09', '10', '11', '12', '13', 'B1', 'B2'].map((n) => `R3-${n}`),
  ...['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', 'B1', 'B2', 'B3'].map((n) => `R4-${n}`),
];
const base = (id: string) => id.split(' (')[0]!;

describe('golden import vectors: server scenarios (import.proto THE SERVER DECIDES)', () => {
  it('cover all 49 import scenarios of the 58-case corpus, the probes X-01..X-07 and the judge\'s probes', () => {
    expect(CORPUS.length + STATIC.length).toBe(58);
    const ids = new Set(vectors.serverScenarios.map((c) => base(c.id)));
    for (const id of [...CORPUS, 'X-01', 'X-02', 'X-03', 'X-04', 'X-05', 'X-06', 'X-07', 'J-A', 'J-X07-order2', 'J-F3-false-hold', 'J-A1-staged', 'J-4.5-row'])
      expect(ids, id).toContain(id);
    for (const id of STATIC) expect(ids).not.toContain(id);
    const judge = vectors.serverScenarios.filter((c) => c.id.startsWith('J-A (')).map((c) => c.id);
    expect(judge).toEqual(['J-A (A1 split page)', 'J-A (A1 whole page)', 'J-A (A1b split page)', 'J-A (A1b whole page)', 'J-A (A2 sale)', 'J-A (A2 filing)', 'J-A (A3)', 'J-A (A4)', 'J-A (A5)']);
  });

  it('pin a held edit, never a silent loss, in X-07 and its reverse order, A2 and A5', () => {
    const held = (id: string) => vectors.serverScenarios.find((c) => c.id === id)!.expect.held;
    expect(held('X-07')).toEqual([['P', 'occ/o1/status']]);
    expect(held('J-A (A5)')).toEqual([['P', 'occ/o1/status']]);
    expect(held('J-X07-order2')).toEqual([['T', 'occ/a3/head'], ['T', 'occ/a3/status']]);
    expect(held('J-A (A2 sale)')).toEqual([['P', 'occ/a1/status']]);
    expect(held('J-A (A2 filing)')).toEqual([['P', 'occ/a1/status']]);
    expect(held('J-F3-false-hold')).toEqual([]);
  });

  it.each(vectors.serverScenarios.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const r = runScenario(c);
    expect(r.actual, 'push outcomes and what a device shows after a page').toEqual(r.wanted);
    expect(r.end).toEqual(c.expect);
  });
});

describe('golden import vectors: the re-import onto a seeded server (import.proto 4)', () => {
  it('cover the three-way at figure grain, ER merges, counts both ways, kinds, filing, absent rows, Count 0 and every unresolved reason', () => {
    const names = vectors.reimports.map((c) => c.name).join('\n');
    for (const topic of [/spine merge/, /GR-Q3/, /lowered the Count/, /raised the Count/, /one card for the figure/, /filing/, /gone from the export/, /Count 0/, /a field base per row/, /more recent base stands/, /two MFC rows for one figure: the app sold row 900's copy/, /transition matching/, /no adoption write/]) {
      expect(names).toMatch(topic);
    }
    const reasons = new Set(vectors.reimports.flatMap((c) => c.expect.unresolved.map((u) => u.reason)));
    expect(reasons).toEqual(new Set(['no_product', 'count_over_99', 'invalid_count', 'invalid_id', 'duplicate_id']));
    expect(vectors.reimports.filter((c) => /\(Design A/.test(c.name))).toHaveLength(8);
  });

  it.each(vectors.reimports.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = reimport(c);
    expect(result.copies).toEqual(c.expect.copies);
    expect(result.figures).toEqual(c.expect.figures);
    expect(result.writes).toEqual(c.expect.writes);
    expect(result.conflicts).toEqual(c.expect.conflicts);
    expect(result.unresolved).toEqual(c.expect.unresolved);
  });

  it("keeps GR-Q3's remaining owned copy whichever copy was sold", () => {
    const grq3 = vectors.reimports.find((c) => /GR-Q3/.test(c.name))!;
    const swapped: ReimportCase = { ...grq3, copies: grq3.copies.map((x) => ({ ...x, status: x.status === 'former' ? 'owned' : 'former' })) };
    for (const k of [grq3, swapped]) {
      const after = reimport(k);
      expect(after.copies.filter((x) => x.status === 'owned')).toHaveLength(1);
      expect(after.copies.filter((x) => x.status === 'former')).toHaveLength(1);
      expect(after.writes).toEqual([]);
      expect(after.conflicts).toEqual([]);
    }
  });

  it('gives one result whatever order the copies and heads are listed in', () => {
    for (const c of vectors.reimports) {
      const flipped: ReimportCase = { ...c, copies: [...c.copies].reverse(), figures: Object.fromEntries(Object.entries(c.figures ?? {}).reverse()) };
      expect(reimport(flipped), c.name).toEqual(reimport(c));
    }
  });
});

describe("golden import vectors: Ross's rules R1-R8 (review right after the import)", () => {
  it('cover scenarios 1 to 5 with identical re-imports after each, and every rule', () => {
    const names = vectors.review.map((c) => c.name);
    for (const n of [1, 2, 3, 4, 5]) {
      const cases = vectors.review.filter((c) => c.name.startsWith(`Scenario ${n}`));
      expect(cases.length, `scenario ${n}`).toBeGreaterThan(0);
      for (const c of cases) {
        const imports = c.steps.filter((s): s is Extract<Step, { op: 'import' }> => s.op === 'import');
        const last = imports.at(-1)!;
        const before = imports.at(-2)!;
        expect(JSON.stringify(last.rows), `${c.name}: ends with an identical re-import`).toBe(JSON.stringify(before.rows));
      }
    }
    const rules = new Set(vectors.review.flatMap((c) => c.rule.split(' ')));
    for (const r of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']) expect(rules, r).toContain(r);
    expect(names.join('\n')).toMatch(/stays dismissed across identical re-imports/);
    expect(names.join('\n')).toMatch(/only where the MFC id is known/);
    expect(names.join('\n')).toMatch(/clears itself when MFC catches up/);
  });

  it('pin the review set\'s order and every item kind with the answers it allows', () => {
    const groups = vectors.review.flatMap((c) => c.steps.flatMap((s) => (s.op === 'import' ? (s.expect?.review ?? []) : []))) as { kind: string }[];
    expect(new Set(groups.map((g) => g.kind))).toEqual(new Set(['conflict', 'mfc_change', 'divergence', 'held_edits', 'align_mfc']));
    const order = ['conflict', 'mfc_change', 'divergence', 'held_edits', 'align_mfc'];
    for (const c of vectors.review)
      for (const s of c.steps) if (s.op === 'import') {
        const kinds = (s.expect?.review as { kind: string }[]).map((g) => order.indexOf(g.kind));
        expect(kinds, c.name).toEqual([...kinds].sort((a, b) => a - b));
      }
  });

  it.each(vectors.review.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = runScenario(c);
    expect(r.actual, 'each import\'s result and each push\'s outcomes').toEqual(r.wanted);
    expect(r.review).toEqual(c.expect);
  });
});
