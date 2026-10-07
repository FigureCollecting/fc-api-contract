// THE SERVER DECIDES, as a property: however an offline phone's edits meet an import (pushed after it, pulled first,
// or across two imports), the end state equals the path where the phone pushed first; and when another device reacted
// to the import first, the phone's late units are held and shown, never lost silently. FC_PROPERTY_FULL=1 runs the
// two-import world in full (554,286 path runs), the compound-reaction world in full (137,682), the late-units world in
// full (2,710,620) and the two-offline-devices world in full (300,000 cases); CI runs every 16th case of the first, every
// 7th of the second, every 101st of the third and every 25th of the fourth. The cross-import world runs its 20,000 random
// scripts everywhere, and again with the last or the middle import dropping the row where it states Count 0.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compoundLateWorld, compoundReactionWorld, crossImportWorld, itemReactionWorld, lateUnitsWorld, reactionWorld, twoDevices, world, type Tally } from './support/worlds.js';

// The tallies go to the console, and to the file FC_PROPERTY_REPORT names when it is set.
const report = (name: string, t: Tally) => {
  const line =
    `${name}: ${t.runs} path runs; same as pushed-first ${t.same + t.sameWithItem} (${t.sameWithItem} with an item pending in both); ` +
    `silent, other counts ${t.silentCounts}; silent, pushed-first has an item ${t.silentItem}; differs but shown ${t.differsShown}`;
  console.log(line);
  if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
};

describe('property: the offline path ends where the pushed-first path ends', () => {
  it('one import, every small world (fuzz_a.py 1: the phone pushes after the import, or pulls it first)', () => {
    const t = world(1);
    report('one import', t);
    expect(t.runs).toBe(29_876);
    expect({ silentCounts: t.silentCounts, silentItem: t.silentItem, differsShown: t.differsShown }, t.first.join('\n')).toEqual({ silentCounts: 0, silentItem: 0, differsShown: 0 });
  }, 600_000);

  it('two imports (fuzz_a.py 2: pushed after both, pulled after the first, or pulled between them)', () => {
    const full = process.env.FC_PROPERTY_FULL === '1';
    const t = world(2, { every: full ? 1 : 16 });
    report(full ? 'two imports (full)' : 'two imports (every 16th case)', t);
    expect(t.runs).toBe(full ? 554_286 : 34_644);
    expect({ silentCounts: t.silentCounts, silentItem: t.silentItem, differsShown: t.differsShown }, t.first.join('\n')).toEqual({ silentCounts: 0, silentItem: 0, differsShown: 0 });
  }, 3_600_000);

  it('late units and a knowing reaction: one or two late units, in one push or two, after the tablet reacted (HELD)', () => {
    const t = reactionWorld();
    const line =
      `late units and a reaction: ${t.runs} path runs; same as pushed-first ${t.same}; same counts, held or item shown ${t.sameCountsShown}; ` +
      `differs but shown ${t.differsShown}; silent ${t.silent}; differs with no reaction ${t.noReactionDiffers}`;
    console.log(line);
    if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
    expect(t.runs).toBe(4_700);
    expect({ silent: t.silent, noReactionDiffers: t.noReactionDiffers }, t.first.join('\n')).toEqual({ silent: 0, noReactionDiffers: 0 });
  }, 600_000);

  it('a reaction to an item: the tablet answers, or acts by hand on, the conflict or change entry it was shown, before or after the late unit arrives (HELD (i), (ii))', () => {
    const t = itemReactionWorld();
    const line =
      `a reaction to an item: ${t.runs} path runs (${t.reacted} reacted); same as pushed-first ${t.same}; differs but shown ${t.shown}; ` +
      `silent ${t.silent}; silent, pushed-first has an item ${t.silentItem}; one copy taken out on both devices ${t.collisions}`;
    console.log(line);
    if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
    expect(t.runs).toBe(12_936);
    expect({ silent: t.silent, silentItem: t.silentItem }, t.first.join('\n')).toEqual({ silent: 0, silentItem: 0 });
    // the tablet's by-hand sale of the very copy the phone sold offline: since round 8 each is held and shown (the tablet
    // saw the change the phone's sale withdraws), so none is left as plain concurrency
    expect(t.collisions).toBe(0);
  }, 600_000);

  it('a compound reaction: the tablet answers the item it was shown and acts by hand on the same showing, in one push or two, or a third device acts by hand (HELD (i), (ii))', () => {
    const full = process.env.FC_PROPERTY_FULL === '1';
    const t = compoundReactionWorld({ every: full ? 1 : 7 });
    const line =
      `a compound reaction${full ? ' (full)' : ' (every 7th case)'}: ${t.runs} path runs; same as pushed-first ${t.same}; same counts, held or item shown ${t.sameCountsShown}; ` +
      `differs but shown ${t.differsShown}; a by-hand pick the replay moved ${t.picks}; silent ${t.silent}; silent, pushed-first has an item ${t.silentItem}`;
    console.log(line);
    if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
    expect(t.runs).toBe(full ? 137_682 : 19_694);
    expect({ silent: t.silent, silentItem: t.silentItem }, t.first.join('\n')).toEqual({ silent: 0, silentItem: 0 });
    // pushed-first, the device's pick (the lowest or highest live copy) is the phone's own late copy, which it could not
    // see offline; with that copy taken out by name, pushed-first ends the same (12 since round 9: the undo of a favor_app
    // settlement now brings back the sold copy, so a pick that once ended alike by chance now ends apart)
    expect(t.picks, t.pickCases.join('\n')).toBe(full ? 12 : 0);
  }, 3_600_000);

  it('reactions across two imports: answers and by-hand edits made after either import, some pushed only after the second (so late themselves), the phone\'s unit late for one import or both (HELD (i), (ii))', () => {
    const t = crossImportWorld({ from: 1, to: 20_000 });
    const line =
      `reactions across two imports: ${t.runs} scripts; same as pushed-first ${t.same}; same counts, held or item shown ${t.sameCountsShown}; ` +
      `differs but shown ${t.differsShown}; a by-hand pick ${t.picks}; pushed-first holds and its card's answer ends there ${t.refHeldAnswered}; ` +
      `an answer to an item given back at its rev ${t.answeredSameRev}; one copy written on both devices ${t.collisions}; silent ${t.silent}; silent, pushed-first has an item ${t.silentItem}`;
    console.log(line);
    if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
    expect(t.runs).toBe(20_000);
    expect({ silent: t.silent, silentItem: t.silentItem }, t.first.join('\n')).toEqual({ silent: 0, silentItem: 0 });
    // the paths counted apart, each read (none is a loss): pinned so that any change is seen (contract-8 close-out i1, recheck
    // NOTE: same, sameCountsShown and differsShown pinned too; the undo of an older FAVOR_APP settlement ending a divergence a
    // later import raised (h2, round 3) moved 18 FAVOR_APP scripts from 555a107, same 12,401 -> 12,416, sameCountsShown 2,665 ->
    // 2,653, differsShown 4,878 -> 4,875, none silent: 15 into same (9 from sameCountsShown, 6 from differsShown) and 3 from
    // sameCountsShown to differsShown, seeds 4375, 7944 and 16067)
    expect({ same: t.same, sameCountsShown: t.sameCountsShown, differsShown: t.differsShown, picks: t.picks, refHeldAnswered: t.refHeldAnswered, answeredSameRev: t.answeredSameRev, collisions: t.collisions }).toEqual({
      same: 12_416,
      sameCountsShown: 2_653,
      differsShown: 4_875,
      picks: 30,
      refHeldAnswered: 9,
      answeredSameRev: 2,
      collisions: 15,
    });
  }, 600_000);

  it('reactions across two imports, one import dropping the row: where the script\'s last (or middle) import states Count 0 it lacks the row instead (the user deleted the entry on MFC), so it decides and frames a figure it may write nothing to (F1)', () => {
    // the paths counted apart, each read (none is a loss), as in the world without the drop: pinned so that any change is seen
    // (contract-8 close-out h1: picks 1 -> 6 and 16 -> 17, all FAVOR_APP settlements of the drop: their acknowledgement no longer
    // asks MFC to list the dropped row, so no device reacts to that entry and nothing is held; what still differs is a by-hand
    // sale of the highest live copy the device saw, equal to pushed-first with that copy taken by name)
    // (contract-8 close-out h2: same, sameCountsShown and differsShown pinned too, so a change that moves a script between
    // them is seen; recheck h2 found 54 middle-drop scripts had left 'same' at h1 unseen, 32 of them FAVOR_MFC)
    // (contract-8 close-out h2, round 3: the undo of a FAVOR_APP settlement ends a divergence a later import raised; same
    // 2,723 -> 2,730 and 2,627 -> 2,640, every moved script a FAVOR_APP one, none silent)
    const apart = {
      last: { runs: 3_947, same: 2_730, sameCountsShown: 355, differsShown: 845, picks: 6, refHeldAnswered: 2, answeredSameRev: 0, collisions: 9 },
      middle: { runs: 3_914, same: 2_640, sameCountsShown: 414, differsShown: 830, picks: 17, refHeldAnswered: 2, answeredSameRev: 0, collisions: 11 },
    };
    for (const drop of ['last', 'middle'] as const) {
      const t = crossImportWorld({ from: 1, to: 20_000, drop });
      const line =
        `reactions across two imports, the ${drop} import dropping the row: ${t.runs} scripts; same as pushed-first ${t.same}; same counts, held or item shown ${t.sameCountsShown}; ` +
        `differs but shown ${t.differsShown}; a by-hand pick ${t.picks}; pushed-first holds and its card's answer ends there ${t.refHeldAnswered}; ` +
        `an answer to an item given back at its rev ${t.answeredSameRev}; one copy written on both devices ${t.collisions}; silent ${t.silent}; silent, pushed-first has an item ${t.silentItem}`;
      console.log(line);
      if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
      expect({ silent: t.silent, silentItem: t.silentItem }, t.first.join('\n')).toEqual({ silent: 0, silentItem: 0 });
      expect({ runs: t.runs, same: t.same, sameCountsShown: t.sameCountsShown, differsShown: t.differsShown, picks: t.picks, refHeldAnswered: t.refHeldAnswered, answeredSameRev: t.answeredSameRev, collisions: t.collisions }).toEqual(apart[drop]);
    }
  }, 600_000);

  it('late units and every reaction: one late unit or two, in one push or two, the tablet and a third device reacting by hand or by an answer to what they are shown, a second import or none, every order (HELD (i), (ii), (iii))', () => {
    const full = process.env.FC_PROPERTY_FULL === '1';
    const t = lateUnitsWorld({ every: full ? 1 : 101 });
    const line =
      `late units and every reaction${full ? ' (full)' : ' (every 101st case)'}: ${t.runs} path runs; same as pushed-first ${t.same}; same counts, held or item shown ${t.sameCountsShown}; ` +
      `differs but shown ${t.differsShown}; a by-hand pick among other copies ${t.picks}; an answer to an item of another kind pushed-first ${t.answerKind}; one copy taken out by a late unit and by hand ${t.collisions}; ` +
      `one copy taken out on two devices ${t.tuCollisions}; silent ${t.silent} (${t.silentWithItemInBoth} with a figure item in both)`;
    console.log(line);
    if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
    expect(t.runs).toBe(full ? 2_710_620 : 26_838);
    expect({ silent: t.silent }, t.first.join('\n')).toEqual({ silent: 0 });
    // the paths counted apart, each read (none is a loss; t.apart lists the first): a by-hand pick among copies both
    // paths show, an undo the offline path gave to an applied change where pushed-first shows a favor_app settlement
    // (the same answer, another meaning: pushed-first without it ends the same), and a by-hand sale of the very copy a
    // late unit took out (two devices recorded one sale); pinned so that any change is seen
    expect({ picks: t.picks, answerKind: t.answerKind, collisions: t.collisions, tuCollisions: t.tuCollisions }, t.apart.join('\n')).toEqual(
      full ? { picks: 29, answerKind: 84, collisions: 1_482, tuCollisions: 0 } : { picks: 0, answerKind: 0, collisions: 13, tuCollisions: 0 },
    );
  }, 7_200_000);

  it('compound reactions on two devices beside two offline devices: the phone\'s one or two late units and a second device\'s, the tablet and a third device each answering and acting by hand, a second import before, after or between their pushes, every order (HELD (i), (ii), (iii))', () => {
    const full = process.env.FC_PROPERTY_FULL === '1';
    const t = compoundLateWorld({ from: 1, to: 300_000, every: full ? 1 : 25 });
    const line =
      `two offline devices and compound reactions${full ? ' (full)' : ' (every 25th case)'}: ${t.runs} cases; same as pushed-first ${t.same}; same counts, held or item shown ${t.sameCountsShown}; ` +
      `differs but shown ${t.differsShown}; a by-hand pick ${t.picks}; pushed-first holds and its card's answer ends there ${t.refHeldAnswered}; ` +
      `an answer to an item of another kind pushed-first ${t.answerKind}; one copy taken out by a late unit and by hand ${t.collisions}; one copy taken out on two devices ${t.tuCollisions}; ` +
      `silent ${t.silent}; silent, pushed-first has an item ${t.silentItem}`;
    console.log(line);
    if (process.env.FC_PROPERTY_REPORT !== undefined) appendFileSync(process.env.FC_PROPERTY_REPORT, `${line}\n`);
    expect(t.runs).toBe(full ? 300_000 : 12_000);
    expect({ silent: t.silent, silentItem: t.silentItem }, t.first.join('\n')).toEqual({ silent: 0, silentItem: 0 });
    // the paths counted apart, each read (none is a loss; t.apart lists the first): a by-hand pick, pushed-first holding
    // an edit whose card's answer ends at the offline counts, an undo of an applied change offline where pushed-first
    // shows a favor_app settlement (the same answer, another meaning), and a by-hand sale of the copy a late unit took
    // out; pinned so that any change is seen (contract-8 close-out h2, round 3: picks 49 -> 50 in full, seed 5127, a
    // FAVOR_APP undo offline: the divergence it now ends no longer holds the phone's late units, and what still differs is
    // which copy each by-hand sale took, equal to pushed-first with those copies taken by name)
    expect({ picks: t.picks, refHeldAnswered: t.refHeldAnswered, answerKind: t.answerKind, collisions: t.collisions, tuCollisions: t.tuCollisions }, t.apart.join('\n')).toEqual(
      full ? { picks: 50, refHeldAnswered: 1, answerKind: 6, collisions: 1, tuCollisions: 0 } : { picks: 3, refHeldAnswered: 0, answerKind: 0, collisions: 0, tuCollisions: 0 },
    );
  }, 7_200_000);

  it('two devices, one edit each, both pull the import first (fuzz2_a.py)', () => {
    const t = twoDevices();
    report('two devices', t);
    expect(t.runs).toBe(984);
    expect({ silentCounts: t.silentCounts, differsShown: t.differsShown }, t.first.join('\n')).toEqual({ silentCounts: 0, differsShown: 0 });
  }, 600_000);
});
