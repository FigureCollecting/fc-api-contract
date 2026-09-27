// Each mutant removes one rule from the server model (or the client); the goldens or the property worlds must then
// fail, and the unmutated model must pass them all. Two mutants are equivalent (shown below): M8, since import.proto 4.4
// (c2) already keeps every copy the app changed out of MATERIALIZE; and recheckLate, since a late edit is replayed just
// before an import that decides its figure again, and ending a conflict writes nothing.
import { describe, expect, it } from 'vitest';
import { stable, type Switches } from './support/server-model.js';
import { runScenario } from './support/trace-runner.js';
import { vectors } from './support/vectors.js';
import { itemReactionWorld, reactionWorld, twoDevices, world } from './support/worlds.js';

type Client = { staging?: boolean; pullAfterImport?: boolean; resumeFromNext?: boolean };
const eq = (a: unknown, b: unknown) => stable(a) === stable(b);
function scenarioFailures(sw: Switches, client: Client = {}): string[] {
  return vectors.serverScenarios.filter((c) => {
    const r = runScenario(c, sw, client);
    return !eq(r.actual, r.wanted) || !eq(r.end, c.expect);
  }).map((c) => c.id);
}
function reviewFailures(sw: Switches, client: Client = {}): string[] {
  return vectors.review.filter((c) => {
    const r = runScenario(c, sw, client);
    return !eq(r.actual, r.wanted) || !eq(r.review, c.expect);
  }).map((c) => c.name.split(':')[0]!);
}
const worldBreaches = (sw: Switches, staging = true) => {
  const t = world(1, { sw, staging });
  return t.silentCounts + t.silentItem + t.differsShown;
};
const reactionBreaches = (sw: Switches) => {
  const t = reactionWorld({ sw });
  return t.silent + t.noReactionDiffers;
};
const itemBreaches = (sw: Switches) => {
  const t = itemReactionWorld({ sw });
  return t.silent + t.silentItem + (t.collisions - 9);
};

type Detector = 'scenarios' | 'review' | 'world' | 'twoDevices' | 'items';
const MUTANTS: { name: string; sw?: Switches; client?: Client; detector: Detector; mustInclude?: string }[] = [
  { name: 'F1: no marker frame (a figure the import decided without writing gets no frame)', sw: { noMarker: true }, detector: 'world' },
  { name: 'F2: no client staging (a page ending inside an import is shown half applied)', client: { staging: false }, detector: 'scenarios', mustInclude: 'J-A1-staged (removal)' },
  { name: 'F2 across a restart: the client resumes from the parked next_cursor and loses what it had staged', client: { resumeFromNext: true }, detector: 'scenarios', mustInclude: 'J-A1-staged (restart)' },
  { name: 'R7: the requester reacts to the review set without pulling the import\'s transaction (its reaction is replayed as a late edit)', client: { pullAfterImport: false }, detector: 'review', mustInclude: 'The requester reacts right after its import' },
  { name: 'HELD not sticky: the relevance replay resets every other edit\'s hold (round 5)', sw: { heldNotSticky: true }, detector: 'scenarios', mustInclude: 'X-07 (a second late push)' },
  { name: 'HELD per edit, not per unit: a copy\'s head, status and disposal of one push decided apart', sw: { heldPerEdit: true }, detector: 'scenarios', mustInclude: 'X-07 (sale and disposal)' },
  { name: 'F3 (i) broad: any knowing edit to a copy of the figure is a reaction', sw: { broadReaction: true }, detector: 'scenarios', mustInclude: 'X-07 (a harmless reaction)' },
  { name: 'HELD (iii) counts only answers to a figure item', sw: { answerHoldFigureOnly: true }, detector: 'review', mustInclude: 'HELD (iii) counts every answer on the figure' },
  { name: 'HELD (iii) without its relevance test (a harmless late tag after an answer is held)', sw: { answerHoldWithoutRelevance: true }, detector: 'scenarios', mustInclude: 'X-10 (after an answer, harmless)' },
  { name: 'a held-edit card lists every held edit, past the schema\'s 16', sw: { heldNoOverflow: true }, detector: 'review', mustInclude: 'A held-edit card lists whole units, oldest first, at most 16 edits' },
  { name: 'an answer routed by its rev alone, whatever item it names', sw: { ignoreItem: true }, detector: 'review', mustInclude: 'An answer names its item' },
  { name: 'a spine merge leaves the merged heads\' items in place', sw: { mergeKeepsItems: true }, detector: 'review', mustInclude: 'A spine merge ends the items of both heads; the next import raises one divergence for the merged figure, once, and keep yields one align-MFC entry that keeps the row whose copy is still owned and adds both sold rows to the list; following it by hand clears it and keeps that copy' },
  { name: 'an align-MFC entry built from the acknowledged snapshot, not the app\'s current side', sw: { alignFromAck: true }, detector: 'review', mustInclude: 'An align-MFC entry follows the app\'s current side' },
  { name: 'an acknowledgement compared whole, not per part (a partial catch-up re-opens it)', sw: { wholeAck: true }, detector: 'review', mustInclude: 'An acknowledgement is kept per part' },
  { name: 'add_to_list for any sold copy, not only one of a row the entry lowers', sw: { listAnySale: true }, detector: 'review', mustInclude: 'add_to_list only for a row the entry lowers' },
  { name: 'the align plan gives up Counts by row number alone, ignoring copy origins', sw: { alignIgnoresOrigin: true }, detector: 'review' },
  { name: 'X5: an applied decision leaves a stale conflict item', sw: { keepStaleItem: true }, detector: 'review', mustInclude: 'A pending conflict ends when a later import finds the two sides agreeing' },
  { name: 'X6: an absent row counts its base Count on MFC\'s side', sw: { absentRowCountsBase: true }, detector: 'review', mustInclude: 'A row gone from the export states Count 0 on MFC\'s side' },
  { name: 'X9: undo restores even when a written value has moved on', sw: { undoIgnoresLaterEdits: true }, detector: 'review', mustInclude: 'undo restores a write only while it still holds the value the import wrote' },
  { name: 'F3: no hold on reaction', sw: { noHold: true }, detector: 'scenarios', mustInclude: 'X-07' },
  { name: 'F3 (i) without its "would change the import\'s result" test', sw: { holdWithoutRelevance: true }, detector: 'scenarios', mustInclude: 'J-F3-false-hold' },
  { name: 'F3 (i) without its "arrived before the late edit" test', sw: { holdWithoutArrivedBefore: true }, detector: 'scenarios', mustInclude: 'J-X07-order2' },
  { name: '5.4 holds any edit whose basis precedes an answer, not only late ones (A-6)', sw: { broadHold: true }, detector: 'scenarios', mustInclude: 'J-A (A3)' },
  { name: '4.5 picks the new copy\'s row by base count, not by live copies', sw: { baseCountRow: true }, detector: 'scenarios', mustInclude: 'J-4.5-row' },
  { name: 'M1: every edit at its arrival (no late placement)', sw: { M1: true }, detector: 'scenarios', mustInclude: 'R2-01 (variant 1 of 2)' },
  { name: 'M2: late by the edit\'s version, not its basis', sw: { M2: true }, detector: 'scenarios', mustInclude: 'R1-02' },
  { name: 'M3: no transition matching', sw: { M3: true }, detector: 'scenarios', mustInclude: 'R4-05 (variant 1 of 2)' },
  { name: 'M4: take also moves app-only copies', sw: { M4: true }, detector: 'scenarios', mustInclude: 'R4-06' },
  { name: 'M5: heads compared as strings (no redirect chain)', sw: { M5: true }, detector: 'scenarios', mustInclude: 'R1-03' },
  { name: 'M6: a field change judged at figure grain', sw: { M6: true }, detector: 'scenarios', mustInclude: 'R3-05 (variant 1 of 2)' },
  { name: 'M7: a knowing edit never closes a card', sw: { M7: true }, detector: 'scenarios', mustInclude: 'X-01' },
  { name: 'M9: an answer accepted whatever revision it names', sw: { M9: true }, detector: 'scenarios', mustInclude: 'R3-11' },
  { name: 'R2: no MFC projection (a wished copy beside owned ones raises a divergence)', sw: { projectAllKinds: true }, detector: 'review', mustInclude: 'Scenario 1' },
  { name: 'R4: an acknowledgement not kept (MFC is behind is asked again)', sw: { noAck: true }, detector: 'review', mustInclude: 'Scenario 3' },
  { name: 'R5: a FAVOR preference applied to MFC-only changes too', sw: { favorAll: true }, detector: 'review', mustInclude: 'Scenario 4, FAVOR_APP is applied only to true conflicts' },
  { name: 'R8: a dismissed align-MFC entry shown again', sw: { forgetDismiss: true }, detector: 'review' },
  { name: 'R8: a divergence raised for a figure with no MFC id', sw: { divergeWithoutId: true }, detector: 'review', mustInclude: 'Align-MFC is derived only where the MFC id is known' },
  // round 7
  { name: 'HELD (ii) as in round 6: every push is a revision, an answer included', sw: { revisionsFromAnswers: true }, detector: 'review', mustInclude: 'An answer is no revision' },
  { name: 'HELD (ii) as in round 6: a replay\'s change to the items is no revision', sw: { revisionIgnoresItems: true }, detector: 'review', mustInclude: 'A by-hand reaction to a listed change, the late sale first' },
  { name: 'HELD (ii) as in round 6: any knowing edit made before a revision is held, a tag on an untouched copy included', sw: { revisedHoldsAnyEdit: true }, detector: 'review', mustInclude: 'HELD (ii) holds only a reaction to the revision' },
  { name: 'HELD (i) and (ii) as in round 6: a status write made while the figure had an item the two sides leave different is no reaction', sw: { narrowReaction: true }, detector: 'items' },
  { name: 'the same, caught by its golden', sw: { narrowReaction: true }, detector: 'review', mustInclude: 'A by-hand reaction to a conflict' },
  { name: 'closing a conflict on a knowing edit writes the decision (round 6)', sw: { closeWrites: true }, detector: 'review', mustInclude: 'A knowing edit that leaves MFC a change to make writes nothing' },
  { name: 'a knowing edit ends a conflict that still leaves MFC a change to make', sw: { closeWhenNoConflict: true }, detector: 'review', mustInclude: 'A knowing edit that leaves MFC a change to make leaves the conflict standing and writes nothing' },
  { name: 'a knowing edit ends a conflict once MFC\'s changes are in the app, the app\'s own changes aside (sides not yet agreeing)', sw: { closeWhenMfcInApp: true }, detector: 'review', mustInclude: 'A by-hand reaction to a conflict' },
  { name: 'items compared by their whole payload, so a replay that only re-shows the app\'s side in an item is a revision (round 6\'s relevance view)', sw: { itemsByPayload: true }, detector: 'review', mustInclude: 'A replay that only re-shows the app\'s side in an item is no revision' },
  { name: 'the relevance test compares raw status and head facets, so a removed copy\'s head counts (round 6)', sw: { relevanceRawFacets: true }, detector: 'review', mustInclude: 'The relevance test compares live copies' },
  { name: 'the relevance test leaves the unit\'s own copies out (round 6)', sw: { relevanceExcludesOwn: true }, detector: 'review', mustInclude: 'The relevance test counts the unit\'s own copy' },
  { name: 'HELD (iii) compares the basis with the answer\'s commit inclusively', sw: { answerBoundaryInclusive: true }, detector: 'review', mustInclude: 'HELD (iii) counts an answer only when the edit was made before its commit' },
  { name: 'a held-edit card\'s keep applies the edits by LWW at their own versions', sw: { keepAtOwnVersion: true }, detector: 'review', mustInclude: 'A held-edit card\'s keep writes the held edit as the answer\'s write' },
  { name: 'a held-edit card leaves out `more`', sw: { heldNoMore: true }, detector: 'review', mustInclude: 'A held-edit card counts what it does not list' },
  { name: 'a divergence\'s rev is its content alone, so one raised again keeps its old rev (round 6)', sw: { divRevContentOnly: true }, detector: 'review', mustInclude: 'A divergence raised again after a conflict replaced it has a new rev' },
  { name: 'a divergence an import keeps still shows the rows of the import that raised it (round 6)', sw: { divergenceKeepsOldRows: true }, detector: 'review', mustInclude: 'An MFC-only change over a figure the app is ahead on is applied and listed with its undo, and the score the app is ahead on stays one divergence; keep acknowledges it and the align-MFC entry asks for the score alone' },
];

describe('mutants: every rule is load-bearing', () => {
  it('the unmutated model passes every detector', () => {
    expect(scenarioFailures({})).toEqual([]);
    expect(reviewFailures({})).toEqual([]);
    expect(worldBreaches({})).toBe(0);
    expect(reactionBreaches({})).toBe(0);
    expect(itemBreaches({})).toBe(0);
    const t = twoDevices();
    expect(t.silentCounts + t.differsShown).toBe(0);
  }, 300_000);

  it.each(MUTANTS.map((m) => [m.name, m] as const))('%s is caught', (_name, m) => {
    const sw = m.sw ?? {};
    if (m.detector === 'world') expect(worldBreaches(sw, m.client?.staging ?? true)).toBeGreaterThan(0);
    else if (m.detector === 'items') expect(itemBreaches(sw)).toBeGreaterThan(0);
    else if (m.detector === 'twoDevices') {
      const t = twoDevices({ sw });
      expect(t.silentCounts + t.differsShown).toBeGreaterThan(0);
    } else {
      const failed = m.detector === 'scenarios' ? scenarioFailures(sw, m.client) : reviewFailures(sw, m.client);
      expect(failed.length).toBeGreaterThan(0);
      if (m.mustInclude !== undefined) expect(failed).toContain(m.mustInclude);
    }
  }, 120_000);

  it('running the conflict-close check for late edits too is equivalent: a late edit is replayed just before an import that decides the figure again, and closing writes nothing', () => {
    expect(scenarioFailures({ recheckLate: true })).toEqual([]);
    expect(reviewFailures({ recheckLate: true })).toEqual([]);
    expect(worldBreaches({ recheckLate: true })).toBe(0);
    expect(itemBreaches({ recheckLate: true })).toBe(0);
  }, 300_000);

  it('M8 (materialize may pick a copy the app changed) is equivalent: no golden and no world case changes', () => {
    expect(scenarioFailures({ M8: true })).toEqual([]);
    expect(reviewFailures({ M8: true })).toEqual([]);
    expect(worldBreaches({ M8: true })).toBe(0);
    expect(reactionBreaches({ M8: true })).toBe(0);
  }, 120_000);
});
