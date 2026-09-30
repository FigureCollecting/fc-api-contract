// THE SERVER DECIDES, as a property: however an offline phone's edits meet an import (pushed after it, pulled first,
// or across two imports), the end state equals the path where the phone pushed first; and when another device reacted
// to the import first, the phone's late units are held and shown, never lost silently. FC_PROPERTY_FULL=1 runs the
// two-import world in full (554,286 path runs) and the compound-reaction world in full (137,682); CI runs every 16th case
// of the first and every 7th of the second. The cross-import world runs its 20,000 random scripts everywhere.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compoundReactionWorld, crossImportWorld, itemReactionWorld, reactionWorld, twoDevices, world, type Tally } from './support/worlds.js';

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
    // see offline; with that copy taken out by name, pushed-first ends the same
    expect(t.picks, t.pickCases.join('\n')).toBe(full ? 10 : 0);
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
    // the paths counted apart, each read (none is a loss): pinned so that any change is seen
    expect({ picks: t.picks, refHeldAnswered: t.refHeldAnswered, answeredSameRev: t.answeredSameRev, collisions: t.collisions }).toEqual({ picks: 30, refHeldAnswered: 9, answeredSameRev: 2, collisions: 15 });
  }, 600_000);

  it('two devices, one edit each, both pull the import first (fuzz2_a.py)', () => {
    const t = twoDevices();
    report('two devices', t);
    expect(t.runs).toBe(984);
    expect({ silentCounts: t.silentCounts, differsShown: t.differsShown }, t.first.join('\n')).toEqual({ silentCounts: 0, differsShown: 0 });
  }, 600_000);
});
