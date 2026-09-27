// THE SERVER DECIDES, as a property: however an offline phone's edits meet an import (pushed after it, pulled first,
// or across two imports), the end state equals the path where the phone pushed first. FC_PROPERTY_FULL=1 runs the
// two-import world in full (554,286 path runs); CI runs every 16th case of it.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { twoDevices, world, type Tally } from './support/worlds.js';

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

  it('two devices, one edit each, both pull the import first (fuzz2_a.py)', () => {
    const t = twoDevices();
    report('two devices', t);
    expect(t.runs).toBe(984);
    expect({ silentCounts: t.silentCounts, differsShown: t.differsShown }, t.first.join('\n')).toEqual({ silentCounts: 0, differsShown: 0 });
  }, 600_000);
});
