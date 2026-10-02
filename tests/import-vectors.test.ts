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
  it('cover all 49 import scenarios of the 58-case corpus, the probes X-01..X-11 and the judge\'s probes', () => {
    expect(CORPUS.length + STATIC.length).toBe(58);
    const ids = new Set(vectors.serverScenarios.map((c) => base(c.id)));
    for (const id of [...CORPUS, 'X-01', 'X-02', 'X-03', 'X-04', 'X-05', 'X-06', 'X-07', 'X-08', 'X-09', 'X-10', 'X-11', 'J-A', 'J-X07-order2', 'J-F3-false-hold', 'J-A1-staged', 'J-4.5-row'])
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
    expect(held('J-F3-false-hold')).toEqual([]);
  });

  it('pin HELD per unit and sticky: a copy\'s head, status, filing and disposal of one push held together, and never undone by a later push or import', () => {
    const held = (id: string) => vectors.serverScenarios.find((c) => c.id === id)!.expect.held;
    // one unit: never a half-held new copy (A2) or a sale applied without its disposal
    expect(held('J-A (A2 sale)')).toEqual([['P', 'occ/a1/head'], ['P', 'occ/a1/status']]);
    expect(held('J-A (A2 filing)')).toEqual([['P', 'occ/a1/head'], ['P', 'occ/a1/status']]);
    expect(held('X-07 (sale and disposal)')).toEqual([['P', 'occ/o1/disposal'], ['P', 'occ/o1/status']]);
    expect(held('X-09 (a reaction on the copy the import created)')).toEqual([['P', 'occ/a1/collection'], ['P', 'occ/a1/head'], ['P', 'occ/a1/status']]);
    // sticky: through another late push, a later late edit and a later import
    expect(held('X-07 (a second late push)')).toEqual([['P', 'occ/o1/status']]);
    expect(held('J-X07-order2 (a later late edit)')).toEqual([['T', 'occ/a3/head'], ['T', 'occ/a3/status']]);
    expect(held('J-A (A4)')).toEqual([['P', 'occ/a1/head'], ['P', 'occ/a1/status']]);
    // only a reaction, and (iii) only when the replay would change the answer
    expect(held('X-07 (a harmless reaction)')).toEqual([]);
    expect(held('X-10 (after an answer, harmless)')).toEqual([]);
    expect(held('X-10 (after an answer, relevant)')).toEqual([['P', 'occ/o1/status']]);
    expect(held('X-08 (two late units)')).toEqual([['P', 'occ/o1/status']]);
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
    for (const r of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'F3']) expect(rules, r).toContain(r);
    expect(names.join('\n')).toMatch(/stays dismissed across identical re-imports/);
    expect(names.join('\n')).toMatch(/only where the MFC id is known/);
    expect(names.join('\n')).toMatch(/clears itself when MFC catches up/);
    for (const topic of [/reacts right after its import/, /A spine merge ends the items of both heads/, /counts every answer on the figure/, /An answer names its item/,
      /at most 16 edits/, /follows the app's current side/, /add_to_list only for a row the entry lowers/,
      /kept per part/, /Richness on a merged figure/, /MFC takes the app's score/, /MFC back at the base/, /undo restores a write only while/, /can be dismissed/,
      /A row gone from the export/, /per_copy with a field side/, /a kind no row holds/, /Merged rows that change a field/,
      // round 7
      /An answer is no revision/, /makes a conflict's sides agree ends it and writes nothing/, /leaves the conflict standing and writes nothing/,
      /the phone drops the copy it added/, /only when the edit was made before its commit/, /keep writes the held edit as the answer's write/,
      /compares live copies/, /A by-hand reaction to a listed change: /, /A by-hand reaction to a listed change, the late sale first/,
      /A by-hand reaction to a conflict: /, /A by-hand reaction to a conflict, the late sale first/, /holds only a reaction to the revision/,
      /A conflict raised again after it ended has a new rev/, /A divergence raised again after a conflict replaced it has a new rev/,
      /keeps its rev, whatever the app did meanwhile/, /counts what it does not list/, /An MFC-only change over a figure the app is ahead on/,
      /counts the unit's own copy/, /only re-shows the app's side in an item changes no item/,
      // round 8
      /A compound reaction in one push, dismiss and sale: /, /A compound reaction in one push, dismiss and re-add: /,
      /A compound reaction in two pushes, dismiss and re-own: /, /A compound reaction in two pushes, undo and sale: /,
      /A compound reaction on three devices: /, /A revision is what the replayed late edits alone change/, /Reaction clause \(b\) alone/,
      /A divergence whose values change between imports takes a new rev/, /A change entry raised again, identical, after it ended has a new rev/,
      /A push whose late edits are all held is no revision/, /An undo moves no base/, /A device that saw an item only after it ended did not react to it/,
      /Reaction clause \(c\), an item the two placements end differently/, /HELD \(ii\) applies a figure value made before a revision/,
      // round 8, recheck 2
      /Keep on a conflict follows its rev, in one push: /, /Keep on a conflict follows its rev, in two pushes: /, /Keep on a conflict, the control: /,
      /MFC lowered the count, ASK: /, /MFC lowered the count, FAVOR_APP: /, /MFC raised the count, ASK: /, /MFC raised the count, FAVOR_APP: /,
      /works against the export of the import that made it/, /A held-edit card's keep writes knowing edits/, /A held-edit card's rev is the edits it lists/,
      /A tag is one unit with the push's other edits of its key/, /A revision leaves out only the facets its late edits write/])
      expect(names.join('\n')).toMatch(topic);
    expect(names.join('\n')).not.toMatch(/mfc_only|mfc_change|HOLD/);
  });

  it('pin ImportMfcExportResponse\'s counters (fields 3 to 17, 15 reserved) on every import of the review cases', () => {
    const KEYS = ['added', 'moved', 'unchanged', 'removed', 'facets_written', 'kept_newer', 'occurrences_added', 'occurrences_status_changed', 'occurrences_removed',
      'conflicts_raised', 'conflicts_pending', 'divergences_pending', 'align_pending', 'import_number'];
    const imports = vectors.review.flatMap((c) => c.steps.filter((s): s is Extract<Step, { op: 'import' }> => s.op === 'import'));
    for (const s of imports) expect(Object.keys(s.expect?.counters ?? {}).sort()).toEqual([...KEYS].sort());
    // every counter is non-zero somewhere, so none is pinned only at 0
    for (const k of KEYS) expect(imports.some((s) => (s.expect!.counters as unknown as Record<string, number>)[k]! > 0), k).toBe(true);
  });

  it('pin the review set\'s order and every item kind with the answers it allows', () => {
    const groups = vectors.review.flatMap((c) => c.steps.flatMap((s) => (s.op === 'import' ? (s.expect?.review ?? []) : []))) as { kind: string }[];
    expect(new Set(groups.map((g) => g.kind))).toEqual(new Set(['conflict', 'divergence', 'held_edits', 'align_mfc']));
    const order = ['conflict', 'divergence', 'held_edits', 'align_mfc'];
    for (const c of vectors.review)
      for (const s of c.steps) if (s.op === 'import') {
        const kinds = (s.expect?.review as { kind: string }[]).map((g) => order.indexOf(g.kind));
        expect(kinds, c.name).toEqual([...kinds].sort((a, b) => a - b));
      }
  });

  it('pin each held-edit card by its payload: every listed edit\'s key, value and reason, and `more`', () => {
    const cards = vectors.review.flatMap((c) => Object.values(c.expect.held));
    expect(cards.some((c) => (c.more ?? 0) > 0)).toBe(true);
    const reasons = new Set(cards.flatMap((c) => c.held.map((h) => h.reason)));
    expect(reasons).toEqual(new Set(['late_after_knowing', 'made_on_revised_result', 'after_answer']));
    for (const c of cards) for (const h of c.held) expect(Object.keys(h).sort()).toEqual(['key', 'reason', 'value']);
  });

  it('pin HELD on a by-hand reaction to an item, in both arrival orders, and (ii) for reactions only (round 7)', () => {
    const push = (prefix: string, k: number) =>
      vectors.review.find((c) => c.name.startsWith(prefix))!.steps.filter((s) => s.op === 'push')[k]!.expect!.map((x) => x.outcome);
    // a listed change: the late sale is held when the re-own came first, the re-own is held when the late sale came first
    expect(push('A by-hand reaction to a listed change: ', 1)).toEqual(['HELD']);
    expect(push('A by-hand reaction to a listed change, the late sale first', 1)).toEqual(['HELD']);
    // a conflict settled by hand with another copy
    expect(push('A by-hand reaction to a conflict: ', 2)).toEqual(['HELD']);
    expect(push('A by-hand reaction to a conflict, the late sale first', 2)).toEqual(['HELD']);
    // (ii) holds only a reaction: a tag on a copy the revision left alone is applied, a new copy held; an answer is no revision
    expect(push('HELD (ii) holds only a reaction to the revision', 1)).toEqual(['APPLIED', 'HELD', 'HELD']);
    expect(push('An answer is no revision', 1)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
  });

  it('pin HELD on a compound reaction: an answer plus a by-hand edit on the same showing, in one push or two, or on a third device (round 8)', () => {
    const push = (prefix: string, k: number) =>
      vectors.review.find((c) => c.name.startsWith(prefix))!.steps.filter((s) => s.op === 'push')[k]!.expect!.map((x) => x.outcome);
    // (i): the answer ended the item, so both placements end alike; what the tablet saw holds the phone's late sale
    expect(push('A compound reaction in one push, dismiss and sale: ', 1)).toEqual(['HELD']);
    expect(push('A compound reaction in one push, dismiss and re-add: ', 1)).toEqual(['HELD']);
    // (ii): the phone's push is a revision point though it changes nothing against S just before it
    expect(push('A compound reaction in two pushes, dismiss and re-own: ', 2)).toEqual(['HELD']);
    expect(push('A compound reaction in two pushes, undo and sale: ', 2)).toEqual(['HELD']);
    expect(push('A compound reaction on three devices: ', 2)).toEqual(['HELD']);
    // a revision is the replayed late edits alone: an answer in the same push is no part of it
    expect(push('A revision is what the replayed late edits alone change', 1)).toEqual(['APPLIED']);
    // and a push whose late edits are all held is none
    expect(push('A push whose late edits are all held is no revision', 2)).toEqual(['APPLIED', 'APPLIED']);
    // reaction clause (b) alone holds, and a device that saw an item only after it ended did not react to it
    expect(push('Reaction clause (b) alone', 1)).toEqual(['HELD', 'HELD']);
    expect(push('A device that saw an item only after it ended did not react to it', 1)).toEqual(['APPLIED']);
  });

  it('pin keep to its rev and the undo of a favor_app settlement to the take its import would have written (round 8, recheck 2)', () => {
    const named = (prefix: string) => vectors.review.find((c) => c.name.startsWith(prefix))!;
    const push = (prefix: string, k: number) => named(prefix).steps.filter((s) => s.op === 'push')[k]!.expect!.map((x) => x.outcome);
    // keep after the tablet's sale brought the counts back to base: the disputed counts stay the app's, in one push or two
    expect(named('Keep on a conflict follows its rev, in one push: ').expect).toEqual(named('Keep on a conflict follows its rev, in two pushes: ').expect);
    expect(named('Keep on a conflict follows its rev, in one push: ').expect.facets['occ/o2/status']).toBe('owned');
    // the FAVOR_APP undo ends where the ASK take ends, MFC lowering the count or raising it, and the same export raises nothing
    expect(named('MFC lowered the count, FAVOR_APP: ').expect).toEqual(named('MFC lowered the count, ASK: ').expect);
    expect(named('MFC raised the count, FAVOR_APP: ').expect).toEqual(named('MFC raised the count, ASK: ').expect);
    for (const p of ['MFC lowered the count, FAVOR_APP: ', 'MFC raised the count, FAVOR_APP: ']) {
      const last = named(p).steps.filter((s): s is Extract<Step, { op: 'import' }> => s.op === 'import').at(-1)!;
      expect(last.expect!.review, p).toEqual([]);
    }
    // a held card's keep is knowing, its rev is the edits it lists, a tag is a unit per key, a revision's own writes per facet
    expect(named("A held-edit card's keep writes knowing edits").expect.figure).toEqual({});
    expect(push("A held-edit card's rev is the edits it lists", 4)).toEqual(['STALE']);
    expect(push("A tag is one unit with the push's other edits of its key", 1)).toEqual(['HELD', 'HELD']);
    expect(push('A revision leaves out only the facets its late edits write', 1)).toEqual(['HELD']);
  });

  it.each(vectors.review.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = runScenario(c);
    expect(r.actual, 'each import\'s result and each push\'s outcomes').toEqual(r.wanted);
    expect(r.review).toEqual(c.expect);
  });
});
