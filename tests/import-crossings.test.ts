import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareVersion } from '../src/index.js';
import { pushOnConflict, type ConflictFacet } from './support/conflict-model.js';
import { KeyedCrossingClient, type Event, type Facet, type Value } from './support/crossing-model.js';
import { reimport, type Copy, type ExportRow } from './support/reimport-model.js';

type Expect = { shows?: Record<string, Value>; crossings: Record<string, Value>; outbox?: [string, Value][] };
type Step = { expect?: Expect } & (
  | { take: Event }
  | { edit: Event }
  | { push: true }
  | { answer: { outcome: 'APPLIED' | 'STALE'; current: Event } }
  | { resolve: { key: string; choice: 'keep' | 'take'; version: string } }
);
interface ConflictPush {
  event: Facet;
  now: string;
  expect: { outcome: 'APPLIED' | 'STALE'; K: Facet; conflict: ConflictFacet; pending: boolean };
}
interface Vectors {
  devices: { self: string; import: string; other: string };
  keyedCrossings: { name: string; steps: Step[] }[];
  conflictPushes: { name: string; start: { K: Facet; conflict: ConflictFacet }; pushes: ConflictPush[] }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/import-vectors.json', import.meta.url)), 'utf8'),
) as Vectors;
const SELF = vectors.devices.self;
const I1 = `2026-10-01T09:00:00.000000Z#0000000001#${vectors.devices.import}`;
const I2 = `2026-10-01T11:00:00.000000Z#0000000002#${vectors.devices.import}`;
const at = (time: string, counter = 0) => `2026-10-01T${time}:00.000000Z#${String(counter).padStart(10, '0')}#${SELF}`;

describe('golden import vectors: crossings over several keys (sync.proto rule 6, IMPORT CROSSINGS, ROW GRAIN)', () => {
  it('cover both GR-Q3 copies and both mint times, a raise, a no-net-change sale, a kind change, other rows and kinds, a replay, another device and conflicts', () => {
    const names = vectors.keyedCrossings.map((c) => c.name).join('\n');
    for (const topic of [/GR-Q3 offline \(S1\): the phone sold o1/, /sold o2/, /GR-Q3 \(S2\)/, /raise \(S1\)/, /raise \(S2\)/, /changes nothing/, /another copy's kind/, /another row/, /replay/, /another device/, /conflict raised .* before the import \(S1\)/, /conflict raised .* after the import \(S2\)/, /conflict the client had taken/]) {
      expect(names).toMatch(topic);
    }
    const steps = vectors.keyedCrossings.flatMap((c) => c.steps);
    expect(new Set(steps.flatMap((s) => ('answer' in s ? [s.answer.outcome] : [])))).toEqual(new Set(['APPLIED', 'STALE']));
    expect(new Set(steps.flatMap((s) => ('resolve' in s ? [s.resolve.choice] : [])))).toEqual(new Set(['keep', 'take']));
  });

  it.each(vectors.keyedCrossings.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const client = new KeyedCrossingClient(SELF);
    c.steps.forEach((step, i) => {
      if ('take' in step) client.take(step.take);
      else if ('edit' in step) client.edit(step.edit.key, step.edit.value, step.edit.version);
      else if ('push' in step) client.push();
      else if ('answer' in step) client.answer(step.answer.outcome, step.answer.current);
      else client.resolve(step.resolve.key, step.resolve.choice, step.resolve.version);
      if (step.expect === undefined) return;
      const where = `step ${i + 1}`;
      for (const [key, value] of Object.entries(step.expect.shows ?? {})) expect(client.shows(key), `${where} ${key}`).toEqual(value);
      expect(Object.fromEntries([...client.crossings].map(([key, x]) => [key, x.mfc.value])), where).toEqual(step.expect.crossings);
      if (step.expect.outbox !== undefined) expect(client.outbox.map((e) => [e.key, e.value]), where).toEqual(step.expect.outbox);
    });
  });
});

describe('golden import vectors: a push to a key with a pending import conflict (sync.proto rule 6, IMPORT CONFLICTS)', () => {
  it('cover a move, a resolution, a second move, a loss by LWW and an edit minted after the import', () => {
    const outcomes = vectors.conflictPushes.flatMap((c) => c.pushes.map((p) => `${p.expect.outcome}:${p.expect.pending}`));
    expect(new Set(outcomes)).toEqual(new Set(['APPLIED:true', 'APPLIED:false', 'STALE:true']));
    expect(vectors.conflictPushes.some((c) => c.pushes.length > 1)).toBe(true);
  });

  it.each(vectors.conflictPushes.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    let state = structuredClone(c.start);
    c.pushes.forEach((p, i) => {
      const after = pushOnConflict(state, p.event, p.now);
      expect(after, `push ${i + 1}`).toEqual(p.expect);
      state = { K: after.K, conflict: after.conflict };
    });
  });
});

// ---------------------------------------------------------------------------
// The server's import (reimport-model) and an offline phone (crossing-model) together, over a feed with
// LWW pushes: every GR-Q3 and raise case the three-way cannot see, in every order, ends as both sides meant
// once the user keeps the app's side, and a re-import of the same export writes nothing.
// ---------------------------------------------------------------------------
class Server {
  copies = new Map<string, Copy>();
  versions = new Map<string, string>();
  feed: Event[] = [];

  constructor(copies: Copy[]) {
    for (const x of copies) {
      this.copies.set(x.occ, structuredClone(x));
      for (const field of ['origin', 'head', 'status'] as const) this.record(`occ/${x.occ}/${field}`, I1);
    }
  }

  private value(key: string): Value {
    const [, occ, field] = key.split('/') as [string, string, string];
    const x = this.copies.get(occ);
    if (field === 'origin') return x?.origin?.id ?? null;
    return (field === 'head' ? x?.head : x?.status) ?? null;
  }

  private record(key: string, version: string): void {
    this.versions.set(key, version);
    this.feed.push({ key, value: this.value(key), version });
  }

  import(rows: ExportRow[], version: string): void {
    const after = reimport({ name: 'import', copies: [...this.copies.values()], export: rows });
    this.copies = new Map(Object.entries(after.copies));
    for (const key of after.writes) if (key.startsWith('occ/')) this.record(key, version);
  }

  push(events: Event[]): { outcome: 'APPLIED' | 'STALE'; current: Event }[] {
    return events.map((e) => {
      const held = this.versions.get(e.key);
      if (held !== undefined && compareVersion(e.version, held) <= 0) {
        return { outcome: 'STALE', current: { key: e.key, value: this.value(e.key), version: held } };
      }
      const [, occ, field] = e.key.split('/') as [string, string, 'head' | 'status'];
      const x = this.copies.get(occ) ?? { occ, head: '', status: null };
      if (field === 'head') x.head = e.value as string;
      else x.status = e.value as Copy['status'];
      this.copies.set(occ, x);
      this.record(e.key, e.version);
      return { outcome: 'APPLIED', current: e };
    });
  }
}

class Phone extends KeyedCrossingClient {
  private cursor = 0;

  pull(server: Server): void {
    for (; this.cursor < server.feed.length; this.cursor++) this.take(server.feed[this.cursor]!);
  }

  drain(server: Server): void {
    for (const r of server.push(this.push())) this.answer(r.outcome, r.current);
  }
}

const exportOf = (count: string): ExportRow[] => [{ line: 2, id: '1144', head: 'H1', status: 'Owned', count }];
const owned = (occ: string, ordinal: number): Copy => ({ occ, origin: { id: '1144', ordinal }, head: 'H1', status: 'owned', base: { head: 'H1', status: 'owned' } });
const ORDERS = [['Delta first', ['pull', 'drain']], ['pushed first', ['drain', 'pull']]] as const;

describe('end to end: an offline phone the import could not see', () => {
  for (const sold of ['o1', 'o2']) {
    for (const minted of ['10:00', '11:30']) {
      for (const [order, moves] of ORDERS) {
        it(`GR-Q3: ${sold} sold at ${minted}, ${order}: the import's removal is presented, and keeping the app's side leaves one owned and one former`, () => {
          const server = new Server([owned('o1', 1), owned('o2', 2)]);
          const phone = new Phone(SELF);
          phone.pull(server);
          phone.edit(`occ/${sold}/status`, 'former', at(minted));
          server.import(exportOf('1'), I2);
          for (const move of moves) phone[move](server);
          expect([...phone.crossings.keys()]).toEqual(['occ/o2/status']);
          phone.resolve('occ/o2/status', 'keep', at('12:00'));
          phone.drain(server);
          phone.pull(server);
          expect([...server.copies.values()].map((x) => x.status).sort()).toEqual(['former', 'owned']);
          for (const x of server.copies.values()) expect(phone.shows(`occ/${x.occ}/status`), x.occ).toEqual(x.status);
          expect(reimport({ name: 'again', copies: [...server.copies.values()], export: exportOf('1') }).writes).toEqual([]);
        });
      }
    }
  }

  for (const minted of ['10:00', '11:30']) {
    for (const [order, moves] of ORDERS) {
      it(`raise: a copy added in the app at ${minted}, ${order}: MFC's new copy is presented, and keeping the app's side leaves two owned`, () => {
        const server = new Server([owned('o1', 1)]);
        const phone = new Phone(SELF);
        phone.pull(server);
        phone.edit('occ/a1/head', 'H1', at(minted, 0));
        phone.edit('occ/a1/status', 'owned', at(minted, 1));
        server.import(exportOf('2'), I2);
        for (const move of moves) phone[move](server);
        expect([...phone.crossings.keys()]).toEqual(['occ/new:2/status']);
        phone.resolve('occ/new:2/status', 'keep', at('12:00'));
        phone.drain(server);
        phone.pull(server);
        expect([...server.copies.values()].filter((x) => x.status === 'owned').map((x) => x.occ).sort()).toEqual(['a1', 'o1']);
        for (const x of server.copies.values()) expect(phone.shows(`occ/${x.occ}/status`), x.occ).toEqual(x.status);
        expect(reimport({ name: 'again', copies: [...server.copies.values()], export: exportOf('2') }).writes).toEqual([]);
      });
    }
  }
});
