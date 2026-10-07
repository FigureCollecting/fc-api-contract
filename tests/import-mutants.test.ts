// Each mutant removes one rule from the server model (or the client); the goldens or the property worlds must then
// fail, and the unmutated model must pass them all. Three mutants are equivalent (shown below): M8, since import.proto 4.4
// (c2) already keeps every copy the app changed out of MATERIALIZE; recheckLate, since a late edit is replayed just
// before an import that decides its figure again, and ending a conflict writes nothing; and heldLateIsRevision, since a
// push whose late edits are all held changes nothing, and a revision that changes nothing holds only an edit whose
// device saw an item the revision withdrew.
import { describe, expect, it } from 'vitest';
import { stable, type Switches } from './support/server-model.js';
import { runScenario } from './support/trace-runner.js';
import { vectors } from './support/vectors.js';
import { compoundLateWorld, compoundReactionWorld, crossImportWorld, itemReactionWorld, lateUnitsWorld, reactionWorld, twoDevices, world } from './support/worlds.js';

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
  return t.silent + t.silentItem + t.collisions;
};
// every 13th case of world 7 (a stride that meets both device forms and every answer and hand)
const compoundBreaches = (sw: Switches) => {
  const t = compoundReactionWorld({ sw, every: 13 });
  return t.silent + t.silentItem;
};

// scripts 1 to 3,000 of the cross-import world (they hold both round-8b shapes: an item an earlier import raised, and an
// edit late for a later import)
const crossBreaches = (sw: Switches) => {
  const t = crossImportWorld({ sw, from: 1, to: 3_000 });
  return t.silent + t.silentItem;
};

// the cross-import world's scripts 1 to 20,000 whose last or middle import states Count 0, that import dropping the row
const crossDropBreaches = (sw: Switches) =>
  (['last', 'middle'] as const).reduce((n, drop) => {
    const t = crossImportWorld({ sw, from: 1, to: 20_000, drop });
    return n + t.silent + t.silentItem;
  }, 0);

// every 499th case of world 9 (two late units of one push meet reactions there, and every policy and order)
const lateBreaches = (sw: Switches) => lateUnitsWorld({ sw, every: 499 }).silent;

// every 101st case of world 10 (two offline devices, compound reactions on two more)
const w10Breaches = (sw: Switches) => {
  const t = compoundLateWorld({ sw, from: 1, to: 300_000, every: 101 });
  return t.silent + t.silentItem;
};

type Detector = 'scenarios' | 'review' | 'world' | 'twoDevices' | 'items' | 'compound' | 'cross' | 'crossDrop' | 'late' | 'w10';
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
  { name: 'HELD (ii) as in round 6: items play no part in it (a replay\'s change to the items is no revision)', sw: { revisionIgnoresItems: true }, detector: 'review', mustInclude: 'A by-hand reaction to a listed change, the late sale first' },
  { name: 'HELD (ii) as in round 6: any knowing edit made before a revision is held, a tag on an untouched copy included', sw: { revisedHoldsAnyEdit: true }, detector: 'review', mustInclude: 'HELD (ii) holds only a reaction to the revision' },
  { name: 'the same, for a figure value', sw: { revisedHoldsAnyEdit: true }, detector: 'review', mustInclude: 'HELD (ii) applies a figure value made before a revision' },
  { name: 'HELD (i) and (ii) as in round 6: no item clause, so a status write made while the figure had an item is no reaction', sw: { narrowReaction: true }, detector: 'items' },
  { name: 'the same, caught by its golden', sw: { narrowReaction: true }, detector: 'review', mustInclude: 'A by-hand reaction to a conflict' },
  { name: 'closing a conflict on a knowing edit writes the decision (round 6)', sw: { closeWrites: true }, detector: 'review', mustInclude: 'A knowing edit that leaves MFC a change to make writes nothing' },
  { name: 'a knowing edit ends a conflict that still leaves MFC a change to make', sw: { closeWhenNoConflict: true }, detector: 'review', mustInclude: 'A knowing edit that leaves MFC a change to make leaves the conflict standing and writes nothing' },
  { name: 'a knowing edit ends a conflict once MFC\'s changes are in the app, the app\'s own changes aside (sides not yet agreeing)', sw: { closeWhenMfcInApp: true }, detector: 'review', mustInclude: 'A by-hand reaction to a conflict' },
  { name: 'items compared by their whole payload, so a replay that only re-shows the app\'s side in an item is a revision (round 6\'s relevance view)', sw: { itemsByPayload: true }, detector: 'review', mustInclude: 'A replay that only re-shows the app\'s side in an item changes no item' },
  { name: 'the relevance test compares raw status and head facets, so a removed copy\'s head counts (round 6)', sw: { relevanceRawFacets: true }, detector: 'review', mustInclude: 'The relevance test compares live copies' },
  { name: 'the relevance test leaves the unit\'s own copies out (round 6)', sw: { relevanceExcludesOwn: true }, detector: 'review', mustInclude: 'The relevance test counts the unit\'s own copy' },
  { name: 'HELD (iii) compares the basis with the answer\'s commit inclusively', sw: { answerBoundaryInclusive: true }, detector: 'review', mustInclude: 'HELD (iii) counts an answer only when the edit was made before its commit' },
  { name: 'a held-edit card\'s keep applies the edits by LWW at their own versions', sw: { keepAtOwnVersion: true }, detector: 'review', mustInclude: 'A held-edit card\'s keep writes the held edit as the answer\'s write' },
  { name: 'a held-edit card leaves out `more`', sw: { heldNoMore: true }, detector: 'review', mustInclude: 'A held-edit card counts what it does not list' },
  { name: 'a divergence\'s rev is its content alone, so one raised again keeps its old rev (round 6)', sw: { divRevContentOnly: true }, detector: 'review', mustInclude: 'A divergence raised again after a conflict replaced it has a new rev' },
  { name: 'a divergence an import keeps still shows the rows of the import that raised it (round 6)', sw: { divergenceKeepsOldRows: true }, detector: 'review', mustInclude: 'An MFC-only change over a figure the app is ahead on is applied and listed with its undo, and the score the app is ahead on stays one divergence; keep acknowledges it and the align-MFC entry asks for the score alone' },
  // round 8
  { name: 'HELD (i) as in round 7: an answer that ended the item the device saw hides its by-hand reaction', sw: { answerHidesReaction: true }, detector: 'compound' },
  { name: 'the same, caught by its golden', sw: { answerHidesReaction: true }, detector: 'review', mustInclude: 'A compound reaction in one push, dismiss and sale' },
  { name: 'HELD (ii) as in round 7: no revision point for a replay that changes nothing against S just before its push', sw: { revisionFromPushStart: true }, detector: 'compound' },
  { name: 'the same, caught by its golden', sw: { revisionFromPushStart: true }, detector: 'review', mustInclude: 'A compound reaction in two pushes, undo and sale' },
  { name: 'HELD (ii) as in round 7: a revision is everything its push emitted, an answer in the push included', sw: { revisionWholePush: true }, detector: 'review', mustInclude: 'A revision is what the replayed late edits alone change' },
  { name: 'a revision\'s change counts its late edits\' own writes (a tag on the copy the replayed sale took out is held)', sw: { revisionCountsOwn: true }, detector: 'review', mustInclude: 'HELD (ii) holds only a reaction to the revision' },
  { name: 'reaction clause (b) dropped: a copy added after the import reacts only through what it touches', sw: { noNewCopyReaction: true }, detector: 'review', mustInclude: 'Reaction clause (b) alone' },
  { name: 'reaction clause (c) without its first half: an item the device saw that the two sides end differently is no reaction by itself', sw: { noItemDiffClause: true }, detector: 'review', mustInclude: 'Reaction clause (c), an item the two placements end differently, though both pass through the rev the device saw' },
  { name: 'a pending divergence keeps its rev when an import finds other values', sw: { divRevKeptOnNewValues: true }, detector: 'review', mustInclude: 'A divergence whose values change between imports takes a new rev' },
  { name: 'a change entry raised again, identical, keeps the old rev', sw: { changeRevWithoutImport: true }, detector: 'review', mustInclude: 'A change entry raised again, identical, after it ended has a new rev' },
  { name: 'a device that saw an item only after it ended counts as having seen it', sw: { sawEndedItem: true }, detector: 'review', mustInclude: 'A device that saw an item only after it ended did not react to it' },
  { name: 'an undo of an applied change realigns the bases', sw: { undoRealigns: true }, detector: 'review', mustInclude: 'An undo moves no base' },
  // round 8, recheck 1
  { name: 'reaction clause (c) judged over the whole replay (round 8\'s first cut): an item an earlier import raised and I kept is given by both sides', sw: { seenOverWholeReplay: true }, detector: 'cross' },
  { name: 'the same, one push, caught by its golden', sw: { seenOverWholeReplay: true }, detector: 'review', mustInclude: 'A compound reaction to an item an earlier import raised, in one push' },
  { name: 'the same, two pushes, caught by its golden', sw: { seenOverWholeReplay: true }, detector: 'review', mustInclude: 'A compound reaction to an item an earlier import raised, in two pushes' },
  { name: 'the same, two devices, caught by its golden', sw: { seenOverWholeReplay: true }, detector: 'review', mustInclude: 'A compound reaction to an item an earlier import raised, on two devices' },
  { name: 'HELD (ii) skips every late edit (round 8\'s first cut), even one knowing for the revision\'s import', sw: { skipLateInRevision: true }, detector: 'cross' },
  { name: 'the same, a re-own, caught by its golden', sw: { skipLateInRevision: true }, detector: 'review', mustInclude: 'HELD (ii) judges an edit late for a later import' },
  { name: 'the same, an added copy, caught by its golden', sw: { skipLateInRevision: true }, detector: 'review', mustInclude: 'HELD (ii) judges an added copy late for a later import' },
  { name: 'reaction clause (b) for every revision point, one that changes nothing included (round 8\'s first cut)', sw: { newCopyAnyRevision: true }, detector: 'review', mustInclude: 'A revision that changes nothing holds no added copy' },
  { name: 'what a device saw read to the feed\'s head, not its basis', sw: { sawItemAtHead: true }, detector: 'review', mustInclude: 'A device that saw no item did not react to one raised after its edit' },
  { name: 'a favor_app change entry raised again, identical, keeps the old rev', sw: { favorRevWithoutImport: true }, detector: 'review', mustInclude: 'A favor_app change entry raised again, identical, after it ended has a new rev' },
  { name: 'an answer is STALE once a revision its device had not seen withdrew the item, though a later replay gave it back at its rev', sw: { answerStaleAfterWithdrawal: true }, detector: 'review', mustInclude: 'An item a replay withdrew and a later replay gives back at the same rev is pending with that rev again' },
  // round 8, recheck 1 (world 9)
  { name: 'a unit\'s placements put the push\'s later units before their import (round 8\'s model), so two late units of one push excuse each other', sw: { laterUnitsReplayed: true }, detector: 'late' },
  { name: 'the same, a by-hand sale, caught by its golden', sw: { laterUnitsReplayed: true }, detector: 'review', mustInclude: 'Two late units of one push never excuse each other' },
  { name: 'the same, a knowing filing, caught by its golden', sw: { laterUnitsReplayed: true }, detector: 'review', mustInclude: 'Two late units of one push never excuse each other, a knowing filing' },
  { name: 'the same, two late sales, caught by its golden', sw: { laterUnitsReplayed: true }, detector: 'review', mustInclude: 'Two late sales of one push never excuse each other' },
  { name: 'an item\'s revs recorded only after an import, so a rev the other side has pending only after a knowing edit counts as never pending (a hold too many)', sw: { pendingAtImportsOnly: true }, detector: 'review', mustInclude: 'Reaction clause (c), an item the other side has pending only after a knowing edit' },
  // round 8, recheck 2: world 10 is live
  { name: 'world 10 catches round 8\'s later units placed before their import', sw: { laterUnitsReplayed: true }, detector: 'w10' },
  { name: 'world 10 catches round 7\'s answer that hides a by-hand reaction', sw: { answerHidesReaction: true }, detector: 'w10' },
  // round 8, recheck 2: keep follows the rev; the undo of a favor_app settlement is the import's take
  { name: 'keep decides the figure again at the answer (round 8), so a disputed part a knowing edit brought back to its base takes MFC\'s side, one push', sw: { keepRedecides: true }, detector: 'review', mustInclude: 'Keep on a conflict follows its rev, in one push' },
  { name: 'the same, two pushes', sw: { keepRedecides: true }, detector: 'review', mustInclude: 'Keep on a conflict follows its rev, in two pushes' },
  { name: 'the undo of a favor_app settlement takes against the realigned bases (round 8): MFC lowered the count and nothing is removed', sw: { favorUndoOnRealigned: true }, detector: 'review', mustInclude: 'MFC lowered the count, FAVOR_APP' },
  { name: 'the same: MFC raised the count and new copies are made where the sold copy comes back', sw: { favorUndoOnRealigned: true }, detector: 'review', mustInclude: 'MFC raised the count, FAVOR_APP' },
  { name: 'the undo of a favor_app settlement ends the acknowledgement (round 8), so the same export raises a divergence', sw: { favorUndoEndsAck: true }, detector: 'review', mustInclude: 'MFC lowered the count, FAVOR_APP' },
  { name: 'the undo of a favor_app settlement takes against the latest export, not the entry\'s own', sw: { favorUndoAtLatestExport: true }, detector: 'review', mustInclude: 'The undo of a favor_app settlement works against the export of the import that made it' },
  // round 8, recheck 2: rules stated and observable, pinned now
  { name: 'a held-edit card\'s keep writes edits that are not knowing, so they never end a conflict whose sides they make agree', sw: { heldKeepNotKnowing: true }, detector: 'review', mustInclude: 'A held-edit card\'s keep writes knowing edits' },
  { name: 'a held-edit card\'s rev ignores which edits it lists, so a keep of the card a device saw keeps an edit that joined it since', sw: { heldRevIgnoresEdits: true }, detector: 'review', mustInclude: 'A held-edit card\'s rev is the edits it lists' },
  { name: 'a tag is a unit by itself, not with the push\'s other edits of its key', sw: { tagUnitPerEdit: true }, detector: 'review', mustInclude: 'A tag is one unit with the push\'s other edits of its key' },
  { name: 'a revision leaves out every facet of a copy its late edits write, not only the facets they write', sw: { ownByCopy: true }, detector: 'review', mustInclude: 'A revision leaves out only the facets its late edits write' },
  // round 9, recheck 1: keep follows the rev, and what it applies besides the disputed parts
  { name: 'an import that keeps a conflict\'s rev refreshes what the item holds, so keep follows that import, one device', sw: { cardRefreshedAtImport: true }, detector: 'review', mustInclude: 'Keep follows its rev across an identical import' },
  { name: 'the same, two devices', sw: { cardRefreshedAtImport: true }, detector: 'review', mustInclude: 'Keep follows its rev across an identical import, on two devices' },
  { name: 'the card\'s keep preview decides the figure again', sw: { previewRedecides: true }, detector: 'review', mustInclude: 'A conflict\'s keep preview follows its rev' },
  { name: 'the same, across an identical import on two devices', sw: { previewRedecides: true }, detector: 'review', mustInclude: 'Keep follows its rev across an identical import, on two devices' },
  { name: 'keep decides the disputed fields again (only the counts follow the rev)', sw: { keepRedecidesFields: true }, detector: 'review', mustInclude: 'Keep leaves a disputed field at the app\'s side though a knowing edit brought it back to its base' },
  { name: 'keep applies what the rev found MFC\'s change alone though the app has changed it since: the counts', sw: { keepByRevAlone: true }, detector: 'review', mustInclude: 'Keep leaves the counts as the app has them when the app has changed them since the rev found them MFC\'s change alone' },
  { name: 'the same: a field', sw: { keepByRevAlone: true }, detector: 'review', mustInclude: 'Keep leaves a field the rev found MFC\'s change alone as the app has it when the app has changed it since' },
  { name: 'keep decides again every part the rev does not list as disputed (round 9\'s first cut): a field', sw: { keepRedecidesUndisputed: true }, detector: 'review', mustInclude: 'Keep leaves a field the rev found alike as the app has it, though a knowing edit since put it back to its base' },
  { name: 'the same: the counts', sw: { keepRedecidesUndisputed: true }, detector: 'review', mustInclude: 'Keep leaves the counts the rev found alike as the app has them, though a knowing edit since put them back to their base' },
  { name: 'what keep applies of MFC\'s change leaves the import-removed mark as it was', sw: { keepLeavesImportMark: true }, detector: 'review', mustInclude: 'What keep applies of MFC\'s change is the import\'s' },
  { name: 'the same, a copy keep removes', sw: { keepLeavesImportMark: true }, detector: 'review', mustInclude: 'What keep removes of MFC\'s change is the import\'s' },
  { name: 'take removes by the highest occ id alone, not a copy with an origin first', sw: { takeRemovesByIdOnly: true }, detector: 'review', mustInclude: 'take removes a copy with an origin before one without, then the highest occ id' },
  // round 9, recheck 1: the undo of a favor_app settlement
  { name: 'the undo of a favor_app settlement puts back every base, not only the ones its realignment moved: a copy MFC came to track since', sw: { undoRestoresAllBases: true }, detector: 'review', mustInclude: 'The undo of a favor_app settlement puts back only the bases its realignment moved, so a copy MFC came to track since keeps its base' },
  { name: 'the same: a hand copy MFC came to track since', sw: { undoRestoresAllBases: true }, detector: 'review', mustInclude: 'The undo of a favor_app settlement puts back only the bases its realignment moved, so a hand copy MFC came to track since stays tracked' },
  { name: 'a favor_app entry shows the take against the realigned bases as its undo list (round 8\'s list)', sw: { favorShownOnRealigned: true }, detector: 'review', mustInclude: 'A favor_app change entry lists as its undo the take its import would have written' },
  { name: 'the undo of a favor_app settlement leaves the bases unrealigned', sw: { favorUndoNoRealign: true }, detector: 'review', mustInclude: 'The undo of a favor_app settlement realigns the bases, so MFC\'s later changes are decided against export 2\'s side' },
  { name: 'the undo of a favor_app settlement takes as a divergence\'s take does', sw: { favorUndoTakeSettled: true }, detector: 'review', mustInclude: 'The undo of a favor_app settlement is take, not a divergence\'s take' },
  { name: 'the undo of a favor_app settlement leaves the base its realignment gave a row new to that export', sw: { undoKeepsNewRowBases: true }, detector: 'review', mustInclude: 'The undo of a favor_app settlement puts back a row\'s absence' },
  { name: 'per_copy takes its field sides only for fields that conflict when decided again', sw: { perCopyRedecides: true }, detector: 'review', mustInclude: 'per_copy takes its field side for a field the rev lists as disputed, though a knowing edit since brought it back to its base' },
  // round 9, recheck 2: a conflict's rev follows MFC's rows (THE MFC PROJECTION), not its Counts per kind
  { name: 'an import keeps a conflict\'s rev when MFC\'s Counts per kind and its rows\' field values are unchanged (round 9\'s model): Count moved between two rows, keep', sw: { revByCountSum: true }, detector: 'review', mustInclude: 'Count moved between two rows of one figure gives a conflict a new rev' },
  { name: 'the same: Count moved between two rows, take', sw: { revByCountSum: true }, detector: 'review', mustInclude: 'Count moved between two rows of one figure gives a conflict a new rev, take' },
  { name: 'the same: two rows\' kinds swapped', sw: { revByCountSum: true }, detector: 'review', mustInclude: 'Two rows\' kinds swapped give a conflict a new rev' },
  { name: 'the same: a row\'s kind at Count 0 changed', sw: { revByCountSum: true }, detector: 'review', mustInclude: 'A row\'s kind at Count 0 is part of a conflict\'s MFC side' },
  { name: 'the same: a row base the export lacks moved to another figure', sw: { revByCountSum: true }, detector: 'review', mustInclude: 'A row base the export lacks is part of a conflict\'s MFC side' },
  { name: 'an import keeps a conflict\'s rev when the export\'s rows are unchanged, whatever row bases the export lacks', sw: { revByExportRows: true }, detector: 'review', mustInclude: 'A row base the export lacks is part of a conflict\'s MFC side' },
  { name: 'a row base the export lacks is in a conflict\'s MFC side as a row at Count 0, so a row dropped from Count 0 keeps the rev', sw: { revByMfcRows: true }, detector: 'review', mustInclude: 'A row the export drops from Count 0 gives a conflict a new rev' },
  { name: 'a conflict\'s MFC side leaves out its rows\' field values', sw: { revIgnoresFields: true }, detector: 'review', mustInclude: 'A row\'s field value is part of a conflict\'s MFC side' },
  { name: 'a conflict\'s MFC side includes each row\'s head', sw: { revByRowHeads: true }, detector: 'review', mustInclude: 'A row\'s head is the spine\'s, not part of a conflict\'s MFC side' },
  // contract-8 close-out, round 1: F1 frames every figure the import decides, and a conflict's rev by MFC's rows as REVS states it
  { name: 'F1 framed from the row bases the import left: a figure whose last row the export drops, written nothing, gets no frame', sw: { frameAfterImport: true }, detector: 'review', mustInclude: 'An import that drops a figure\'s last row decides and frames it, though it writes nothing there' },
  { name: 'the same: a figure whose only row the export drops misses the divergence pushed-first raises', sw: { frameAfterImport: true }, detector: 'review', mustInclude: 'An import that drops a figure\'s only row frames that figure' },
  { name: 'the same, in the cross-import world with the last or middle import dropping the row', sw: { frameAfterImport: true }, detector: 'crossDrop' },
  { name: 'a row base the export lacks keyed as a row at Count 0: a lacked row listed again at Count 0 keeps the rev', sw: { revByMfcRows: true }, detector: 'review', mustInclude: 'A row the export lacked, listed again at Count 0, gives a conflict a new rev' },
  { name: 'a conflict\'s MFC side includes each row\'s head: take of the card shown before the spine re-pointed its row is STALE', sw: { revByRowHeads: true }, detector: 'review', mustInclude: 'A row\'s head is the spine\'s' },
  { name: 'an export row\'s blank field kept apart from one it leaves out, so a blank score gives a conflict a new rev', sw: { rowsKeepBlankFields: true }, detector: 'review', mustInclude: 'A blank field value is no value' },
  { name: 'a conflict\'s MFC side leaves out its rows\' field values: the note', sw: { revIgnoresFields: true }, detector: 'review', mustInclude: 'A row\'s note is part of a conflict\'s MFC side' },
  { name: 'the same: the wishability', sw: { revIgnoresFields: true }, detector: 'review', mustInclude: 'A row\'s wishability is part of a conflict\'s MFC side' },
  // contract-8 close-out, fix round 1: an applied or favor_mfc undo acknowledges MFC's rows as the row bases stand at the undo
  { name: 'the undo of an applied change acknowledges MFC\'s rows as its import found them, a row base it dropped at Count 0: an align-MFC entry asks for a row MFC no longer lists', sw: { undoAckAtImport: true }, detector: 'review', mustInclude: 'The undo of an applied change acknowledges MFC\'s rows as the figure\'s row bases stand at the undo' },
  { name: 'the same: the undo of a favor_mfc change', sw: { undoAckAtImport: true }, detector: 'review', mustInclude: 'The undo of a favor_mfc change acknowledges MFC\'s rows as the figure\'s row bases stand at the undo' },
  { name: 'the same, on a merged figure: the entry the undo makes is one the next import of that export clears', sw: { undoAckAtImport: true }, detector: 'review', mustInclude: 'The undo of an applied change on a merged figure, a row its import dropped' },
  { name: 'the same, after a later import listed that row on another figure: the entry asks to rewrite it, with no current value', sw: { undoAckAtImport: true }, detector: 'review', mustInclude: 'The undo of an applied change after a later import listed the dropped row on another figure' },
  { name: 'the same, on a lone figure before a later import lists that row on another figure: the entry stays, stale', sw: { undoAckAtImport: true }, detector: 'review', mustInclude: 'The undo of an applied change on a figure whose only row its import dropped, before a later import lists that row on another figure' },
  { name: 'the undo acknowledges its change\'s export rows with the row bases at the undo: a row a later import dropped from Count 0 is still one of MFC\'s rows', sw: { undoAckExportRows: true }, detector: 'review', mustInclude: 'The undo of an applied change after a later import dropped a row at Count 0 and wrote nothing' },
  { name: 'the same: a row base a later import moved is read as the change\'s export stated it, so the entry misstates MFC\'s Count', sw: { undoAckExportRows: true }, detector: 'review', mustInclude: 'The undo of an applied change after a later import moved the row bases' },
  // contract-8 close-out, fix round 2: a row the change's import dropped is one of MFC's rows again once a later import that settled the figure lists it
  { name: 'the undo leaves out of MFC\'s rows a row its import dropped, though a later import listed it again at Count 0: no align-MFC entry, then a divergence at the next import of that export', sw: { undoAckLeavesDropped: true }, detector: 'review', mustInclude: 'The undo of an applied change after a later import listed the dropped row again at Count 0' },
  { name: 'the same, the later import listing it at Count 1 beside a copy re-added by hand', sw: { undoAckLeavesDropped: true }, detector: 'review', mustInclude: 'The undo of an applied change after a later import listed the dropped row again at Count 1, the app having re-added a copy by hand' },
  // contract-8 close-out h1: an acknowledgement records MFC's rows as they stand once its answer, settlement or import has moved the bases
  { name: 'a realigning answer or settlement, or a keep on a divergence, acknowledges MFC\'s rows as they stood before its base moves: a keep asks MFC to list again the row it dropped', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A keep on the conflict MFC\'s drop of a lone figure\'s only row raised' },
  { name: 'the same, on a merged figure: the entry asks for the dropped row, and the next import of that export clears it', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A keep on the conflict MFC\'s drop of a row raised, on a merged figure' },
  { name: 'the same: a FAVOR_APP settlement', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A FAVOR_APP settlement of the conflict MFC\'s drop of a lone figure\'s only row raised' },
  { name: 'the same: a FAVOR_APP settlement on a merged figure', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A FAVOR_APP settlement of the conflict MFC\'s drop of a row raised, on a merged figure' },
  { name: 'the same: per_copy, and the next import of that export raises a divergence', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A per_copy answer to the conflict MFC\'s drop of a row raised' },
  { name: 'the same: take, and the next import of that export raises a divergence', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A take on the conflict MFC\'s drop of a row raised, the app holding a hand copy and a note' },
  { name: 'the same: a FAVOR_MFC settlement', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A FAVOR_MFC settlement of the conflict MFC\'s drop of a row raised, the app holding a hand copy and a note' },
  { name: 'the same: the undo of a FAVOR_APP settlement', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'The undo of a FAVOR_APP settlement of the conflict MFC\'s drop of a row raised' },
  { name: 'the same: a keep on a divergence, on a merged figure', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A keep on the divergence an import raised when it dropped a row of a merged figure' },
  { name: 'the same: a keep on a divergence, on a lone figure', sw: { ackBeforeRealign: true }, detector: 'review', mustInclude: 'A keep on the divergence an import raised when it dropped a lone figure\'s only row' },
  { name: 'an import that finds a figure acknowledged records MFC\'s rows as it found them: a hand copy added after is asked of the row it dropped', sw: { importAckRowsAsFound: true }, detector: 'review', mustInclude: 'An import that finds a figure acknowledged at its values while it drops a row at Count 0 records MFC\'s rows as its decision leaves them' },
  // contract-8 close-out h1 (recheck NOTE C16): the undo records each row with its row base's kind
  { name: 'the undo acknowledges a row with the kind the change\'s export stated, not its row base\'s: the entry asks to re-kind a row the app agrees with', sw: { undoAckKindFromExport: true }, detector: 'review', mustInclude: 'The undo of an applied change after a later import moved a row\'s kind base the app already held' },
  // contract-8 close-out h2 (recheck SHOULD 1): an import that finds a figure acknowledged records the parts as its decision leaves them
  { name: 'an import that finds a figure acknowledged keeps the parts as it found them, a row it dropped at Count 0: the next import of that export raises a divergence', sw: { importAckPartsAsFound: true }, detector: 'review', mustInclude: 'An import that finds a figure acknowledged at its values, a hand copy kept in a row at Count 0 that the import drops, records the parts as its decision leaves them' },
  { name: 'the same: a part that differs only once the dropped row is gone is not recorded, so the next import of that export raises it', sw: { importAckPartsAsFound: true }, detector: 'review', mustInclude: 'An import that finds a figure acknowledged at its values while it drops a row at Count 0 the plan used also records a part that differs only once that row is gone' },
  // contract-8 close-out h2, round 3 (recheck SHOULD 2): the undo of a FAVOR_APP settlement ends a divergence a later import raised
  { name: 'the undo of an older FAVOR_APP settlement leaves pending the divergence a later import raised when it dropped a row: a keep on it is accepted, and the next import of that export removes the copy it kept', sw: { favorUndoKeepsDivergence: true }, detector: 'review', mustInclude: 'The undo of an older FAVOR_APP settlement ends the divergence a later import raised when it dropped a row' },
  { name: 'the same: the divergence a later import raised when it listed a row the undo\'s export lacks', sw: { favorUndoKeepsDivergence: true }, detector: 'review', mustInclude: 'The undo of an older FAVOR_APP settlement ends the divergence a later import raised when it listed a row the undo\'s export lacks' },
  { name: 'the same: the divergence stays pending though the undo\'s take left the app at MFC\'s latest Count', sw: { favorUndoKeepsDivergence: true }, detector: 'review', mustInclude: 'The undo of a favor_app settlement works against the export of the import that made it' },
  // contract-8 close-out i1 (recheck SHOULD 1): the undo of an older FAVOR_APP settlement that ends a divergence records no acknowledgement
  { name: 'the undo of an older FAVOR_APP settlement that ends a divergence a later import raised acknowledges, as a take does, what its take leaves differing: the hand copy that divergence showed is never raised again', sw: { favorUndoAcksEndedDivergence: true }, detector: 'review', mustInclude: 'The undo of an older FAVOR_APP settlement that ends a divergence a later import raised records no acknowledgement' },
  { name: 'the same: an undo that writes nothing and moves no base', sw: { favorUndoAcksEndedDivergence: true }, detector: 'review', mustInclude: 'The undo of an older FAVOR_APP settlement that writes nothing and moves no base still ends the divergence a later import raised' },
  { name: 'the same: an app change made after the divergence\'s import is acknowledged though the user never answered it', sw: { favorUndoAcksEndedDivergence: true }, detector: 'review', mustInclude: 'The undo of an older FAVOR_APP settlement that ends a divergence acknowledges no app change made since that divergence\'s import' },
  // contract-8 close-out i1 (recheck SHOULD 2): a part an import finds equal is acknowledged no more
  { name: 'an import that finds a figure acknowledged merges the parts it finds into those recorded: a part it found equal stays acknowledged at its old values, so the value the user kept, written back, raises nothing', sw: { importAckPartsMerged: true }, detector: 'review', mustInclude: 'An import that finds an acknowledged part equal acknowledges it no more' },
  { name: 'the same: it records the parts again only when it drops a row at Count 0', sw: { importAckPartsOnDropOnly: true }, detector: 'review', mustInclude: 'An import that finds an acknowledged part equal acknowledges it no more' },
];

describe('mutants: every rule is load-bearing', () => {
  it('the unmutated model passes every detector', () => {
    expect(scenarioFailures({})).toEqual([]);
    expect(reviewFailures({})).toEqual([]);
    expect(worldBreaches({})).toBe(0);
    expect(reactionBreaches({})).toBe(0);
    expect(itemBreaches({})).toBe(0);
    expect(compoundBreaches({})).toBe(0);
    expect(crossBreaches({})).toBe(0);
    expect(crossDropBreaches({})).toBe(0);
    expect(lateBreaches({})).toBe(0);
    expect(w10Breaches({})).toBe(0);
    const t = twoDevices();
    expect(t.silentCounts + t.differsShown).toBe(0);
  }, 300_000);

  it.each(MUTANTS.map((m) => [m.name, m] as const))('%s is caught', (_name, m) => {
    const sw = m.sw ?? {};
    if (m.detector === 'world') expect(worldBreaches(sw, m.client?.staging ?? true)).toBeGreaterThan(0);
    else if (m.detector === 'items') expect(itemBreaches(sw)).toBeGreaterThan(0);
    else if (m.detector === 'compound') expect(compoundBreaches(sw)).toBeGreaterThan(0);
    else if (m.detector === 'cross') expect(crossBreaches(sw)).toBeGreaterThan(0);
    else if (m.detector === 'crossDrop') expect(crossDropBreaches(sw)).toBeGreaterThan(0);
    else if (m.detector === 'late') expect(lateBreaches(sw)).toBeGreaterThan(0);
    else if (m.detector === 'w10') expect(w10Breaches(sw)).toBeGreaterThan(0);
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

  it('a push whose late edits are all held being a revision is equivalent: that push changes nothing, so it holds no added copy, and it withdraws no item a device saw', () => {
    expect(scenarioFailures({ heldLateIsRevision: true })).toEqual([]);
    expect(reviewFailures({ heldLateIsRevision: true })).toEqual([]);
    expect(itemBreaches({ heldLateIsRevision: true })).toBe(0);
    expect(compoundBreaches({ heldLateIsRevision: true })).toBe(0);
    expect(crossBreaches({ heldLateIsRevision: true })).toBe(0);
  }, 300_000);

  it('world 10 counts an undo of an item of another kind apart only when its intent stands: a lost undo is silent (round 9, recheck 1)', () => {
    // a mutant that loses an undo in a replay (HELD (iii) for figure items only): the offline undo's statuses do not end
    // as its device asked, so the path is silent, not an answer to an item of another kind
    const lost = compoundLateWorld({ sw: { answerHoldFigureOnly: true }, from: 138_723, to: 138_723 });
    expect({ answerKind: lost.answerKind, silent: lost.silent }).toEqual({ answerKind: 0, silent: 1 });
    expect(compoundLateWorld({ from: 138_723, to: 138_723 }).silent).toBe(0);
    // a replay voids the undo, and its statuses end as asked but for o2, which the late unit itself sold: apart
    const voided = compoundLateWorld({ from: 281_419, to: 281_419 });
    expect({ answerKind: voided.answerKind, silent: voided.silent }).toEqual({ answerKind: 1, silent: 0 });
  }, 120_000);

  it('M8 (materialize may pick a copy the app changed) is equivalent: no golden and no world case changes', () => {
    expect(scenarioFailures({ M8: true })).toEqual([]);
    expect(reviewFailures({ M8: true })).toEqual([]);
    expect(worldBreaches({ M8: true })).toBe(0);
    expect(reactionBreaches({ M8: true })).toBe(0);
  }, 120_000);
});
