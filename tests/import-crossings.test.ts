import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareVersion } from '../src/index.js';
import { pushOnConflict, type ConflictFacet } from './support/conflict-model.js';
import { KeyedCrossingClient, type Event, type Facet, type Value } from './support/crossing-model.js';
import { reimport, type Copy, type ExportRow, type ReimportResult } from './support/reimport-model.js';

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
    for (const topic of [/GR-Q3 offline \(S1\): the phone sold o1/, /sold o2/, /GR-Q3 \(S2\)/, /raise \(S1\)/, /raise \(S2\)/, /changes nothing/, /another copy's kind/, /another row/, /replay/, /another device/, /conflict raised .* before the import \(S1\)/, /conflict raised .* after the import \(S2\)/, /conflict the client had taken/,
      /crosses the cancel and does not close it/, /removal of o2 arriving first/, /wrong-variant fix offline \(S1\)/, /after the import ran \(S2\), pushed and APPLIED: the older removal of o2/, /re-pointed onto the row's figure/, /re-pointed off the figure crosses no removal/, /shows another kind crosses no addition/, /two MFC rows for one figure: the phone sold/, /replay from an empty cursor after the user resolved/, /after the push, before the echoes/, /another MFC row for the figure, set back offline to the kind MFC adds/]) {
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
// LWW pushes: every case the three-way cannot see (a sale, a cancel beside a kind change, a wrong-variant fix, an
// app copy, another MFC row for the figure), in every order of the import's writes, the phone's push and its
// Delta, is presented rather than silently applied, and ends as both sides meant once the user resolves it.
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

  /** The import writes a copy's origin and head before its status; the order of the statuses is unspecified. */
  import(rows: ExportRow[], version: string, statuses: 'up' | 'down' = 'up'): ReimportResult {
    const after = reimport({ name: 'import', copies: [...this.copies.values()], export: rows });
    this.copies = new Map(Object.entries(after.copies));
    const occ = after.writes.filter((k) => k.startsWith('occ/'));
    const status = occ.filter((k) => k.endsWith('/status'));
    for (const key of [...occ.filter((k) => !k.endsWith('/status')), ...(statuses === 'up' ? status : status.reverse())]) this.record(key, version);
    return after;
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

  statuses(): Record<string, Value> {
    return Object.fromEntries([...this.copies.values()].map((x) => [x.occ, x.status]));
  }

  owned(head?: string): string[] {
    return [...this.copies.values()].filter((x) => x.status === 'owned' && (head === undefined || x.head === head)).map((x) => x.occ).sort();
  }
}

class Phone extends KeyedCrossingClient {
  private cursor = 0;

  pull(server: Server): void {
    for (; this.cursor < server.feed.length; this.cursor++) this.take(server.feed[this.cursor]!);
  }

  /** Rule 7's recovery: a replay from an empty cursor, here up to `upTo` events. */
  replay(server: Server, upTo = server.feed.length): void {
    for (this.cursor = 0; this.cursor < upTo; this.cursor++) this.take(server.feed[this.cursor]!);
  }

  drain(server: Server): void {
    for (const r of server.push(this.push())) this.answer(r.outcome, r.current);
  }

  /** The phone shows every copy's status and head as the server holds them. */
  agrees(server: Server): void {
    for (const x of server.copies.values()) {
      expect(this.shows(`occ/${x.occ}/status`), `${x.occ} status`).toEqual(x.status);
      expect(this.shows(`occ/${x.occ}/head`), `${x.occ} head`).toEqual(x.head);
    }
  }
}

const copyOf = (occ: string, id: string, ordinal: number, status: Copy['status'], head = 'H1'): Copy => ({ occ, origin: { id, ordinal }, head, status, base: { head, status } });
const owned = (occ: string, ordinal: number): Copy => copyOf(occ, '1144', ordinal, 'owned');
const exportOf = (count: string): ExportRow[] => [{ line: 2, id: '1144', head: 'H1', status: 'Owned', count }];
const ORDERS = [['Delta first', ['pull', 'drain']], ['pushed first', ['drain', 'pull']]] as const;
const MINTED = ['10:00', '11:30'] as const;
const I3 = `2026-10-01T13:00:00.000000Z#0000000003#${vectors.devices.import}`;

describe('end to end: an offline phone the import could not see', () => {
  for (const sold of ['o1', 'o2']) {
    for (const minted of MINTED) {
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
          phone.agrees(server);
          expect(reimport({ name: 'again', copies: [...server.copies.values()], export: exportOf('1') }).writes).toEqual([]);
        });
      }
    }
  }

  for (const statuses of ['up', 'down'] as const) {
    for (const minted of MINTED) {
      for (const [order, moves] of ORDERS) {
        it(`a cancel beside a kind change: o1 cancelled at ${minted}, the import's ${statuses === 'up' ? 'owned on o1' : 'removal of o2'} first, ${order}: both copies are presented and neither is written until the user says`, () => {
          const server = new Server([copyOf('o1', '1144', 1, 'ordered'), copyOf('o2', '1144', 2, 'ordered')]);
          const phone = new Phone(SELF);
          phone.pull(server);
          phone.edit('occ/o1/status', null, at(minted));
          server.import(exportOf('1'), I2, statuses);
          for (const move of moves) phone[move](server);
          expect([...phone.crossings.keys()].sort()).toEqual(['occ/o1/status', 'occ/o2/status']);
          expect(phone.shows('occ/o2/status')).toBe('ordered');
          // The row's counts (the app: o2 ordered, o1 cancelled; MFC: one owned) say o2 arrived: the user keeps both
          // sides of the app and marks o2 owned.
          phone.resolve('occ/o1/status', 'keep', at('12:00'));
          phone.resolve('occ/o2/status', 'keep', at('12:01'));
          phone.edit('occ/o2/status', 'owned', at('12:02'));
          phone.drain(server);
          phone.pull(server);
          expect(server.statuses()).toEqual({ o1: null, o2: 'owned' });
          phone.agrees(server);
          expect(reimport({ name: 'again', copies: [...server.copies.values()], export: exportOf('1') }).writes).toEqual([]);
        });
      }
    }
  }

  for (const minted of MINTED) {
    for (const [order, moves] of ORDERS) {
      it(`a wrong-variant fix: o1 re-pointed at ${minted}, ${order}: the removal of o2 is presented, and keeping the app's side leaves o2 owned on the row's figure and o1 on the variant`, () => {
        const server = new Server([owned('o1', 1), owned('o2', 2)]);
        const phone = new Phone(SELF);
        phone.pull(server);
        phone.edit('occ/o1/head', 'H1b', at(minted));
        server.import(exportOf('1'), I2);
        for (const move of moves) phone[move](server);
        expect([...phone.crossings.keys()]).toEqual(['occ/o2/status']);
        phone.resolve('occ/o2/status', 'keep', at('12:00'));
        phone.drain(server);
        phone.pull(server);
        expect([server.owned('H1'), server.owned('H1b')]).toEqual([['o2'], ['o1']]);
        phone.agrees(server);
        expect(reimport({ name: 'again', copies: [...server.copies.values()], export: exportOf('1') }).writes).toEqual([]);
      });

      it(`raise: a copy added in the app at ${minted}, ${order}: MFC's new copy is presented, keeping the app's side leaves two owned, and when MFC then lowers the Count one is removed`, () => {
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
        expect(server.owned()).toEqual(['a1', 'o1']);
        phone.agrees(server);
        expect(reimport({ name: 'again', copies: [...server.copies.values()], export: exportOf('2') }).writes).toEqual([]);
        server.import(exportOf('1'), I3);
        phone.pull(server);
        expect(server.owned()).toEqual(['a1']);
        expect([...phone.crossings.keys()]).toEqual([]);
        phone.agrees(server);
      });

      it(`raise: an app copy re-pointed onto the figure at ${minted}, ${order}: MFC's new copy is presented, keeping the app's side leaves two owned, and when MFC then lowers the Count one is removed`, () => {
        const server = new Server([owned('o1', 1), { occ: 'a1', head: 'H1b', status: 'owned' }]);
        const phone = new Phone(SELF);
        phone.pull(server);
        phone.edit('occ/a1/head', 'H1', at(minted));
        server.import(exportOf('2'), I2);
        for (const move of moves) phone[move](server);
        expect([...phone.crossings.keys()]).toEqual(['occ/new:2/status']);
        phone.resolve('occ/new:2/status', 'keep', at('12:00'));
        phone.drain(server);
        phone.pull(server);
        expect(server.owned('H1')).toEqual(['a1', 'o1']);
        phone.agrees(server);
        expect(reimport({ name: 'again', copies: [...server.copies.values()], export: exportOf('2') }).writes).toEqual([]);
        server.import(exportOf('1'), I3);
        phone.pull(server);
        expect(server.owned()).toEqual(['a1']);
        phone.agrees(server);
      });

      it(`two MFC rows for one figure: row 900's copy sold at ${minted}, ${order}: the removal of row 1144's copy is presented, and keeping the app's side leaves one owned and one former`, () => {
        const server = new Server([copyOf('o1', '1144', 1, 'owned'), copyOf('p1', '900', 1, 'owned')]);
        const phone = new Phone(SELF);
        const rows: ExportRow[] = [{ line: 2, id: '1144', head: 'H1', status: 'Owned', count: '0' }, { line: 3, id: '900', head: 'H1', status: 'Owned', count: '1' }];
        phone.pull(server);
        phone.edit('occ/p1/status', 'former', at(minted));
        server.import(rows, I2);
        for (const move of moves) phone[move](server);
        expect([...phone.crossings.keys()]).toEqual(['occ/o1/status']);
        phone.resolve('occ/o1/status', 'keep', at('12:00'));
        phone.drain(server);
        phone.pull(server);
        expect(server.statuses()).toEqual({ o1: 'owned', p1: 'former' });
        phone.agrees(server);
        expect(reimport({ name: 'again', copies: [...server.copies.values()], export: rows }).writes).toEqual([]);
      });
    }
  }

  it('a replay from an empty cursor after the user resolved, before the push and after it before the echoes, crosses nothing again', () => {
    const server = new Server([owned('o1', 1), owned('o2', 2)]);
    const phone = new Phone(SELF);
    phone.pull(server);
    phone.edit('occ/o1/status', 'former', at('10:00'));
    server.import(exportOf('1'), I2);
    phone.pull(server);
    expect([...phone.crossings.keys()]).toEqual(['occ/o2/status']);
    phone.resolve('occ/o2/status', 'keep', at('12:00'));
    phone.replay(server);
    expect([...phone.crossings.keys()]).toEqual([]);
    const beforeEchoes = server.feed.length;
    phone.drain(server);
    phone.replay(server, beforeEchoes);
    expect([...phone.crossings.keys()]).toEqual([]);
    phone.pull(server);
    expect(server.statuses()).toEqual({ o1: 'former', o2: 'owned' });
    phone.agrees(server);
  });
});
