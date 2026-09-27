// Runs one golden/import-vectors.json scenario (serverScenarios or review) on the server model with a phone (P)
// and a tablet (T), and reports every step's observable result and the end state, for the test to compare.
import { Device } from './replica-client.js';
import { Server, type AlignAction, type Choice, type Field, type ImportCounters, type ImportResult, type ItemKind, type Json, type Row, type Switches } from './server-model.js';

export type Step =
  | { op: 'import'; t: number; rows: Row[]; by?: string; expect?: { review: unknown[]; applied: unknown[]; counters?: ImportCounters } }
  | { op: 'redirect'; head: string; survivor: string; t: number }
  | { op: 'edit'; dev: string; key: string; value: Json; t: number }
  | {
      op: 'resolve';
      dev: string;
      fig: string;
      choice: Choice;
      t: number;
      item?: ItemKind;
      /** Name the rev of another item of the figure (a client bug the server must answer STALE). */
      revOf?: ItemKind;
      copies?: Record<string, string>;
      fields?: Partial<Record<Field, 'app' | 'mfc'>>;
    }
  | { op: 'push'; dev: string; t: number; n?: number; expect?: { key: string; outcome: string }[] }
  | { op: 'pull'; dev: string; n?: number; expect?: { shows: Record<string, Json> } }
  | { op: 'replay'; dev: string }
  | { op: 'restart'; dev: string };

export interface ScenarioEnd {
  facets: Record<string, Json>;
  cards: string[];
  held: [string, string][];
  devices: Record<string, { shows: Record<string, Json>; cards: string[]; outbox: number }>;
}
export interface ReviewEnd {
  facets: Record<string, Json>;
  figure: Record<string, string>;
  held: Record<string, HeldCardView>;
  changes: Record<string, string>;
  align: Record<string, AlignAction[]>;
}
/** A held-edit card as the goldens pin it, read from its payload on the feed: each listed edit's key, value and reason, and `more` (the rev is opaque). */
export interface HeldCardView {
  held: { key: string; value: Json; reason: string }[];
  more?: number;
}
export function heldCardViews(s: Server): Record<string, HeldCardView> {
  const out: Record<string, HeldCardView> = {};
  for (const [k, [v]] of [...s.emitted].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!k.startsWith('imp/mfc/held/') || v === null) continue;
    const card = v as unknown as HeldCardView;
    out[k.slice('imp/mfc/held/'.length)] = { held: card.held.map((h) => ({ key: h.key, value: h.value, reason: h.reason })), ...(card.more === undefined ? {} : { more: card.more }) };
  }
  return out;
}
export interface Scenario {
  id?: string;
  name: string;
  rank?: Record<string, string>;
  steps: Step[];
}

const NAMES: Record<string, string> = { '1144#1': 'o1', '1144#2': 'o2', '900#1': 'p1', '555#1': 'q1' };
export const scenarioNamer = (r: string, k: number) => NAMES[`${r}#${k}`] ?? (r === '1144' ? `new:${k}` : `new${r}:${k}`);

/** The import's result as the golden pins it: revs and keys are opaque, so each item is its head, answers and actions. */
export function pinned(r: ImportResult): { review: unknown[]; applied: unknown[]; counters: ImportCounters } {
  return {
    review: r.review.map((g) => ({
      kind: g.kind,
      items: g.items.map((i) => (i.actions === undefined ? { head: i.head, answers: i.answers } : { head: i.head, actions: i.actions, answers: i.answers })),
      bulk: g.bulk,
    })),
    applied: r.applied.map((a) => ({ head: a.head, kind: a.kind, writes: a.writes, answers: a.answers })),
    counters: r.counters,
  };
}

export function runScenario(c: Scenario, switches: Switches = {}, client: { staging?: boolean; pullAfterImport?: boolean; resumeFromNext?: boolean } = {}) {
  const rank = c.rank !== undefined && Object.keys(c.rank).length > 0 ? (x: string) => c.rank![x] ?? x : undefined;
  const s = new Server({ namer: scenarioNamer, ...(rank === undefined ? {} : { rank }), switches });
  const devs: Record<string, Device> = { P: new Device(s, 'P', client), T: new Device(s, 'T', client) };
  const shows = (d: Device, keys: Iterable<string>) => Object.fromEntries([...keys].map((k) => [k, d.show(k)]));
  /** One entry per step with an `expect`, in step order: what the model gives for it. */
  const actual: unknown[] = [];
  for (const st of c.steps) {
    if (st.op === 'import') {
      // R1: the requester pushes its outbox first; R7: it pulls the import's transaction before it shows the review set
      if (st.by !== undefined) devs[st.by]!.push(st.t);
      const I = s.runImport(st.rows, st.t);
      if (st.expect !== undefined) actual.push(pinned(s.importResult(I)));
      if (st.by !== undefined && client.pullAfterImport !== false) devs[st.by]!.pull();
    } else if (st.op === 'redirect') s.redirect(st.head, st.survivor, st.t);
    else if (st.op === 'edit') devs[st.dev]!.edit(st.key, st.value, st.t);
    else if (st.op === 'resolve') devs[st.dev]!.answer(st.fig, st.choice, st.t, st.copies, st.fields, st.item, st.revOf ?? st.item);
    else if (st.op === 'push') {
      const keys = devs[st.dev]!.outbox.map((e) => e.key);
      const res = devs[st.dev]!.push(st.t, st.n).map((r, i) => ({ key: keys[i]!, outcome: r.outcome }));
      if (st.expect !== undefined) actual.push(res);
    } else if (st.op === 'pull') {
      devs[st.dev]!.pull(st.n);
      if (st.expect !== undefined) actual.push({ shows: shows(devs[st.dev]!, Object.keys(st.expect.shows)) });
    } else if (st.op === 'restart') devs[st.dev]!.restart();
    else devs[st.dev]!.replayFromEmpty();
  }
  const wanted = c.steps.flatMap((st) => ('expect' in st && st.expect !== undefined ? [st.expect] : []));
  // an import step that pins no counters is compared without them
  wanted.forEach((w, i) => {
    const a = actual[i] as { counters?: ImportCounters } | undefined;
    if (a !== undefined && typeof w === 'object' && w !== null && 'review' in w && !('counters' in w)) delete a.counters;
  });
  const facets = Object.fromEntries(
    [...s.emitted]
      .filter(([k, v]) => (k.startsWith('occ/') || k.startsWith('uf/')) && v[0] !== null)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, v[0]]),
  );
  const devices = Object.fromEntries(
    Object.entries(devs).map(([name, d]) => {
      const keys = new Set([...d.replica.keys()].filter((k) => k.startsWith('occ/') || k.startsWith('uf/')));
      for (const e of d.outbox) if (e.type === 'edit') keys.add(e.key);
      const view = Object.fromEntries([...keys].sort().flatMap((k) => (d.show(k) === null ? [] : [[k, d.show(k)]])));
      return [name, { shows: view, cards: d.cards(), outbox: d.outbox.length }];
    }),
  );
  const end: ScenarioEnd = { facets, cards: s.pending(), held: s.heldEdits(), devices };
  const review: ReviewEnd = { facets, figure: s.figureItems(), held: heldCardViews(s), changes: s.changeEntries(), align: s.alignEntries() };
  return { server: s, devices: devs, actual, wanted, end, review };
}
