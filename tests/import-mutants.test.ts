// Each mutant removes one rule from the server model (or the client); the goldens or the property worlds must then
// fail, and the unmutated model must pass them all. M8 is the one equivalent mutant: import.proto 4.4 (c2) already
// keeps every copy the app changed out of MATERIALIZE, so dropping the check changes nothing (shown below).
import { describe, expect, it } from 'vitest';
import type { Switches } from './support/server-model.js';
import { runScenario } from './support/trace-runner.js';
import { vectors } from './support/vectors.js';
import { twoDevices, world } from './support/worlds.js';

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function scenarioFailures(sw: Switches, staging = true): string[] {
  return vectors.serverScenarios.filter((c) => {
    const r = runScenario(c, sw, { staging });
    return !eq(r.actual, r.wanted) || !eq(r.end, c.expect);
  }).map((c) => c.id);
}
function reviewFailures(sw: Switches): string[] {
  return vectors.review.filter((c) => {
    const r = runScenario(c, sw);
    return !eq(r.actual, r.wanted) || !eq(r.review, c.expect);
  }).map((c) => c.name.split(':')[0]!);
}
const worldBreaches = (sw: Switches, staging = true) => {
  const t = world(1, { sw, staging });
  return t.silentCounts + t.silentItem + t.differsShown;
};

type Detector = 'scenarios' | 'review' | 'world' | 'twoDevices';
const MUTANTS: { name: string; sw?: Switches; staging?: false; detector: Detector; mustInclude?: string }[] = [
  { name: 'F1: no marker frame (a figure the import decided without writing gets no frame)', sw: { noMarker: true }, detector: 'world' },
  { name: 'F2: no client staging (a page ending inside an import is shown half applied)', staging: false, detector: 'scenarios', mustInclude: 'J-A1-staged (removal)' },
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
  { name: 'R3: the HOLD preference ignored', sw: { ignoreHold: true }, detector: 'review' },
  { name: 'R4: an acknowledgement not kept (MFC is behind is asked again)', sw: { noAck: true }, detector: 'review', mustInclude: 'Scenario 3' },
  { name: 'R5: a FAVOR preference applied to MFC-only changes too', sw: { favorAll: true }, detector: 'review', mustInclude: 'Scenario 4, FAVOR_APP is applied only to true conflicts' },
  { name: 'R8: a dismissed align-MFC entry shown again', sw: { forgetDismiss: true }, detector: 'review' },
  { name: 'R8: a divergence raised for a figure with no MFC id', sw: { divergeWithoutId: true }, detector: 'review', mustInclude: 'Align-MFC is derived only where the MFC id is known' },
];

describe('mutants: every rule is load-bearing', () => {
  it('the unmutated model passes every detector', () => {
    expect(scenarioFailures({})).toEqual([]);
    expect(reviewFailures({})).toEqual([]);
    expect(worldBreaches({})).toBe(0);
    const t = twoDevices();
    expect(t.silentCounts + t.differsShown).toBe(0);
  }, 120_000);

  it.each(MUTANTS.map((m) => [m.name, m] as const))('%s is caught', (_name, m) => {
    const sw = m.sw ?? {};
    if (m.detector === 'world') expect(worldBreaches(sw, m.staging ?? true)).toBeGreaterThan(0);
    else if (m.detector === 'twoDevices') {
      const t = twoDevices({ sw });
      expect(t.silentCounts + t.differsShown).toBeGreaterThan(0);
    } else {
      const failed = m.detector === 'scenarios' ? scenarioFailures(sw, m.staging ?? true) : reviewFailures(sw);
      expect(failed.length).toBeGreaterThan(0);
      if (m.mustInclude !== undefined) expect(failed).toContain(m.mustInclude);
    }
  }, 120_000);

  it('M8 (materialize may pick a copy the app changed) is equivalent: no golden and no world case changes', () => {
    expect(scenarioFailures({ M8: true })).toEqual([]);
    expect(reviewFailures({ M8: true })).toEqual([]);
    expect(worldBreaches({ M8: true })).toBe(0);
  }, 120_000);
});
