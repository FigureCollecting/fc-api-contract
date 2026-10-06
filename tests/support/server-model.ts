// import.proto's server-side import rules (THE SERVER DECIDES), written the simplest way so that
// golden/import-vectors.json is executed, not only stated: a port of the reviewed Python reference model
// (design A with the review's fixes F1 to F3, HELD decided once per push unit and sticky), plus Ross's review
// rules R1 to R8. The server keeps every input (device edits with their basis, imports, answers, spine
// redirects) and derives its state by REPLAY in canonical order; after every input it diffs that state against
// what it has emitted and emits the difference as ordinary feed events, one transaction per input. HELD is
// decided when a push arrives, never by a replay.
//
// Ids, heads and values are abstract (occ ids order by their names), versions are tuples
// [minute, counter, device, bump] compared element by element, and a feed position is a 1-based seq.

export type Kind = 'owned' | 'ordered' | 'wished';
export const KINDS: readonly Kind[] = ['owned', 'ordered', 'wished'];
export const OUT = 'out';
export type KindOrOut = Kind | typeof OUT;
export type Field = 'score' | 'note' | 'wishability';
export const FIELDS: readonly Field[] = ['score', 'note', 'wishability'];
const ARRIVAL_PAIRS: readonly (readonly [Kind, Kind])[] = [
  ['ordered', 'owned'],
  ['wished', 'ordered'],
  ['wished', 'owned'],
];

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Version = readonly [number, number, string, number];
export type Counts = Record<Kind, number>;

export interface Row {
  id: string;
  head: string;
  kind: Kind;
  count: number;
  fields: Partial<Record<Field, Json>>;
}

export const CARD = 'imp/mfc/figure/';

// ------------------------------------------------------------------ helpers
export function stable(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}
export const eq = (a: unknown, b: unknown): boolean => stable(a ?? null) === stable(b ?? null);

export function cmpVersion(a: Version, b: Version): number {
  for (let i = 0; i < 4; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
const gt = (a: Version, b: Version) => cmpVersion(a, b) > 0;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byNum = (a: string, b: string) => Number(a) - Number(b);
const zero = (): Counts => ({ owned: 0, ordered: 0, wished: 0 });

/** A structural write: at `ver`, but above the facet's current version. */
function bump(ver: Version, cur: Version | undefined): Version {
  if (cur === undefined || gt(ver, cur)) return ver;
  return [cur[0], cur[1], cur[2], cur[3] + 1];
}

// ------------------------------------------------------------------ inputs
export interface Edit {
  type: 'edit';
  dev: string;
  key: string;
  value: Json;
  version: Version;
  basis: number;
  arr: number;
  /** Decided once, when its push arrives (HELD), and final until its held-edit card is answered. */
  held: boolean;
  /** Its HELD unit: the push, and the copy (head, status, collection, disposal) or the facet. */
  unit?: string;
}
export interface Answer {
  type: 'answer';
  dev: string;
  fig: string;
  key: string;
  rev: string | null;
  choice: Choice;
  item: ItemKind;
  copies: Record<string, string>;
  fields: Partial<Record<Field, 'app' | 'mfc'>>;
  version: Version;
  basis: number;
  arr: number;
  lastSeq: Map<string, number>;
  accepted: boolean;
}
export interface Import {
  type: 'import';
  rows: Row[];
  /** 4.1: ids of unresolved rows (invalid_count, count_over_99, no_product); each keeps its row base. */
  keepIds: string[];
  t: number;
  n: number;
  version: Version;
  arr: number;
  lastSeq: Map<string, number>;
  /** The position of its marker imp/{site}/import (F1). */
  markerSeq: number;
  /** pref/{site}/import as the server held it when the import started. */
  policy: Policy;
  /** ImportMfcExportResponse's counters, as the response carried them. */
  counters?: ImportCounters;
}
export interface Redirect {
  type: 'redirect';
  head: string;
  survivor: string;
  arr: number;
  version: Version;
}
export type Input = Edit | Answer | Import | Redirect;
export type Choice = 'keep' | 'take' | 'per_copy' | 'undo' | 'dismiss';
/** Which of a figure's server-owned items an answer names: imp/mfc/figure|held|change|align/{head}. */
export type ItemKind = 'figure' | 'held' | 'change' | 'align';

export interface RowBase {
  head: string;
  kind: Kind;
  count: number;
  fields: Partial<Record<Field, Json>>;
}
/** A figure item (imp/{site}/figure/{S}): a conflict or a divergence. */
export interface Card {
  kind: 'conflict' | 'divergence';
  rev: string;
  exp: Map<string, Row>;
  expFields: string;
  B: Counts;
  M: Counts;
  /** What the import that raised the rev found, part by part (kept with the rev): keep and per_copy follow it. */
  comps: Record<string, unknown>;
  /** The import that raised this rev. */
  import: number;
  /** The MFC ids known to the import that raised it (its rows and row bases), for the projection. */
  known: string[];
  /** A conflict's MFC side as the import that last raised or kept it found it (the export's rows of S and the row bases it lacks): an import that finds it unchanged keeps the rev. */
  side?: string;
}
/** One MFC row of a figure as the import knows it (THE MFC PROJECTION): an export row, or a row base at Count 0. */
export interface MfcRow {
  id: string;
  kind: Kind;
  count: number;
  fields: Partial<Record<Field, Json>>;
}
/** A row as the align plan would have MFC hold it: kind null leaves the collection. */
export interface PlanRow {
  id: string;
  kind: Kind | null;
  count: number;
}
/** The parts of the projection: the rows' kinds and Counts, and each field. */
export type Part = 'counts' | Field;
export const PARTS: readonly Part[] = ['counts', ...FIELDS];
/** ACKNOWLEDGED: MFC's rows as they stand and, per part that differed, both sides as the user left them. */
export interface Ack {
  rows: MfcRow[];
  parts: Partial<Record<Part, string>>;
  /** The answer kept the app's side, so an align-MFC entry is kept. */
  align: boolean;
  list?: string;
  dismissed?: string;
  /** Mutant alignFromAck only: the app's live Counts and fields when it was acknowledged. */
  appAt?: { counts: Counts; fields: Record<Field, Json> };
}
/** ImportMfcExportResponse fields 3 to 17. */
export interface ImportCounters {
  added: number;
  moved: number;
  unchanged: number;
  removed: number;
  facets_written: number;
  kept_newer: number;
  occurrences_added: number;
  occurrences_status_changed: number;
  occurrences_removed: number;
  conflicts_raised: number;
  conflicts_pending: number;
  divergences_pending: number;
  align_pending: number;
  import_number: number;
}
type Stats = Omit<ImportCounters, 'facets_written' | 'conflicts_pending' | 'divergences_pending' | 'align_pending' | 'import_number'>;
/** A change entry (imp/{site}/change/{S}): what an import wrote, and its undo. */
export interface Change {
  kind: 'applied' | 'favor_app' | 'favor_mfc';
  rev: string;
  import: number;
  writes: { key: string; value: Json }[];
  undo: { key: string; value: Json }[];
  exp: Map<string, Row>;
  /** Mutant undoAckAtImport only: MFC's rows of the figure as the entry's import found them, its export's rows and the row bases of S that export lacked. */
  known: readonly string[];
  baseRows: Map<string, RowBase>;
  /** favor_app: the figure's bases as they stood before the settlement's realignment, and right after it: its undo puts back the ones the realignment moved. */
  pre?: Bases;
  post?: Bases;
}
/** A figure's bases (server-internal): each copy's, each row's and each head's field bases. */
export interface Bases {
  copies: [string, [string, KindOrOut] | undefined][];
  rows: [string, RowBase][];
  fields: [string, [Field, Json][]][];
}

type Namer = (rowId: string, ordinal: number) => string;
type Rank = (occ: string) => string;

// ------------------------------------------------------------------ state
export class Canon {
  facets = new Map<string, [Json, Version]>();
  rowBase = new Map<string, RowBase>();
  copyBase = new Map<string, [string, KindOrOut]>();
  fieldBase = new Map<string, Map<Field, Json>>();
  importRemoved = new Set<string>();
  /** Pending figure items by survivor. */
  conflicts = new Map<string, Card>();
  acks = new Map<string, Ack>();
  changes = new Map<string, Change>();
  /** Arrivals of held edits an answer has kept or dropped. */
  heldAnswered = new Set<number>();
  redirect = new Map<string, string>();
  decisions: [string, string, string][] = [];
  held: Edit[] = [];
  /** Per import number: what its decisions did (ImportMfcExportResponse). */
  stats = new Map<number, Stats>();

  constructor(
    readonly namer: Namer,
    readonly rank: Rank,
  ) {}

  surv(h: string): string {
    const seen = new Set<string>();
    let x = h;
    while (this.redirect.has(x) && !seen.has(x)) {
      seen.add(x);
      x = this.redirect.get(x)!;
    }
    return x;
  }
  val(key: string): Json {
    const f = this.facets.get(key);
    return f === undefined ? null : f[0];
  }
  ver(key: string): Version | undefined {
    return this.facets.get(key)?.[1];
  }
  set(key: string, value: Json, ver: Version): void {
    this.facets.set(key, [value, bump(ver, this.ver(key))]);
  }
  copies(): Set<string> {
    const out = new Set<string>();
    for (const k of this.facets.keys()) if (k.startsWith('occ/')) out.add(k.split('/')[1]!);
    for (const c of this.copyBase.keys()) out.add(c);
    return out;
  }
  head(c: string): string | null {
    return this.val(`occ/${c}/head`) as string | null;
  }
  status(c: string): string | null {
    return this.val(`occ/${c}/status`) as string | null;
  }
  curKind(c: string, S: string): KindOrOut {
    const h = this.head(c);
    const s = this.status(c);
    return h !== null && this.surv(h) === S && (KINDS as readonly unknown[]).includes(s) ? (s as Kind) : OUT;
  }
  baseKind(c: string, S: string): KindOrOut {
    const b = this.copyBase.get(c);
    return b !== undefined && b[1] !== OUT && this.surv(b[0]) === S ? b[1] : OUT;
  }
  byRank = (a: string, b: string): number => cmpStr(this.rank(a), this.rank(b));
  copiesRel(S: string): string[] {
    const out: string[] = [];
    for (const c of this.copies()) {
      const h = this.head(c);
      const b = this.copyBase.get(c);
      if ((h !== null && this.surv(h) === S) || (b !== undefined && this.surv(b[0]) === S)) out.push(c);
    }
    return out.sort(this.byRank);
  }
  hasOrigin(c: string): boolean {
    return this.val(`occ/${c}/origin`) !== null;
  }
  headsOf(S: string): Set<string> {
    const hs = new Set<string>();
    for (const k of this.facets.keys()) {
      if (k.startsWith('uf/')) {
        const h = k.split('/')[1]!;
        if (this.surv(h) === S) hs.add(h);
      }
    }
    for (const h of this.fieldBase.keys()) if (this.surv(h) === S) hs.add(h);
    return hs;
  }
  displayHead(S: string, f: Field): string | null {
    let best: [string, Version] | null = null;
    for (const h of [...this.headsOf(S)].sort()) {
      const fv = this.facets.get(`uf/${h}/${f}`);
      if (fv !== undefined && fv[0] !== null && (best === null || gt(fv[1], best[1]))) best = [h, fv[1]];
    }
    return best === null ? null : best[0];
  }
  displayField(S: string, f: Field): Json {
    const h = this.displayHead(S, f);
    return h === null ? null : this.val(`uf/${h}/${f}`);
  }
  baseField(S: string, f: Field): Json {
    const h = this.displayHead(S, f);
    if (h !== null && this.fieldBase.get(h)?.has(f)) return this.fieldBase.get(h)!.get(f)!;
    const cands = [...this.headsOf(S)].sort().filter((x) => this.fieldBase.get(x)?.has(f));
    return cands.length > 0 ? this.fieldBase.get(cands[0]!)!.get(f)! : null;
  }
  summary(S: string): { counts: Counts; copies: Record<string, string | null> } {
    const cs = this.copiesRel(S);
    const counts = zero();
    const copies: Record<string, string | null> = {};
    for (const c of cs) {
      const k = this.curKind(c, S);
      if (k !== OUT) counts[k]++;
      const h = this.head(c);
      copies[c] = h !== null && this.surv(h) === S ? this.status(c) : `moved:${h}`;
    }
    return { counts, copies };
  }
}

type Transition = readonly [KindOrOut, KindOrOut];
export function decompose(d: Counts): Transition[] {
  const x = { ...d };
  const out: Transition[] = [];
  for (const [a, b] of ARRIVAL_PAIRS) {
    const n = Math.min(Math.max(-x[a], 0), Math.max(x[b], 0));
    for (let i = 0; i < n; i++) out.push([a, b]);
    x[a] += n;
    x[b] -= n;
  }
  for (const k of KINDS) {
    for (let i = 0; i < -x[k]; i++) out.push([k, OUT]);
    for (let i = 0; i < x[k]; i++) out.push([OUT, k]);
  }
  return out;
}
const kindsOf = (ts: readonly Transition[]): Set<string> => {
  const s = new Set<string>();
  for (const [a, b] of ts) for (const k of [a, b]) if (k !== OUT) s.add(k);
  return s;
};

// ------------------------------------------------------------------ ops
export type Op =
  | ['status', string, Json]
  | ['create', string, string, number, string, Kind]
  | ['cbase', string, string, KindOrOut]
  | ['rowbase_set', string, RowBase]
  | ['rowbase_del', string]
  | ['field', string, Field, Json]
  | ['fieldtomb', string, Field]
  | ['fbase', string, Field, Json]
  | ['irem_add', string]
  | ['irem_del', string];

const filingKind = (v: Json): string | null => (typeof v === 'string' ? v.split('/')[0]! : null);

export function applyOps(st: Canon, ops: readonly Op[], ver: Version): void {
  for (const op of ops) {
    switch (op[0]) {
      case 'status': {
        const [, c, v] = op;
        st.set(`occ/${c}/status`, v, ver);
        const fil = st.val(`occ/${c}/collection`);
        if ((KINDS as readonly unknown[]).includes(v) && fil !== null && filingKind(fil) !== v) st.set(`occ/${c}/collection`, `${v as string}/default`, ver);
        break;
      }
      case 'create': {
        const [, c, rid, k, head, kind] = op;
        st.set(`occ/${c}/origin`, `${rid}#${k}`, ver);
        st.set(`occ/${c}/head`, head, ver);
        st.set(`occ/${c}/status`, kind, ver);
        break;
      }
      case 'cbase':
        st.copyBase.set(op[1], [op[2], op[3]]);
        break;
      case 'rowbase_set':
        st.rowBase.set(op[1], { ...op[2], fields: { ...op[2].fields } });
        break;
      case 'rowbase_del':
        st.rowBase.delete(op[1]);
        break;
      case 'field':
        st.set(`uf/${op[1]}/${op[2]}`, op[3], ver);
        break;
      case 'fieldtomb':
        for (const h of [...st.headsOf(op[1])].sort()) if (st.val(`uf/${h}/${op[2]}`) !== null) st.set(`uf/${h}/${op[2]}`, null, ver);
        break;
      case 'fbase': {
        const m = st.fieldBase.get(op[1]) ?? new Map<Field, Json>();
        m.set(op[2], op[3]);
        st.fieldBase.set(op[1], m);
        break;
      }
      case 'irem_add':
        st.importRemoved.add(op[1]);
        break;
      case 'irem_del':
        st.importRemoved.delete(op[1]);
        break;
    }
  }
}

/** A row's field values without the blank ones: a blank value is no value. */
export function statedFields(f: Row['fields']): Row['fields'] {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null)) as Row['fields'];
}
const copyRows = (m: Map<string, RowBase>) => new Map([...m].map(([id, b]) => [id, { ...b, fields: { ...b.fields } }]));
export function rowsFor(st: Canon, S: string, rows: readonly Row[]): Map<string, Row> {
  return new Map(rows.filter((r) => st.surv(r.head) === S).map((r) => [r.id, r]));
}
export function baseRowsFor(st: Canon, S: string): Map<string, RowBase> {
  return new Map([...st.rowBase].filter(([, b]) => st.surv(b.head) === S));
}
/** The bases of S as they stand. */
export function basesOf(st: Canon, S: string): Bases {
  return {
    copies: st.copiesRel(S).map((c) => [c, st.copyBase.get(c)]),
    rows: [...baseRowsFor(st, S)].map(([id, b]) => [id, { ...b, fields: { ...b.fields } }]),
    fields: [...st.fieldBase].filter(([h]) => st.surv(h) === S).sort(([a], [b]) => cmpStr(a, b)).map(([h, m]) => [h, [...m]]),
  };
}
/** Put the bases of S back as `b` has them: a copy, row or head `b` lacks has none. */
export function restoreBases(st: Canon, S: string, b: Bases): void {
  for (const c of new Set([...st.copiesRel(S), ...b.copies.map(([c]) => c)])) st.copyBase.delete(c);
  for (const [c, v] of b.copies) if (v !== undefined) st.copyBase.set(c, v);
  for (const id of baseRowsFor(st, S).keys()) st.rowBase.delete(id);
  for (const [id, r] of b.rows) st.rowBase.set(id, { ...r, fields: { ...r.fields } });
  for (const h of [...st.fieldBase.keys()]) if (st.surv(h) === S) st.fieldBase.delete(h);
  for (const [h, fs] of b.fields) st.fieldBase.set(h, new Map(fs));
}
/** Put back as `pre` has them the bases of S that differ between `pre` and `post` (what a realignment moved); the rest stay. */
export function restoreMoved(st: Canon, pre: Bases, post: Bases, sw: Switches = {}): void {
  const same = (a: unknown, b: unknown) => stable(a ?? null) === stable(b ?? null);
  const pc = new Map(pre.copies);
  const qc = new Map(post.copies);
  for (const c of new Set([...pc.keys(), ...qc.keys()])) {
    const a = pc.get(c);
    if (same(a, qc.get(c))) continue;
    if (a === undefined) st.copyBase.delete(c);
    else st.copyBase.set(c, a);
  }
  const pr = new Map(pre.rows);
  const qr = new Map(post.rows);
  for (const id of new Set([...pr.keys(), ...qr.keys()])) {
    const a = pr.get(id);
    if (same(a, qr.get(id))) continue;
    if (a === undefined) {
      if (!sw.undoKeepsNewRowBases) st.rowBase.delete(id);
    } else st.rowBase.set(id, { ...a, fields: { ...a.fields } });
  }
  const pf = new Map(pre.fields.map(([h, fs]) => [h, new Map(fs)]));
  const qf = new Map(post.fields.map(([h, fs]) => [h, new Map(fs)]));
  for (const h of new Set([...pf.keys(), ...qf.keys()])) {
    const a = pf.get(h) ?? new Map<Field, Json>();
    const b = qf.get(h) ?? new Map<Field, Json>();
    for (const f of new Set([...a.keys(), ...b.keys()])) {
      if (a.has(f) === b.has(f) && same(a.get(f), b.get(f))) continue;
      const m = st.fieldBase.get(h) ?? new Map<Field, Json>();
      if (a.has(f)) m.set(f, a.get(f)!);
      else m.delete(f);
      st.fieldBase.set(h, m);
    }
  }
}
function nextOrdinal(st: Canon, rid: string): number {
  const used = new Set<number>();
  for (const c of st.copies()) {
    const o = st.val(`occ/${c}/origin`);
    if (typeof o === 'string' && o.split('#')[0] === rid) used.add(Number(o.split('#')[1]));
  }
  let k = 1;
  while (used.has(k)) k++;
  return k;
}

// ------------------------------------------------------------------ the figure decision (import.proto 4.4)
export interface Decision {
  status: 'nochange' | 'apply' | 'conflict';
  ops: Op[];
  comps: Record<string, unknown>;
  B: Counts;
  M: Counts;
  A: Counts;
}

export function decide(st: Canon, S: string, exp: Map<string, Row>, sw: Switches): Decision {
  const baseRows = baseRowsFor(st, S);
  const B = zero();
  const M = zero();
  for (const b of baseRows.values()) B[b.kind] += b.count;
  for (const r of exp.values()) M[r.kind] += r.count;
  const cs = st.copiesRel(S);
  const cur = new Map(cs.map((c) => [c, st.curKind(c, S)]));
  const base = new Map(cs.map((c) => [c, st.baseKind(c, S)]));
  const A = zero();
  const assigned = zero();
  for (const c of cs) {
    const k = cur.get(c)!;
    if (k !== OUT) A[k]++;
    const b = base.get(c)!;
    if (b !== OUT) assigned[b]++;
  }
  const ph = { owned: B.owned - assigned.owned, ordered: B.ordered - assigned.ordered, wished: B.wished - assigned.wished };
  const ops: Op[] = [];
  const comps: Record<string, unknown> = {};

  if (eq(M, B)) comps.counts = 'nochange';
  else if (eq(A, M)) {
    comps.counts = 'alike';
    for (const c of cs) ops.push(['cbase', c, S, cur.get(c)!]);
  } else {
    const TM = decompose({ owned: M.owned - B.owned, ordered: M.ordered - B.ordered, wished: M.wished - B.wished });
    const TA = cs.filter((c) => base.get(c) !== cur.get(c)).map((c) => [c, base.get(c)!, cur.get(c)!] as const);
    const used = new Set<string>();
    const matched: (typeof TA)[number][] = [];
    const RM: Transition[] = [];
    for (const [x, y] of TM) {
      const hit = sw.M3 ? undefined : TA.find((t) => !used.has(t[0]) && t[1] === x && t[2] === y);
      if (hit !== undefined) {
        used.add(hit[0]);
        matched.push(hit);
      } else RM.push([x, y]);
    }
    const RA = TA.filter((t) => !used.has(t[0]));
    for (const [c, , y] of matched) ops.push(['cbase', c, S, y]);
    const raKinds = kindsOf(RA.map((t) => [t[1], t[2]] as const));
    if (RM.length === 0) comps.counts = RA.length === 0 ? 'matched' : 'matched+app-only';
    else if (RA.length > 0 && [...kindsOf(RM)].some((k) => raKinds.has(k)) && !sw.countsConflictAsApply) {
      comps.counts = 'conflict';
      comps.counts_detail = { mfc_unmatched: RM, app_unmatched: RA };
    } else {
      comps.counts = 'apply';
      ops.push(...materialize(st, S, exp, baseRows, RM, cs, cur, base, ph, RA, sw));
    }
  }

  // figure fields: change detected per row against the row's own base, the value at figure grain
  for (const f of FIELDS) {
    const ids = [...new Set([...exp.keys(), ...baseRows.keys()])].sort(byNum);
    const changed = new Map<string, Json>();
    for (const r of ids) {
      const mv = exp.get(r)?.fields[f] ?? null;
      const bv = sw.M6 ? st.baseField(S, f) : (baseRows.get(r)?.fields[f] ?? null);
      if (!eq(mv, bv)) changed.set(r, mv);
    }
    if (changed.size === 0) {
      comps[f] = 'nochange';
      continue;
    }
    const target = st.displayHead(S, f) ?? S;
    if (new Set([...changed.values()].map(stable)).size > 1) {
      comps[f] = 'conflict';
      comps[`${f}_detail`] = { rows_differ: Object.fromEntries(changed) };
      continue;
    }
    const v = [...changed.values()][0]!;
    const Af = st.displayField(S, f);
    const Bf = st.baseField(S, f);
    if (eq(Af, v)) {
      comps[f] = 'alike';
      ops.push(['fbase', target, f, v]);
    } else if (eq(Af, Bf)) {
      comps[f] = 'apply';
      ops.push(v === null ? ['fieldtomb', S, f] : ['field', target, f, v]);
      ops.push(['fbase', target, f, v]);
    } else {
      comps[f] = 'conflict';
      comps[`${f}_detail`] = { base: Bf, app: Af, mfc: v };
    }
  }

  const parts = Object.entries(comps).filter(([k]) => !k.endsWith('_detail'));
  const status: Decision['status'] = parts.some(([, v]) => v === 'conflict')
    ? 'conflict'
    : ops.length === 0 && parts.every(([, v]) => v === 'nochange')
      ? 'nochange'
      : 'apply';
  if (status !== 'conflict') {
    for (const [rid, r] of exp) ops.push(['rowbase_set', rid, { head: r.head, kind: r.kind, count: r.count, fields: { ...r.fields } }]);
    for (const rid of baseRows.keys()) if (!exp.has(rid)) ops.push(['rowbase_del', rid]);
  }
  return { status, ops, comps, B, M, A };
}

// 4.5 MATERIALIZE: MFC's unmatched transitions, on copies the app left unchanged.
function materialize(
  st: Canon,
  S: string,
  exp: Map<string, Row>,
  baseRows: Map<string, RowBase>,
  RM: readonly Transition[],
  cs: readonly string[],
  cur0: Map<string, KindOrOut>,
  base0: Map<string, KindOrOut>,
  ph0: Counts,
  RA: readonly (readonly [string, KindOrOut, KindOrOut])[],
  sw: Switches,
): Op[] {
  const ops: Op[] = [];
  const ra = new Set(RA.map((t) => t[0]));
  const cur = new Map(cur0);
  const base = new Map(base0);
  const ph = { ...ph0 };
  const untouched = (c: string) => sw.M8 || (!ra.has(c) && base.get(c) === cur.get(c));
  const originKey = (c: string): [number, string] => [st.hasOrigin(c) ? 1 : 0, st.rank(c)];
  for (const [x, y] of RM) {
    if (x !== OUT && y !== OUT) {
      if (ph[x] > 0) {
        ph[x]--;
        ph[y]++;
        continue;
      }
      const c = cs.filter((c) => untouched(c) && cur.get(c) === x).sort(st.byRank)[0]!;
      ops.push(['status', c, y], ['cbase', c, S, y]);
      cur.set(c, y);
      base.set(c, y);
    } else if (y === OUT) {
      const k = x as Kind;
      if (ph[k] > 0) {
        ph[k]--;
        continue;
      }
      const cands = cs.filter((c) => untouched(c) && cur.get(c) === k);
      const c = cands.reduce((best, c) => {
        const [a, b] = [originKey(c), originKey(best)];
        return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? c : best;
      });
      ops.push(['status', c, null], ['cbase', c, S, OUT], ['irem_add', c]);
      cur.set(c, OUT);
      base.set(c, OUT);
    } else {
      const k = y as Kind;
      const cands = cs.filter(
        (c) => untouched(c) && cur.get(c) === OUT && st.importRemoved.has(c) && st.head(c) !== null && st.surv(st.head(c)!) === S && st.status(c) === null,
      );
      if (cands.length > 0) {
        const c = cands.sort(st.byRank)[0]!;
        ops.push(['status', c, k], ['cbase', c, S, k], ['irem_del', c]);
        cur.set(c, k);
        base.set(c, k);
      } else {
        const rows = [...exp.values()].filter((r) => r.kind === k).sort((a, b) => byNum(a.id, b.id));
        const made = (rid: string) => ops.filter((op) => op[0] === 'create' && op[2] === rid).length;
        // 4.5: the row's Count against its live copies of the kind, those created in this decision included
        const live = (rid: string) =>
          cs.filter((c) => cur.get(c) === k && (st.val(`occ/${c}/origin`) as string | null)?.split('#')[0] === rid).length;
        const deficit = (r: Row) => {
          if (!sw.baseCountRow) return r.count - live(r.id) - made(r.id);
          const b = baseRows.get(r.id);
          return r.count - (b !== undefined && b.kind === k ? b.count : 0) - made(r.id);
        };
        const r = rows.find((r) => deficit(r) > 0) ?? rows[0]!;
        let n = nextOrdinal(st, r.id);
        for (const op of ops) if (op[0] === 'create' && op[2] === r.id) n = Math.max(n, op[3] + 1);
        const c = st.namer(r.id, n);
        ops.push(['create', c, r.id, n, r.head, k], ['cbase', c, S, k]);
      }
    }
  }
  return ops;
}

// ------------------------------------------------------------------ answers (import.proto 7)
export function mfcField(st: Canon, S: string, exp: Map<string, Row>, f: Field): Json {
  const baseRows = baseRowsFor(st, S);
  for (const r of [...new Set([...exp.keys(), ...baseRows.keys()])].sort(byNum)) {
    const mv = exp.get(r)?.fields[f] ?? null;
    const bv = baseRows.get(r)?.fields[f] ?? null;
    if (!eq(mv, bv)) return mv;
  }
  const rows = [...exp.values()].sort((a, b) => byNum(a.id, b.id));
  return rows.length > 0 ? (rows[0]!.fields[f] ?? null) : null;
}

export function answerOps(
  st: Canon,
  S: string,
  exp: Map<string, Row>,
  choice: Choice,
  sw: Switches,
  copies: Record<string, string> = {},
  fields: Partial<Record<Field, 'app' | 'mfc'>> = {},
  disputed?: Record<string, unknown>,
): Op[] {
  const d = decide(st, S, exp, sw);
  // keep and per_copy: the parts the conflict's rev lists as disputed (the raising decision), not the figure decided again
  const card = sw.keepRedecides || disputed === undefined ? d.comps : disputed;
  const M = d.M;
  const cs = st.copiesRel(S);
  const ops: Op[] = [];
  const fieldWrite = (f: Field) => {
    const v = mfcField(st, S, exp, f);
    ops.push(v === null ? ['fieldtomb', S, f] : ['field', st.displayHead(S, f) ?? S, f, v]);
  };
  if (choice === 'take') {
    const cur = new Map(cs.map((c) => [c, st.curKind(c, S)]));
    const tracked = sw.M4 ? [...cs] : cs.filter((c) => st.baseKind(c, S) !== OUT);
    const L: Record<Kind, string[]> = { owned: [], ordered: [], wished: [] };
    for (const k of KINDS) L[k] = tracked.filter((c) => cur.get(c) === k).sort(st.byRank);
    const sur = { owned: L.owned.length - M.owned, ordered: L.ordered.length - M.ordered, wished: L.wished.length - M.wished };
    const pairs: [Kind, Kind][] = [...ARRIVAL_PAIRS.map((p) => [p[0], p[1]] as [Kind, Kind]), ['owned', 'ordered'], ['owned', 'wished'], ['ordered', 'wished']];
    for (const [x, y] of pairs) {
      while (sur[x] > 0 && sur[y] < 0) {
        const c = L[x].shift()!;
        ops.push(['status', c, y]);
        L[y].push(c);
        sur[x]--;
        sur[y]++;
      }
    }
    for (const k of KINDS) {
      while (sur[k] > 0) {
        const c = L[k].reduce((best, c) => {
          const a: [number, string] = [st.hasOrigin(c) && !sw.takeRemovesByIdOnly ? 1 : 0, st.rank(c)];
          const b: [number, string] = [st.hasOrigin(best) && !sw.takeRemovesByIdOnly ? 1 : 0, st.rank(best)];
          return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? c : best;
        });
        L[k].splice(L[k].indexOf(c), 1);
        ops.push(['status', c, null]);
        sur[k]--;
      }
    }
    const touched = new Set<string>();
    const trackedSet = new Set(tracked);
    for (const k of KINDS) {
      while (sur[k] < 0) {
        const outs = cs.filter(
          (c) => cur.get(c) === OUT && !touched.has(c) && st.head(c) !== null && st.surv(st.head(c)!) === S && (trackedSet.has(c) || st.importRemoved.has(c)),
        );
        outs.sort((a, b) => {
          const ka: [number, number, string] = [trackedSet.has(a) ? 0 : 1, st.baseKind(a, S) !== k ? 1 : 0, st.rank(a)];
          const kb: [number, number, string] = [trackedSet.has(b) ? 0 : 1, st.baseKind(b, S) !== k ? 1 : 0, st.rank(b)];
          return ka[0] - kb[0] || ka[1] - kb[1] || cmpStr(ka[2], kb[2]);
        });
        if (outs.length > 0) {
          ops.push(['status', outs[0]!, k]);
          touched.add(outs[0]!);
        } else {
          const r = [...exp.values()].filter((r) => r.kind === k).sort((a, b) => byNum(a.id, b.id))[0]!;
          const n = nextOrdinal(st, r.id) + ops.filter((op) => op[0] === 'create' && op[2] === r.id).length;
          ops.push(['create', st.namer(r.id, n), r.id, n, r.head, k]);
        }
        sur[k]++;
      }
    }
    for (const f of FIELDS) if (d.comps[f] === 'apply' || d.comps[f] === 'conflict') fieldWrite(f);
  } else {
    // a disputed part stays the app's (per_copy: as it lists). A part the rev found only MFC changed is applied where
    // the app has not changed it since: decided again, it is still MFC's change alone. Any other part stays as the app has it.
    const byRev = (p: Part): boolean => (sw.keepRedecidesUndisputed ? card[p] !== 'conflict' : card[p] === 'apply');
    const mfcOnly = (p: Part): boolean => byRev(p) && (d.comps[p] === 'apply' || (sw.keepByRevAlone === true && card[p] === 'apply'));
    if (mfcOnly('counts')) {
      // mutant keepByRevAlone: MFC's transitions on the copies the app left unchanged, though the app has changed the counts since
      let dc = d;
      if (d.comps.counts !== 'apply')
        try {
          dc = decide(st, S, exp, { ...sw, countsConflictAsApply: true });
        } catch {
          dc = d;
        }
      const kinds = sw.keepLeavesImportMark ? ['status', 'create'] : ['status', 'create', 'irem_add', 'irem_del'];
      ops.push(...dc.ops.filter((op) => kinds.includes(op[0])));
    }
    for (const [c, v] of Object.entries(copies)) ops.push(['status', c, v === 'removed' ? null : v]);
    const fcard = sw.keepRedecidesFields || sw.perCopyRedecides ? d.comps : card;
    for (const f of FIELDS) if (fcard[f] === 'conflict' ? (fields[f] ?? 'app') === 'mfc' : sw.keepRedecidesFields ? d.comps[f] === 'apply' : mfcOnly(f)) fieldWrite(f);
  }
  return ops;
}

/** 7.5: after any answer the bases describe MFC's side. */
export function realign(st: Canon, S: string, exp: Map<string, Row>): Op[] {
  const ops: Op[] = [];
  const M = zero();
  for (const r of exp.values()) M[r.kind] += r.count;
  const cs = st.copiesRel(S);
  for (const k of KINDS) {
    const live = cs.filter((c) => st.curKind(c, S) === k).sort(st.byRank);
    live.forEach((c, i) => ops.push(['cbase', c, S, i < M[k] ? k : OUT]));
  }
  for (const c of cs) if (st.curKind(c, S) === OUT) ops.push(['cbase', c, S, OUT]);
  const baseRows = baseRowsFor(st, S);
  for (const [rid, r] of exp) ops.push(['rowbase_set', rid, { head: r.head, kind: r.kind, count: r.count, fields: { ...r.fields } }]);
  for (const rid of baseRows.keys()) if (!exp.has(rid)) ops.push(['rowbase_del', rid]);
  for (const f of FIELDS) ops.push(['fbase', st.displayHead(S, f) ?? S, f, mfcField(st, S, exp, f)]);
  return ops;
}

// ------------------------------------------------------------------ switches (mutants)
/** Each switch removes one rule; the goldens and the property test must then fail. */
export interface Switches {
  /** M1: every edit at its arrival position (no late placement). */
  M1?: boolean;
  /** M2: an edit is late by its version, not its basis. */
  M2?: boolean;
  /** M3: no transition matching. */
  M3?: boolean;
  /** M4: take also moves app-only copies. */
  M4?: boolean;
  /** M5: heads compared as strings (no redirect chain). */
  M5?: boolean;
  /** M6: a field change judged at figure grain. */
  M6?: boolean;
  /** M7: a knowing edit never closes a pending conflict. */
  M7?: boolean;
  /** M8: materialize may pick a copy the app changed. */
  M8?: boolean;
  /** M9: an answer accepted whatever revision it names. */
  M9?: boolean;
  /** F1 off: no marker; a frame only for a figure an import wrote to. */
  noMarker?: boolean;
  /** F3 off: no hold on reaction and none on a revised result. */
  noHold?: boolean;
  /** F3 (i) without its "would change the import's result" test. */
  holdWithoutRelevance?: boolean;
  /** F3 (i) without its "arrived before the late edit, or in its push" test. */
  holdWithoutArrivedBefore?: boolean;
  /** 5.4 as the designer's model had it: any edit whose basis precedes an answer is held. */
  broadHold?: boolean;
  /** 4.5 as the designer's model had it: a new copy's row by base Count. */
  baseCountRow?: boolean;
  /** R2 off: every kind of the app's copies is compared with MFC. */
  projectAllKinds?: boolean;
  /** R4 off: acknowledgements not kept. */
  noAck?: boolean;
  /** R5 off: a FAVOR preference applied to a change only MFC made too. */
  favorAll?: boolean;
  /** R8 off: a dismissed align-MFC entry shown again. */
  forgetDismiss?: boolean;
  /** R8 off: a divergence raised for a figure with no MFC id. */
  divergeWithoutId?: boolean;
  /** HELD not sticky: the relevance replay resets every other edit's hold (round 5's model). */
  heldNotSticky?: boolean;
  /** HELD per edit, not per unit: a copy's head, status and disposal of one push decided apart. */
  heldPerEdit?: boolean;
  /** F3 (i) broad: any knowing edit to a copy of S is a reaction, whatever it acts on. */
  broadReaction?: boolean;
  /** HELD (iii) counts only answers to a figure item. */
  answerHoldFigureOnly?: boolean;
  /** HELD (iii) without its relevance test: every late edit after an answer is held. */
  answerHoldWithoutRelevance?: boolean;
  /** A held-edit card lists every held edit, past the schema's 16. */
  heldNoOverflow?: boolean;
  /** An answer routed by its rev alone, whatever item it names. */
  ignoreItem?: boolean;
  /** A spine merge leaves the merged heads' items in place. */
  mergeKeepsItems?: boolean;
  /** An align-MFC entry built from the acknowledged snapshot, not the app's current side. */
  alignFromAck?: boolean;
  /** An acknowledgement compared whole, not per part (a partial catch-up re-opens it). */
  wholeAck?: boolean;
  /** add_to_list for any sold copy, not only one of a row the entry lowers. */
  listAnySale?: boolean;
  /** The align plan gives up Counts by row number alone, ignoring copy origins. */
  alignIgnoresOrigin?: boolean;
  /** X5: an applied decision leaves a stale conflict item. */
  keepStaleItem?: boolean;
  /** X6: an absent row counts its base Count on MFC's side. */
  absentRowCountsBase?: boolean;
  /** X9: undo restores even when a written value has moved on. */
  undoIgnoresLaterEdits?: boolean;
  /** Round 6's model: every push's emissions are revisions for HELD (ii), an answer's included. */
  revisionsFromAnswers?: boolean;
  /** Round 6's model: items play no part in HELD (ii): a replay's change to S's items is no revision, and what a device saw is not asked. */
  revisionIgnoresItems?: boolean;
  /** Round 6's model: HELD (ii) holds any knowing edit made before a revision, a tag or a figure value included. */
  revisedHoldsAnyEdit?: boolean;
  /** Round 6's model: no item clause in a reaction: a status or head write made while S had an item, as its device saw it, is no reaction. */
  narrowReaction?: boolean;
  /** Round 6's model: closing a conflict on a knowing edit writes the decision's writes. */
  closeWrites?: boolean;
  /** A knowing edit closes a conflict whenever the decision no longer conflicts, even one that would write. */
  closeWhenNoConflict?: boolean;
  /** A knowing edit closes a conflict once MFC's changes are all in the app, the app's own changes aside. */
  closeWhenMfcInApp?: boolean;
  /** The conflict-close check runs for late edits too. */
  recheckLate?: boolean;
  /** Round 6's model: the relevance test leaves the unit's own copies out. */
  relevanceExcludesOwn?: boolean;
  /** Round 6's model: the relevance test compares raw status and head facets (a removed copy's head counts). */
  relevanceRawFacets?: boolean;
  /** HELD (iii) with its basis compared inclusively: a device that had applied the answer counts as before it. */
  answerBoundaryInclusive?: boolean;
  /** A held-edit card's keep applies the edits by LWW at their own versions, not as the answer's writes. */
  keepAtOwnVersion?: boolean;
  /** A held-edit card leaves out `more`. */
  heldNoMore?: boolean;
  /** Items compared by their whole payload, not their rev (a figure item re-showing the app's side counts as a change). */
  itemsByPayload?: boolean;
  /** Round 6's model: a divergence's rev is its content alone, so one raised again has its old rev. */
  divRevContentOnly?: boolean;
  /** Round 6's model: a divergence an import keeps still shows the MFC rows of the import that raised it. */
  divergenceKeepsOldRows?: boolean;
  /** Reaction clause (c) without its first half: an item the device saw pending that the two sides end differently is no reaction by itself. */
  noItemDiffClause?: boolean;
  /** Round 7's model: HELD (i) judges a reaction by the two placements' end states alone, so an answer that ended the item the device saw hides it. */
  answerHidesReaction?: boolean;
  /** Round 7's model: HELD (ii) has no revision point for a replay that changes nothing against S just before its push, and never asks what the device saw. */
  revisionFromPushStart?: boolean;
  /** Round 7's model: a revision is everything its push emitted, the push's answers and knowing edits included. */
  revisionWholePush?: boolean;
  /** A revision's change counts the replayed late edits' own writes too (a tag on the copy the replayed sale moved is a reaction). */
  revisionCountsOwn?: boolean;
  /** Reaction clause (b) dropped: a copy added after the import is a reaction only through the copies or items it touches. */
  noNewCopyReaction?: boolean;
  /** A pending divergence keeps its rev when an import finds other values. */
  divRevKeptOnNewValues?: boolean;
  /** A change entry's rev without its import: one raised again, identical, keeps the old rev. */
  changeRevWithoutImport?: boolean;
  /** A device that saw an item only after it ended (its tombstone) counts as having seen it. */
  sawEndedItem?: boolean;
  /** A push whose late edits are all HELD is still a revision. */
  heldLateIsRevision?: boolean;
  /** An undo of an applied or favor_mfc change realigns the bases. */
  undoRealigns?: boolean;
  /** Round 8's first cut: clause (c)'s second half judged over the whole replay, so an item an earlier import raised and I kept is given by both sides. */
  seenOverWholeReplay?: boolean;
  /** Round 8's first cut: HELD (ii) never judges a late edit, even one knowing for the revision's import. */
  skipLateInRevision?: boolean;
  /** Round 8's first cut: clause (b) (adds a copy) for every revision point, one whose change is empty included. */
  newCopyAnyRevision?: boolean;
  /** What a device saw read to the feed's head, not to its basis. */
  sawItemAtHead?: boolean;
  /** A favor_app or favor_mfc change entry's rev without its import: one raised again, identical, keeps the old rev. */
  favorRevWithoutImport?: boolean;
  /** An answer is STALE when a revision its device had not seen withdrew the item, even once a later replay gave it back at the same rev. */
  answerStaleAfterWithdrawal?: boolean;
  /** Round 8's model: a unit's placements put the push's later units before their import, as if not held, so two late units that each withdraw what a device reacted to excuse each other. */
  laterUnitsReplayed?: boolean;
  /** An item's revs recorded only after an import, not after every input: a rev the other side has pending only after a knowing edit or an answer counts as never pending. */
  pendingAtImportsOnly?: boolean;
  /** Round 8's model: keep (and per_copy) decide the figure again at the answer, so a disputed part a knowing edit brought back to its base takes MFC's side. */
  keepRedecides?: boolean;
  /** Round 8's model: the undo of a favor_app settlement takes against the realigned bases, so it finds MFC's Count met on tracked copies. */
  favorUndoOnRealigned?: boolean;
  /** Round 8's model: the undo of a favor_app settlement ends the acknowledgement, so the same export raises a divergence. */
  favorUndoEndsAck?: boolean;
  /** The undo of a favor_app settlement takes against the latest export (the row bases), not the entry's own export. */
  favorUndoAtLatestExport?: boolean;
  /** A held-edit card's keep writes edits that are not knowing: they never end a conflict whose sides they make agree. */
  heldKeepNotKnowing?: boolean;
  /** A held-edit card's rev ignores which edits it lists, so an answer to the card a device saw also answers edits that joined it since. */
  heldRevIgnoresEdits?: boolean;
  /** A tag or figure value is a unit by itself, not with the push's other edits of its key. */
  tagUnitPerEdit?: boolean;
  /** A revision leaves out every facet of a copy its late edits write, not only the facets they write. */
  ownByCopy?: boolean;
  // round 9, recheck 1
  /** An import that keeps a conflict's rev refreshes what the item holds, so keep follows what that import found, not the rev. */
  cardRefreshedAtImport?: boolean;
  /** Round 9's first cut: keep decides again every part the rev does not list as disputed (one the app made MFC's change on, then undid, takes MFC's side). */
  keepRedecidesUndisputed?: boolean;
  /** keep applies what the rev found only MFC changed though the app has changed that part since (MFC's transitions on the copies left unchanged, MFC's field value over the app's). */
  keepByRevAlone?: boolean;
  /** Internal to keepByRevAlone: decide the counts as MFC's change alone where they conflict. */
  countsConflictAsApply?: boolean;
  /** keep and per_copy decide the disputed fields again (only the counts follow the rev). */
  keepRedecidesFields?: boolean;
  /** What keep applies of MFC's changes leaves a copy's import-removed mark as it was. */
  keepLeavesImportMark?: boolean;
  /** take removes by the highest occ id alone, not a copy with an origin first. */
  takeRemovesByIdOnly?: boolean;
  /** The undo of a favor_app settlement puts back every base of the figure as it stood before the realignment, not only the ones the realignment moved. */
  undoRestoresAllBases?: boolean;
  /** A favor_app change entry shows the take against the realigned bases as its undo list (the undo itself unchanged). */
  favorShownOnRealigned?: boolean;
  /** The undo of a favor_app settlement leaves the bases as its take leaves them, with no realignment. */
  favorUndoNoRealign?: boolean;
  /** The undo of a favor_app settlement takes as a divergence's take does: every field MFC settled that the app shows otherwise too. */
  favorUndoTakeSettled?: boolean;
  /** The card's keep preview decides the figure again (the answer itself follows the rev). */
  previewRedecides?: boolean;
  /** The undo of a favor_app settlement leaves the base the realignment gave a row new to that export. */
  undoKeepsNewRowBases?: boolean;
  /** per_copy takes its field sides only for the fields that conflict when decided again, not for those the rev lists as disputed. */
  perCopyRedecides?: boolean;
  // round 9, recheck 2
  /** Round 9's model: an import keeps a conflict's rev when MFC's Counts summed per kind and its rows' field values are unchanged, so Count moved between two rows keeps it. */
  revByCountSum?: boolean;
  /** An import keeps a conflict's rev when the export's rows of the figure are unchanged, whatever row bases of it the export lacks. */
  revByExportRows?: boolean;
  /** A row base the export lacks is in a conflict's MFC side as a row of its kind at Count 0, so a row the export drops from Count 0 leaves the rev. */
  revByMfcRows?: boolean;
  /** A conflict's MFC side leaves out its rows' field values, so an import that finds MFC's score changed keeps the rev. */
  revIgnoresFields?: boolean;
  /** A conflict's MFC side includes each row's head, so a row the spine re-points between two heads of the figure gives a new rev. */
  revByRowHeads?: boolean;
  // contract-8 close-out, round 1
  /** F1 from the row bases the import left: a figure whose last row the export drops, and that the import writes nothing to, gets no frame. */
  frameAfterImport?: boolean;
  /** An export row's blank field (null) is kept as stated, apart from one it leaves out, so a conflict's rev tells them apart. */
  rowsKeepBlankFields?: boolean;
  // contract-8 close-out, fix round 1
  /** The undo of an applied or favor_mfc change acknowledges MFC's rows as the change's import found them, a row base it dropped at Count 0, not S's row bases as they stand at the undo. */
  undoAckAtImport?: boolean;
  /** The same, with the change's export rows and the row bases S has at the undo: a row a later import dropped from Count 0 is still one of MFC's rows. */
  undoAckExportRows?: boolean;
  // contract-8 close-out, fix round 2
  /** The undo of an applied or favor_mfc change leaves out of MFC's rows a row its import dropped, even when a later import that settled the figure listed it again. */
  undoAckLeavesDropped?: boolean;
  // contract-8 close-out h1
  /** A realigning answer or settlement, and a keep on a divergence, acknowledge MFC's rows as they stood before the answer's own base moves: a row the export dropped at Count 0. */
  ackBeforeRealign?: boolean;
  /** An import that finds a figure acknowledged at its values records MFC's rows as it found them: a row the export dropped at Count 0. */
  importAckRowsAsFound?: boolean;
  /** The undo of an applied or favor_mfc change acknowledges a row with the kind the change's export stated, where that export lists it, not its row base's. */
  undoAckKindFromExport?: boolean;
}

// ------------------------------------------------------------------ the server
export type Outcome = 'APPLIED' | 'STALE' | 'HELD';
export type ReviewKind = 'conflict' | 'divergence' | 'held_edits' | 'align_mfc';
export interface AlignAction {
  mfc_id: string;
  status?: { now?: Kind; should?: Kind };
  count?: { now?: number; should: number };
  score?: { now?: Json; should?: Json };
  note?: { now?: Json; should?: Json };
  wishability?: { now?: Json; should?: Json };
  add_to_list?: string;
}
export interface ReviewItem {
  key: string;
  head: string;
  rev: string;
  answers: Choice[];
  actions?: AlignAction[];
}
export interface ReviewGroup {
  kind: ReviewKind;
  items: ReviewItem[];
  bulk: Choice[];
}
export interface AppliedItem {
  key: string;
  head: string;
  rev: string;
  kind: 'applied' | 'favor_app' | 'favor_mfc';
  writes: { key: string; value: Json }[];
  answers: Choice[];
}
export interface ImportResult {
  review: ReviewGroup[];
  applied: AppliedItem[];
  counters: ImportCounters;
}
export interface PushResult {
  key: string;
  current: [Json, Version] | undefined;
  outcome: Outcome;
}
export interface FeedEvent {
  seq: number;
  key: string;
  value: Json;
  version: Version;
  /** The last event of its server transaction: on the wire, it carries commit_cursor (sync.proto rule 7). */
  last: boolean;
}
export type Pushable = Edit | Answer;
export interface Policy {
  import_policy: 'ASK' | 'FAVOR_APP' | 'FAVOR_MFC';
  disposition_list?: string;
}
type HeldReason = 'late_after_knowing' | 'made_on_revised_result' | 'after_answer';
/** Per item key: every rev one replay gave the item, pending at any point of it. */
/** Per item key: each rev the item was pending with between the inputs of a replay, and the last import applied while it was. */
type RevHist = Map<string, Map<string, number>>;
interface Revision {
  seq: number;
  copies: Set<string>;
  items: Set<string>;
  imp: Import | undefined;
  /** Item revs the replay before the push produced, and the replay with only its replayed late edits added (HELD (ii)). */
  before: RevHist;
  after: RevHist;
}
const ITEM_KINDS = ['figure', 'change', 'align'] as const;

export const ITEM = (kind: 'figure' | 'held' | 'change' | 'align', S: string) => `imp/mfc/${kind}/${S}`;
export const MARKER = 'imp/mfc/import';
export const PREF = 'pref/mfc/import';
const ANSWERS: Record<ReviewKind, { answers: Choice[]; bulk: Choice[] }> = {
  conflict: { answers: ['keep', 'take', 'per_copy'], bulk: ['keep', 'take'] },
  divergence: { answers: ['keep', 'take'], bulk: ['keep', 'take'] },
  held_edits: { answers: ['keep', 'take'], bulk: ['keep', 'take'] },
  align_mfc: { answers: ['dismiss'], bulk: ['dismiss'] },
};
const USER_WRITES = new Set(['status', 'create', 'field', 'fieldtomb']);
const isItemKey = (k: string) => k.startsWith('imp/');
/** An item's identity: its rev, or none. */
const revOf = (v: Json | undefined): string => (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? String(v.rev) : 'null');
/** A held-edit card lists at most this many edits (schemas/imp-held.schema.json). */
export const HELD_CAP = 16;
/** The facets of a copy that are one HELD unit within a push. */
const UNIT_FACETS = new Set(['head', 'status', 'collection', 'disposal']);
const unitKey = (key: string): string => {
  const p = key.split('/');
  return p[0] === 'occ' && p.length === 3 && UNIT_FACETS.has(p[2]!) ? `occ/${p[1]}` : key;
};

export class Server {
  readonly inputs: Input[] = [];
  readonly emitted = new Map<string, [Json, Version]>();
  readonly feed: FeedEvent[] = [];
  canon: Canon | undefined;
  nImports = 0;
  private readonly headHist = new Map<string, Set<string>>();
  /** Per push arrival: the feed length + 1 when it arrived. */
  private readonly arrSeq = new Map<number, number>();
  /**
   * Per figure: the REVISIONS of S (HELD (ii)): each push that replayed a late edit and so changed S, with its commit,
   * the copies whose live state it changed, whether it changed S's items, and the import the late edit was late for.
   */
  private readonly revisions = new Map<string, Revision[]>();
  /** The late edits the last canonical order placed before their import. */
  private placedLate = new Set<number>();
  /** Arrivals the relevance test places at their arrival, not before their import. */
  private force = new Set<number>();
  /** Arrivals a revision's replay leaves out: its push's answers and knowing edits (HELD (ii)). */
  private skip = new Set<number>();
  /** Per replayed state: every rev each item was pending with during that replay, and the last import applied while it was. */
  private readonly revHist = new WeakMap<Canon, RevHist>();
  /** Per replayed state: the item keys (figure item, change entry, align-MFC entry) it has written. */
  private readonly itemKeys = new WeakMap<Canon, Set<string>>();
  private readonly heldReason = new Map<number, HeldReason>();
  readonly namer: Namer;
  readonly rank: Rank;

  constructor(
    opts: { namer?: Namer; rank?: Rank; initial?: (st: Canon) => void; switches?: Switches } = {},
    readonly sw: Switches = opts.switches ?? {},
    private readonly initial = opts.initial,
  ) {
    this.namer = opts.namer ?? ((rid, k) => `${rid}#${k}`);
    this.rank = opts.rank ?? ((c) => c);
  }

  // ---------------------------------------------------------- placement
  figsOf(e: Pushable, st: Canon): Set<string> {
    const k = e.key;
    if (e.type === 'answer') return new Set([e.fig]);
    if (k.startsWith('uf/')) return new Set([st.surv(k.split('/')[1]!)]);
    if (!k.startsWith('occ/')) return new Set();
    const c = k.split('/')[1]!;
    const heads = new Set(this.headHist.get(c) ?? []);
    if (k.endsWith('/head') && typeof e.value === 'string' && e.value !== '') heads.add(e.value);
    // a copy's head can arrive in the same batch (a copy created offline)
    for (const i of this.inputs) if (i.type === 'edit' && i.key === `occ/${c}/head` && typeof i.value === 'string' && i.value !== '') heads.add(i.value);
    const b = st.copyBase.get(c);
    if (b !== undefined) heads.add(b[0]);
    return new Set([...heads].map((h) => st.surv(h)));
  }

  private lateFor(I: Import, e: Pushable, figs: Set<string>): boolean {
    if (this.sw.M2) return cmpVersion(e.version, I.version) < 0;
    return [...figs].some((f) => (I.lastSeq.get(f) ?? 0) > e.basis);
  }

  canonicalOrder(prev: Canon): Input[] {
    const anchored = new Map<number, Edit[]>();
    const placed = new Set<number>();
    for (const e of this.inputs) {
      // HELD is decided when the edit's push arrives (decideHolds), never here: a held edit is not replayed
      if (e.type !== 'edit' || e.held || this.force.has(e.arr) || this.skip.has(e.arr) || this.sw.M1) continue;
      const I = this.lates(e, prev)[0];
      if (I !== undefined) {
        anchored.set(I.arr, [...(anchored.get(I.arr) ?? []), e]);
        placed.add(e.arr);
      }
    }
    this.placedLate = placed;
    const order: Input[] = [];
    for (const i of this.inputs) {
      if (this.skip.has(i.arr)) continue;
      if (i.type === 'import') {
        order.push(...(anchored.get(i.arr) ?? []).sort((a, b) => a.arr - b.arr), i);
      } else if (i.type === 'edit') {
        if (!placed.has(i.arr) && !i.held) order.push(i);
      } else order.push(i);
    }
    return order;
  }

  /** The imports an edit is late for, earliest first (THE SERVER DECIDES, LATE EDIT). */
  private lates(e: Edit, st: Canon): Import[] {
    const figs = this.figsOf(e, st);
    return this.inputs.filter((I): I is Import => I.type === 'import' && I.arr < e.arr && this.lateFor(I, e, figs));
  }

  /** HELD, decided once per unit when a push arrives, in push order; final until the held-edit card is answered. */
  private decideHolds(items: readonly Pushable[], prev: Canon): void {
    const units = new Map<string, Edit[]>();
    const push = this.arrSeq.get(items[0]!.arr);
    for (const e of items) {
      if (e.type !== 'edit') continue;
      const u = `${push}:${this.sw.heldPerEdit || (this.sw.tagUnitPerEdit && unitKey(e.key) === e.key) ? `${e.arr}` : unitKey(e.key)}`;
      e.unit = u;
      units.set(u, [...(units.get(u) ?? []), e]);
    }
    const list = [...units.values()];
    list.forEach((U, i) => {
      // the push's later units stand at their arrival while this unit is judged
      const later = new Set(list.slice(i + 1).flatMap((V) => V.map((e) => e.arr)));
      const reason = this.holdReason(U, prev, false, later);
      for (const e of U) {
        e.held = reason !== null;
        if (reason !== null) this.heldReason.set(e.arr, reason);
      }
    });
  }

  /** Mutant holdWithoutArrivedBefore only: hold an earlier unit again on a reaction that arrived after it. */
  private redecide(prev: Canon): void {
    const units = new Map<string, Edit[]>();
    for (const e of this.inputs) if (e.type === 'edit' && e.unit !== undefined) units.set(e.unit, [...(units.get(e.unit) ?? []), e]);
    for (const U of units.values()) {
      if (U[0]!.held) continue;
      const reason = this.holdReason(U, prev, true);
      if (reason === null) continue;
      for (const e of U) {
        e.held = true;
        this.heldReason.set(e.arr, reason);
      }
    }
  }

  /** Why unit U is held (HELD (i) to (iii)), or null: it is replayed. */
  private holdReason(U: readonly Edit[], prev: Canon, allowLater: boolean, later: ReadonlySet<number> = new Set()): HeldReason | null {
    const figs = new Set(U.flatMap((e) => [...this.figsOf(e, prev)]));
    const first = U[0]!;
    const at = this.arrSeq.get(first.arr) ?? 1e9;
    const lates = new Map(U.map((e) => [e.arr, this.lates(e, prev)]));
    const late = U.filter((e) => lates.get(e.arr)!.length > 0);
    const answers = this.inputs.filter((r): r is Answer => r.type === 'answer' && r.arr < first.arr);
    const before = (r: Answer, basis: number) => [...figs].some((f) => (this.sw.answerBoundaryInclusive ? (r.lastSeq.get(f) ?? 0) >= basis && r.lastSeq.has(f) : (r.lastSeq.get(f) ?? 0) > basis));
    if (this.sw.broadHold === true && U.some((e) => answers.some((r) => before(r, e.basis)))) return 'after_answer';
    if (late.length > 0) {
      const I0 = late.map((e) => lates.get(e.arr)![0]!).sort((a, b) => a.arr - b.arr)[0]!;
      const basis = Math.min(...late.map((e) => e.basis));
      // (iii): made before an answer on S the server accepted
      const afterAnswer = answers.some((r) => before(r, basis));
      // (i): a knowing edit to S's copies that arrived before the unit or in its push
      const hold = !this.sw.noHold;
      const cands = !hold
        ? []
        : this.inputs.filter(
            (k): k is Edit =>
              k.type === 'edit' &&
              !U.includes(k) &&
              I0.arr < k.arr &&
              k.key.startsWith('occ/') &&
              k.basis < at &&
              (allowLater || this.sw.holdWithoutArrivedBefore === true || k.arr < first.arr || this.arrSeq.get(k.arr) === at) &&
              [...this.figsOf(k, prev)].some((f) => figs.has(f)) &&
              ![...figs].some((f) => (I0.lastSeq.get(f) ?? 0) > k.basis),
          );
      if (afterAnswer && this.sw.answerHoldWithoutRelevance === true) return 'after_answer';
      if (cands.length > 0 && this.sw.holdWithoutRelevance === true) return 'late_after_knowing';
      if (afterAnswer || cands.length > 0) {
        const { differs, copies, items, hist } = this.relevant(U, figs, later);
        if (differs && afterAnswer) return 'after_answer';
        const reaction = (k: Edit) => this.sw.broadReaction === true || this.reacts(k, copies, items, I0);
        if (differs && cands.some(reaction)) return 'late_after_knowing';
        // a status or head write made while its device saw an item of S, by rev, that the placement at arrival produces
        // and the placement before I never does, whatever an answer has done to that item since
        if (!this.sw.answerHidesReaction && !this.sw.narrowReaction && cands.some((k) => this.sawWithdrawn(k, figs, hist[1], hist[0], I0))) return 'late_after_knowing';
      }
    }
    // (ii): an edit made after a revision's import (knowing for it, whether or not late for a later import) and before
    // that revision, which its device had not seen, when it reacts to the revision
    if (!this.sw.noHold)
      for (const e of U) {
        const Le = lates.get(e.arr)!;
        if (Le.length > 0 && this.sw.skipLateInRevision) continue;
        for (const f of this.figsOf(e, prev))
          for (const R of this.revisions.get(f) ?? []) {
            if (!(e.basis < R.seq && R.seq < at)) continue;
            // an edit late for the revision's own import is (i)'s
            if (Le.length > 0 && (R.imp === undefined || Le.includes(R.imp))) continue;
            // a copy added reacts only to a revision that changes S's live copies or items
            const bImp = this.sw.newCopyAnyRevision || R.copies.size + R.items.size > 0 ? R.imp : undefined;
            if (this.sw.revisedHoldsAnyEdit || this.reacts(e, R.copies, R.items, bImp)) return 'made_on_revised_result';
            // measured from S as the device saw it: an item it saw that S before the revision had pending from the
            // revision's import on and the revision withdraws
            if (!this.sw.revisionFromPushStart && !this.sw.narrowReaction && !this.sw.revisionIgnoresItems && this.sawWithdrawn(e, [f], R.before, R.after, R.imp)) return 'made_on_revised_result';
          }
      }
    return null;
  }

  /**
   * A REACTION (HELD (i) and (ii)): the edit writes a copy whose live state the two placements (or the revision) leave
   * different; or adds a copy to S (writes the head or status of a copy that had no head when the import ran); or writes
   * the status or head of a copy of S while S had an item, as the device saw it, that they leave different.
   */
  private reacts(k: Edit, copies: ReadonlySet<string>, items: ReadonlySet<string>, I: Import | undefined): boolean {
    if (!k.key.startsWith('occ/')) return false;
    const [, c, facet] = k.key.split('/');
    if (copies.has(c!)) return true;
    if (I !== undefined && !this.sw.noNewCopyReaction && this.newCopy(k, I)) return true;
    if (this.sw.narrowReaction || this.sw.noItemDiffClause || (facet !== 'status' && facet !== 'head')) return false;
    return this.sawItem(k.basis, items);
  }

  /** Did the device, at `basis`, have one of these items pending (a non-tombstone value)? */
  private sawItem(basis: number, keys: ReadonlySet<string>): boolean {
    if (keys.size === 0) return false;
    const last = new Map<string, Json>();
    for (const ev of this.feed) {
      if (ev.seq > basis && !this.sw.sawItemAtHead) break;
      if (keys.has(ev.key)) last.set(ev.key, ev.value);
    }
    return this.sw.sawEndedItem ? last.size > 0 : [...last.values()].some((v) => v !== null);
  }

  /** The rev of item K as a device saw it at `basis` ('null': none pending). */
  private seenRev(basis: number, K: string): string {
    let v: Json = null;
    for (const ev of this.feed) {
      if (ev.seq > basis) break;
      if (ev.key === K) v = ev.value;
    }
    return revOf(v);
  }

  /**
   * A REACTION to a withdrawn item (HELD (i) and (ii)): a status or head write to a copy made while its device saw an
   * item of S, by rev, that one replay (`produced`, where the result stands) has pending at or after the result's import
   * I (I raised it or kept it) and the other (`never`) never has pending at or after I.
   */
  private sawWithdrawn(k: Edit, figs: Iterable<string>, produced: RevHist, never: RevHist, I: Import | undefined): boolean {
    if (!k.key.startsWith('occ/')) return false;
    const facet = k.key.split('/')[2];
    if (facet !== 'status' && facet !== 'head') return false;
    const from = I === undefined || this.sw.seenOverWholeReplay ? 0 : I.n;
    const pendingFrom = (h: RevHist, K: string, r: string) => (h.get(K)?.get(r) ?? -1) >= from;
    for (const f of figs)
      for (const kind of ITEM_KINDS) {
        const K = ITEM(kind, f);
        const r = this.seenRev(k.basis, K);
        if (r !== 'null' && pendingFrom(produced, K, r) && !pendingFrom(never, K, r)) return true;
      }
    return false;
  }

  /** The reaction wrote the head or status of a copy that had no head when I0 ran: a copy added after the import. */
  private newCopy(k: Edit, I0: Import): boolean {
    const [, c, facet] = k.key.split('/');
    if (facet !== 'head' && facet !== 'status') return false;
    const seqs = this.feed.filter((ev) => ev.key === `occ/${c}/head` && ev.value !== null).map((ev) => ev.seq);
    return seqs.length === 0 || Math.min(...seqs) > I0.markerSeq;
  }

  /**
   * THE RELEVANCE TEST (HELD (i) and (iii)): would placing the unit's late edits before their import change S's live
   * copies (each copy's survivor and kind, or out; the unit's own copies included) or S's items? Every earlier input
   * keeps its decision, and the push's later units stand at their arrival, as the result stands, so two late units of
   * one push never excuse each other. Returns whether anything differs, the copies whose live state differs and the item
   * keys that differ.
   */
  private relevant(U: readonly Edit[], figs: Set<string>, later: ReadonlySet<number> = new Set()): { differs: boolean; copies: Set<string>; items: Set<string>; hist: [RevHist, RevHist] } {
    const saved = new Set(this.force);
    const stand = this.sw.laterUnitsReplayed ? [] : [...later];
    const own = new Set(U.map((e) => e.key));
    const ownCopies = new Set(U.filter((e) => e.key.startsWith('occ/')).map((e) => e.key.split('/')[1]!));
    // mutant heldNotSticky: round 5's relevance replay, which reset every other edit's hold
    if (this.sw.heldNotSticky) for (const e of this.inputs) if (e.type === 'edit' && !U.includes(e)) e.held = false;
    const out: Record<string, string>[] = [];
    const hist: RevHist[] = [];
    for (const atArrival of [false, true]) {
      this.force = new Set([...saved, ...stand, ...(atArrival ? U.map((e) => e.arr) : [])]);
      const st = this.replay();
      hist.push(this.revHist.get(st) ?? new Map());
      const view: Record<string, string> = {};
      const ofS = (c: string) => {
        const hs = new Set(this.headHist.get(c) ?? []);
        const h = st.head(c);
        if (h !== null) hs.add(h);
        return [...hs].some((x) => figs.has(st.surv(x)));
      };
      if (this.sw.relevanceRawFacets) {
        for (const [k, [v]] of st.facets) {
          if (!k.startsWith('occ/') || own.has(k) || !['status', 'head'].includes(k.split('/').at(-1)!)) continue;
          if (ofS(k.split('/')[1]!)) view[k] = stable(v);
        }
      } else
        for (const c of st.copies()) {
          if ((this.sw.relevanceExcludesOwn && ownCopies.has(c)) || !ofS(c)) continue;
          const h = st.head(c);
          const s = st.status(c);
          view[`occ/${c}`] = h !== null && (KINDS as readonly unknown[]).includes(s) ? `${st.surv(h)}:${s as string}` : OUT;
        }
      // an item by its identity, its rev (or none): what the user is asked, not how the item shows the app's side now
      for (const f of figs)
        for (const kind of ['figure', 'change', 'align'] as const) view[ITEM(kind, f)] = this.sw.itemsByPayload ? stable(st.val(ITEM(kind, f))) : revOf(st.val(ITEM(kind, f)));
      out.push(view);
    }
    this.force = saved;
    const [a, b] = out as [Record<string, string>, Record<string, string>];
    const miss = (v: Record<string, string>, k: string) => v[k] ?? (k.startsWith('occ/') && !this.sw.relevanceRawFacets ? OUT : 'null');
    const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => miss(a, k) !== miss(b, k));
    return {
      differs: diff.length > 0,
      copies: new Set(diff.filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!)),
      items: new Set(diff.filter(isItemKey)),
      hist: hist as [RevHist, RevHist],
    };
  }

  // ---------------------------------------------------------- replay
  replay(): Canon {
    const st = new Canon(this.namer, this.rank);
    if (this.sw.M5) st.surv = (h: string) => h;
    this.initial?.(st);
    const prev = this.canon ?? st;
    const order = this.canonicalOrder(prev);
    const late = this.placedLate;
    let nImp = 0;
    for (const inp of order) {
      if (inp.type === 'edit') this.applyEdit(st, inp, !late.has(inp.arr));
      else if (inp.type === 'import') this.applyImport(st, inp);
      else if (inp.type === 'answer') this.applyAnswer(st, inp);
      else this.applyRedirect(st, inp);
      if (inp.type === 'import') nImp = inp.n;
      if (!this.sw.pendingAtImportsOnly || inp.type === 'import') this.recordPending(st, nImp);
    }
    st.held = this.inputs.filter((e): e is Edit => e.type === 'edit' && e.held);
    this.emitHeldCards(st);
    return st;
  }

  /** After each input of a replay: each pending item's rev, with the last import applied while it is pending (HELD, clause (c)). */
  private recordPending(st: Canon, nImp: number): void {
    const keys = this.itemKeys.get(st);
    if (keys === undefined) return;
    const m = this.revHist.get(st) ?? this.revHist.set(st, new Map()).get(st)!;
    for (const k of keys) {
      const v = st.val(k);
      if (v === null) continue;
      const revs = m.get(k) ?? m.set(k, new Map()).get(k)!;
      const r = revOf(v);
      revs.set(r, Math.max(revs.get(r) ?? 0, nImp));
    }
  }

  /** A spine merge: the items of the merged-away head and of its survivor end, and the next import decides the merged figure. */
  private applyRedirect(st: Canon, R: Redirect): void {
    const figs = new Set([st.surv(R.head), st.surv(R.survivor)]);
    st.redirect.set(R.head, R.survivor);
    if (this.sw.mergeKeepsItems) return;
    for (const f of [...figs].sort()) {
      st.conflicts.delete(f);
      st.changes.delete(f);
      st.acks.delete(f);
      this.emitItems(st, f, R.version);
    }
  }

  /** The writes a list of ops would make, without making them (a preview or an undo). */
  private writesOf(st: Canon, S: string, ops: readonly Op[]): { key: string; value: Json }[] {
    const out = new Map<string, Json>();
    for (const op of ops) {
      if (op[0] === 'status') {
        out.set(`occ/${op[1]}/status`, op[2]);
        const fil = st.val(`occ/${op[1]}/collection`);
        if ((KINDS as readonly unknown[]).includes(op[2]) && fil !== null && filingKind(fil) !== op[2]) out.set(`occ/${op[1]}/collection`, `${op[2] as string}/default`);
      } else if (op[0] === 'create') {
        out.set(`occ/${op[1]}/origin`, `${op[2]}#${op[3]}`);
        out.set(`occ/${op[1]}/head`, op[4]);
        out.set(`occ/${op[1]}/status`, op[5]);
      } else if (op[0] === 'field') out.set(`uf/${op[1]}/${op[2]}`, op[3]);
      else if (op[0] === 'fieldtomb') for (const h of [...st.headsOf(S)].sort()) if (st.val(`uf/${h}/${op[2]}`) !== null) out.set(`uf/${h}/${op[2]}`, null);
    }
    return [...out].sort(([a], [b]) => cmpStr(a, b)).map(([key, value]) => ({ key, value }));
  }

  /** A figure item's payload, as schemas/imp-figure.schema.json has it (abstract ids). */
  private figurePayload(st: Canon, S: string): Json {
    const cf = st.conflicts.get(S);
    if (cf === undefined) return null;
    const summ = st.summary(S);
    const counts = Object.fromEntries(KINDS.map((k) => [k, { base: cf.B[k], app: summ.counts[k], mfc: cf.M[k] }]));
    const fields = Object.fromEntries(
      FIELDS.map((f) => {
        const d = (cf.comps[`${f}_detail`] ?? {}) as { base?: Json; app?: Json; mfc?: Json };
        const x: Record<string, Json> = { status: (cf.comps[f] as string) ?? 'nochange' };
        const app = cf.kind === 'divergence' ? st.displayField(S, f) : (d.app ?? st.displayField(S, f));
        const mfc = cf.kind === 'divergence' ? st.baseField(S, f) : (d.mfc ?? mfcField(st, S, cf.exp, f));
        const base = d.base ?? st.baseField(S, f);
        if (base !== null) x.base = base;
        if (app !== null) x.app = app;
        if (mfc !== null) x.mfc = mfc;
        return [f, x];
      }),
    );
    const copies = st.copiesRel(S).map((c) => {
      const s = st.curKind(c, S) === OUT && st.status(c) !== 'former' ? null : st.status(c);
      return { occ: c, ...(s === null ? {} : { status: s }), tracked: st.baseKind(c, S) !== OUT };
    });
    const mfcRows = [...cf.exp.values()].sort((a, b) => byNum(a.id, b.id)).map((r) => ({ mfc_id: r.id, kind: r.kind, count: r.count }));
    const keep = cf.kind === 'conflict' ? this.writesOf(st, S, answerOps(st, S, cf.exp, 'keep', this.sw, {}, {}, this.sw.previewRedecides ? undefined : cf.comps)) : [];
    const takeOps = cf.kind === 'divergence' ? this.takeSettled(st, S, cf.exp) : answerOps(st, S, cf.exp, 'take', this.sw);
    const take = this.writesOf(st, S, takeOps);
    return JSON.parse(stable({ rev: cf.rev, kind: cf.kind, import: cf.import, counts, fields, copies, mfc_rows: mfcRows, preview: { keep, take } })) as Json;
  }

  /** Set a server-owned facet to `v` (null: tombstone), only when it changes. */
  private put(st: Canon, key: string, v: Json, ver: Version): void {
    if (ITEM_KINDS.some((kind) => key.startsWith(`imp/mfc/${kind}/`))) (this.itemKeys.get(st) ?? this.itemKeys.set(st, new Set()).get(st)!).add(key);
    if (eq(st.val(key), v)) return;
    if (v === null && !st.facets.has(key)) return;
    st.set(key, v, ver);
  }

  /** The figure item, change entry and align-MFC entry of S, as the state now has them. */
  private emitItems(st: Canon, S: string, ver: Version): void {
    this.put(st, ITEM('figure', S), this.figurePayload(st, S), ver);
    const ch = st.changes.get(S);
    this.put(st, ITEM('change', S), ch === undefined ? null : (JSON.parse(stable({ rev: ch.rev, kind: ch.kind, import: ch.import, writes: ch.writes, undo: ch.undo })) as Json), ver);
    const al = this.alignOf(st, S);
    this.put(st, ITEM('align', S), al === null ? null : (JSON.parse(stable(al)) as Json), ver);
  }

  /** take after a settlement (a divergence, a FAVOR_APP undo): MFC's counts, and every field MFC settled that the app shows otherwise. */
  private takeSettled(st: Canon, S: string, exp: Map<string, Row>): Op[] {
    const ops = answerOps(st, S, exp, 'take', this.sw);
    const written = new Set(ops.filter((op) => op[0] === 'field' || op[0] === 'fieldtomb').map((op) => op[2]));
    for (const f of FIELDS) {
      const v = st.baseField(S, f);
      if (written.has(f) || eq(st.displayField(S, f), v)) continue;
      ops.push(v === null ? ['fieldtomb', S, f] : ['field', st.displayHead(S, f) ?? S, f, v]);
    }
    return ops;
  }

  // ---------------------------------------------------------- held edits (F3, 5.4)
  private heldOn(st: Canon, S: string, before: number): { listed: Edit[]; more: number } {
    const all = this.inputs.filter((e): e is Edit => e.type === 'edit' && e.held && e.arr < before && !st.heldAnswered.has(e.arr) && this.figsOf(e, st).has(S));
    if (this.sw.heldNoOverflow) return { listed: all, more: 0 };
    // the card lists whole units, oldest first, at most HELD_CAP edits; an answer to it answers those, then the next show
    const units = new Map<string, Edit[]>();
    for (const e of all) units.set(e.unit ?? `${e.arr}`, [...(units.get(e.unit ?? `${e.arr}`) ?? []), e]);
    const listed: Edit[] = [];
    for (const u of units.values()) {
      if (listed.length > 0 && listed.length + u.length > HELD_CAP) break;
      listed.push(...u);
    }
    return { listed, more: all.length - listed.length };
  }
  private heldRev = (es: readonly Edit[]) => (this.sw.heldRevIgnoresEdits ? `H:${es.length > 0}` : `H:${es.map((e) => e.arr).join(',')}`);

  private emitHeldCards(st: Canon): void {
    const held = this.inputs.filter((e): e is Edit => e.type === 'edit' && e.held && !st.heldAnswered.has(e.arr));
    const figs = new Set<string>();
    for (const e of held) for (const f of this.figsOf(e, st)) figs.add(f);
    for (const S of [...figs].sort()) {
      const { listed, more } = this.heldOn(st, S, Infinity);
      const ver = listed.map((e) => e.version).sort(cmpVersion).at(-1)!;
      const held_ = listed.map((e) => ({ key: e.key, value: e.value, version: e.version, reason: this.heldReason.get(e.arr) ?? 'after_answer' }));
      const payload = JSON.parse(stable({ rev: this.heldRev(listed), held: held_, ...(more > 0 && !this.sw.heldNoMore ? { more } : {}) })) as Json;
      this.put(st, ITEM('held', S), payload, ver);
    }
  }

  // ---------------------------------------------------------- the projection, acknowledgements, align-MFC (R2, R4, R8)
  /** MFC's rows of S (THE MFC PROJECTION): the export's rows, and each known row the export lacks at Count 0. */
  private mfcRows(exp: Map<string, Row>, known: readonly string[], baseRows: Map<string, RowBase>): MfcRow[] {
    return [...known].sort(byNum).map((id) => {
      const r = exp.get(id);
      if (r !== undefined) return { id, kind: r.kind, count: r.count, fields: { ...r.fields } };
      const b = baseRows.get(id);
      return { id, kind: b?.kind ?? ('owned' as Kind), count: this.sw.absentRowCountsBase ? (b?.count ?? 0) : 0, fields: {} };
    });
  }

  /** The app's live copies of S per kind, and its displayed fields. */
  private appNow(st: Canon, S: string): { counts: Counts; fields: Record<Field, Json> } {
    const counts = zero();
    for (const c of st.copiesRel(S)) {
      const k = st.curKind(c, S);
      if (k !== OUT) counts[k]++;
    }
    return { counts, fields: Object.fromEntries(FIELDS.map((f) => [f, st.displayField(S, f)])) as Record<Field, Json> };
  }

  /**
   * THE ALIGN PLAN (ALIGN-MFC): MFC's rows as they would hold the app's live copies. Per kind, the rows give up an
   * excess first where their Count is beyond their own live copies (by origin), most first, then the highest-numbered;
   * a row left with none leaves the collection. A kind the app has more of grows its lowest-numbered row, or takes the
   * lowest-numbered row out of the collection; what no row can take is richness MFC cannot express.
   */
  private plan(st: Canon, S: string, rows: readonly MfcRow[], T: Counts): PlanRow[] {
    const plan: PlanRow[] = rows.map((r) => ({ id: r.id, kind: r.count > 0 ? r.kind : null, count: r.count }));
    const own = (id: string, k: Kind) =>
      this.sw.alignIgnoresOrigin ? 0 : st.copiesRel(S).filter((c) => st.curKind(c, S) === k && (st.val(`occ/${c}/origin`) as string | null)?.split('#')[0] === id).length;
    for (const k of KINDS) {
      const of = plan.filter((p) => p.kind === k);
      let excess = of.reduce((n, p) => n + p.count, 0) - T[k];
      const surplus = (p: PlanRow) => Math.max(0, p.count - own(p.id, k));
      for (const p of [...of].sort((a, b) => surplus(b) - surplus(a) || byNum(b.id, a.id))) {
        const give = Math.min(Math.max(excess, 0), surplus(p));
        p.count -= give;
        excess -= give;
      }
      for (const p of [...of].sort((a, b) => byNum(b.id, a.id))) {
        const give = Math.min(Math.max(excess, 0), p.count);
        p.count -= give;
        excess -= give;
      }
      for (const p of of) if (p.count === 0) p.kind = null;
    }
    for (const k of KINDS) {
      const of = plan.filter((p) => p.kind === k);
      const need = T[k] - of.reduce((n, p) => n + p.count, 0);
      if (need <= 0) continue;
      const row = of[0] ?? plan.find((p) => p.kind === null);
      if (row === undefined) continue;
      row.kind = k;
      row.count = Math.min(99, row.count + need);
    }
    return plan;
  }

  /** Each part of the projection, MFC's side and the app's as MFC could state it (the plan); they differ exactly when ALIGN-MFC has an action. */
  private parts(st: Canon, S: string, rows: readonly MfcRow[]): Record<Part, { mfc: string; app: string }> {
    const now = this.appNow(st, S);
    const plan = this.plan(st, S, rows, now.counts);
    const kept = plan.filter((p) => p.kind !== null);
    const M = zero();
    for (const r of rows) M[r.kind] += r.count;
    const counts = this.sw.projectAllKinds
      ? { mfc: stable(M), app: stable(now.counts) }
      : { mfc: stable(rows.filter((r) => r.count > 0).map((r) => [r.id, r.kind, r.count])), app: stable(kept.map((p) => [p.id, p.kind, p.count])) };
    const out = { counts } as Record<Part, { mfc: string; app: string }>;
    for (const f of FIELDS) {
      out[f] = { mfc: stable(kept.map((p) => [p.id, rows.find((r) => r.id === p.id)!.fields[f] ?? null])), app: stable(kept.map((p) => [p.id, now.fields[f]])) };
    }
    return out;
  }


  /** MFC's rows of S as they stand (ACKNOWLEDGED): S's row bases, which a settlement or a realignment makes the export's rows of S. */
  private rowsNow(st: Canon, S: string): [string[], Map<string, RowBase>] {
    const rows = baseRowsFor(st, S);
    return [[...rows.keys()].sort(byNum), rows];
  }

  private acknowledge(st: Canon, S: string, exp: Map<string, Row>, known: readonly string[], baseRows: Map<string, RowBase>, align: boolean, policy: Policy): void {
    if (this.sw.noAck) return;
    const rows = this.mfcRows(exp, known, baseRows);
    const ps = this.parts(st, S, rows);
    const parts: Partial<Record<Part, string>> = {};
    for (const p of PARTS) if (ps[p].mfc !== ps[p].app || this.sw.wholeAck) parts[p] = stable(ps[p]);
    st.acks.set(S, {
      rows,
      parts,
      align,
      ...(policy.disposition_list === undefined ? {} : { list: policy.disposition_list }),
      ...(this.sw.alignFromAck ? { appAt: this.appNow(st, S) } : {}),
    });
  }

  /** ALIGN-MFC: what to change on MFC for it to hold the app's side, per MFC row. */
  /** ALIGN-MFC: what to change on MFC, per MFC row, for it to hold the app's side as it stands now. */
  private alignOf(st: Canon, S: string): { rev: string; actions: AlignAction[] } | null {
    const ack = st.acks.get(S);
    if (ack === undefined || !ack.align) return null;
    const now = ack.appAt ?? this.appNow(st, S);
    const rows = ack.rows;
    const plan = this.plan(st, S, rows, now.counts);
    const soldOf = (id: string) =>
      st.copiesRel(S).some((c) => {
        const d = st.val(`occ/${c}/disposal`);
        const sold = st.status(c) === 'former' && typeof d === 'object' && d !== null && !Array.isArray(d) && ['sold', 'traded'].includes(d.reason as string);
        return sold && (this.sw.listAnySale || (st.val(`occ/${c}/origin`) as string | null)?.split('#')[0] === id);
      });
    const actions: AlignAction[] = [];
    rows.forEach((r, i) => {
      const p = plan[i]!;
      const was = r.count > 0 ? r.kind : null;
      const a: AlignAction = { mfc_id: r.id };
      if (was !== p.kind) a.status = { ...(was === null ? {} : { now: was }), ...(p.kind === null ? {} : { should: p.kind }) };
      if (p.kind !== null && (was === null || r.count !== p.count)) a.count = { ...(was === null ? {} : { now: r.count }), should: p.count };
      if (p.kind !== null)
        for (const f of FIELDS) {
          const v = r.fields[f] ?? null;
          const should = now.fields[f];
          if (!eq(v, should)) a[f] = { ...(v === null ? {} : { now: v }), ...(should === null ? {} : { should }) };
        }
      // the configured list, for a row the entry lowers whose own copy the app sold or traded
      const lowered = was !== null && (p.kind === null || p.count < r.count);
      if (ack.list !== undefined && (this.sw.listAnySale ? i === 0 : lowered) && soldOf(r.id)) a.add_to_list = ack.list;
      if (Object.keys(a).length > 1) actions.push(a);
    });
    if (actions.length === 0) return null;
    const rev = `A:${stable(actions)}`;
    if (ack.dismissed === rev) return null;
    return { rev, actions };
  }

  /** R4: after a settled decision, a difference of the projection is the app's: one divergence item. */
  /** R4: after a settled decision, a part of the projection that differs and is not acknowledged at its values is the app's: one divergence item. */
  private diverge(st: Canon, S: string, exp: Map<string, Row>, known: readonly string[], baseRows: Map<string, RowBase>, n: number): void {
    const rows = this.mfcRows(exp, known, baseRows);
    const ps = this.parts(st, S, rows);
    const differ = PARTS.filter((p) => ps[p].mfc !== ps[p].app);
    const item = st.conflicts.get(S);
    if (differ.length === 0) {
      if (item?.kind === 'divergence') st.conflicts.delete(S);
      st.acks.delete(S);
      return;
    }
    const ack = st.acks.get(S);
    const acked = (p: Part) => ack?.parts[p] === stable(ps[p]);
    if (ack !== undefined && (this.sw.wholeAck ? PARTS.every(acked) : differ.every(acked))) {
      // acknowledged at these values: MFC's rows as they now stand, the parts that still differ
      if (item?.kind === 'divergence') st.conflicts.delete(S);
      ack.rows = this.sw.importAckRowsAsFound ? rows : rows.filter((r) => exp.has(r.id));
      return;
    }
    st.acks.delete(S);
    // the rev: the raising import and what it found on both sides, kept while the item is pending with the same values
    const content = stable(differ.map((p) => [p, ps[p]]));
    const M = zero();
    for (const r of exp.values()) M[r.kind] += r.count;
    // the same values keep the rev; the item still shows MFC's rows as this import found them
    const rev = item?.kind === 'divergence' && (item.expFields === content || this.sw.divRevKeptOnNewValues === true) ? item.rev : this.sw.divRevContentOnly ? `D:${content}` : `D${n}:${content}`;
    const raised = item?.kind === 'divergence' && item.rev === rev ? item.import : n;
    st.conflicts.set(S, { kind: 'divergence', rev, exp: this.sw.divergenceKeepsOldRows && item?.rev === rev ? item.exp : exp, expFields: content, B: M, M, comps: {}, import: raised, known: [...known] });
  }

  // ---------------------------------------------------------- inputs
  private applyEdit(st: Canon, e: Edit, knowing: boolean): void {
    const cur = st.facets.get(e.key);
    if (cur === undefined || gt(e.version, cur[1])) st.facets.set(e.key, [e.value, e.version]);
    this.recheck(st, e, e.version, knowing);
  }

  /**
   * ITEMS AND ANSWERS: a knowing edit that makes a conflict's sides agree (decided again, every part is one MFC did not
   * change or one the app now holds at MFC's value) ends the item; nothing is written and no base moves, and the next
   * import decides. The figure's other items follow the app's side (R8).
   */
  private recheck(st: Canon, e: Edit, ver: Version, knowing: boolean): void {
    for (const S of [...this.figsOf(e, st)].sort()) {
      const cf = st.conflicts.get(S);
      if (cf?.kind === 'conflict' && (knowing || this.sw.recheckLate) && !this.sw.M7) {
        const d = decide(st, S, cf.exp, this.sw);
        const writes = d.ops.some((op) => USER_WRITES.has(op[0]));
        const agree = Object.entries(d.comps).every(([k, v]) => k.endsWith('_detail') || v === 'nochange' || v === 'alike');
        const close = this.sw.closeWrites || this.sw.closeWhenNoConflict ? d.status !== 'conflict' : this.sw.closeWhenMfcInApp ? d.status !== 'conflict' && !writes : agree;
        if (close) {
          if (this.sw.closeWrites) applyOps(st, d.ops, ver);
          st.conflicts.delete(S);
          st.decisions.push([`edit ${e.key}`, S, 'conflict closed: sides agree']);
        }
      }
      if (cf !== undefined || st.acks.has(S)) this.emitItems(st, S, ver);
    }
  }

  /** 4.3 ROW MOVED: the spine now resolves an MFC id to another figure (not a merge). */
  private rowMoved(st: Canon, I: Import, rows: readonly Row[]): void {
    for (const r of rows) {
      const rb = st.rowBase.get(r.id);
      if (rb === undefined || st.surv(rb.head) === st.surv(r.head)) continue;
      const oldS = st.surv(rb.head);
      const cs = [...st.copies()].filter((c) => {
        const o = st.val(`occ/${c}/origin`);
        const b = st.copyBase.get(c);
        return (typeof o === 'string' ? o.split('#')[0] : '') === r.id && b !== undefined && st.surv(b[0]) === oldS;
      });
      if (cs.some((c) => st.curKind(c, oldS) !== st.baseKind(c, oldS))) continue;
      for (const c of cs) {
        if (st.status(c) !== null) st.set(`occ/${c}/head`, r.head, I.version);
        st.copyBase.set(c, [r.head, st.copyBase.get(c)![1]]);
      }
      const others = [...st.rowBase].some(([x, b]) => x !== r.id && st.surv(b.head) === oldS);
      for (const [f, bv] of Object.entries(rb.fields) as [Field, Json][]) {
        if (!others && eq(st.displayField(oldS, f), bv) && bv !== null) {
          for (const h of [...st.headsOf(oldS)].sort()) if (st.val(`uf/${h}/${f}`) !== null) st.set(`uf/${h}/${f}`, null, I.version);
          st.set(`uf/${r.head}/${f}`, bv, I.version);
          const m = st.fieldBase.get(r.head) ?? new Map<Field, Json>();
          m.set(f, bv);
          st.fieldBase.set(r.head, m);
        }
      }
      rb.head = r.head;
      st.decisions.push([`import#${I.n}`, oldS, `row ${r.id} moved`]);
    }
  }

  /** The user facet values a decision may touch, to list what it wrote and how to undo it. */
  private snapshot(st: Canon): Map<string, Json> {
    return new Map([...st.facets].filter(([k]) => k.startsWith('occ/') || k.startsWith('uf/')).map(([k, [v]]) => [k, v]));
  }
  private diff(st: Canon, before: Map<string, Json>): { writes: { key: string; value: Json }[]; undo: { key: string; value: Json }[] } {
    const writes: { key: string; value: Json }[] = [];
    const undo: { key: string; value: Json }[] = [];
    for (const k of [...st.facets.keys()].filter((k) => k.startsWith('occ/') || k.startsWith('uf/')).sort()) {
      const was = before.get(k) ?? null;
      const now = st.val(k);
      if (eq(was, now)) continue;
      writes.push({ key: k, value: now });
      if (!(k.endsWith('/origin') || (k.endsWith('/head') && was === null))) undo.push({ key: k, value: was });
    }
    return { writes, undo };
  }

  private applyImport(st: Canon, I: Import): void {
    const rows = [...I.rows];
    for (const id of I.keepIds) {
      const b = st.rowBase.get(id);
      if (b !== undefined && !rows.some((r) => r.id === id)) rows.push({ id, head: b.head, kind: b.kind, count: b.count, fields: { ...b.fields } });
    }
    this.rowMoved(st, I, rows);
    const stats: Stats = { added: 0, moved: 0, unchanged: 0, removed: 0, kept_newer: 0, occurrences_added: 0, occurrences_status_changed: 0, occurrences_removed: 0, conflicts_raised: 0 };
    st.stats.set(I.n, stats);
    const figs = new Set([...rows.map((r) => st.surv(r.head)), ...[...st.rowBase.values()].map((b) => st.surv(b.head))]);
    for (const S of [...figs].sort()) {
      const exp = rowsFor(st, S, rows);
      const baseRows = baseRowsFor(st, S);
      const known = [...new Set([...exp.keys(), ...baseRows.keys()])].sort(byNum);
      const d = decide(st, S, exp, this.sw);
      const cf = st.conflicts.get(S);
      const writes = d.ops.some((op) => USER_WRITES.has(op[0]));
      const favor = I.policy.import_policy !== 'ASK' && (d.status === 'conflict' || (this.sw.favorAll === true && writes && baseRows.size > 0));
      const statuses = new Map(st.copiesRel(S).map((c) => [c, st.status(c)]));
      let heldForUser = false;
      if (d.status === 'conflict' && !favor) {
        const expFields = stable(Object.fromEntries([...exp].map(([r, row]) => [r, row.fields])));
        // the rev is what the raising import found on both sides (MFC's rows, the disputed parts), kept across imports
        // that find MFC's side unchanged: a knowing edit, or a late edit that changes neither side, never re-revs it
        let rev = `I${I.n}:${stable({ M: d.M, exp: expFields, comps: d.comps })}`;
        let raised = I.n;
        let comps = d.comps;
        // MFC's side as THE MFC PROJECTION names it, by MFC id: each of the export's rows of S with its kind, Count and
        // field values, and each row base of S the export lacks (null)
        const sideOf = (id: string) => {
          const r = exp.get(id);
          if (r === undefined) return this.sw.revByMfcRows ? [baseRows.get(id)!.kind, 0, {}] : null;
          // a row's head is the spine's, not MFC's
          return [r.kind, r.count, this.sw.revIgnoresFields ? {} : r.fields, ...(this.sw.revByRowHeads ? [r.head] : [])];
        };
        const ids = known.filter((id) => exp.has(id) || !this.sw.revByExportRows);
        const side = this.sw.revByCountSum ? stable({ M: d.M, exp: expFields }) : stable(Object.fromEntries(ids.map((id) => [id, sideOf(id)])));
        // kept with the rev: what the raising import found (the parts keep and per_copy follow), not what this one finds
        if (cf?.kind === 'conflict' && cf.side === side) [rev, raised, comps] = [cf.rev, cf.import, this.sw.cardRefreshedAtImport ? d.comps : cf.comps];
        if (cf?.rev !== rev) stats.conflicts_raised++;
        st.conflicts.set(S, { kind: 'conflict', rev, exp, expFields, side, B: d.B, M: d.M, comps, import: raised, known });
        st.acks.delete(S);
        heldForUser = true;
        st.decisions.push([`import#${I.n}`, S, 'conflict']);
      } else if (favor) {
        // R5: the preference answers a true conflict itself; the change entry records it, undoable like an answer
        const choice = I.policy.import_policy === 'FAVOR_APP' ? 'keep' : 'take';
        const before = this.snapshot(st);
        applyOps(st, answerOps(st, S, exp, choice, this.sw, {}, {}, d.comps), I.version);
        // favor_app: its undo is the take this import would have written, against the bases as they stand now
        const pre = basesOf(st, S);
        const takeNow = choice === 'keep' && !this.sw.favorUndoOnRealigned ? this.writesOf(st, S, answerOps(st, S, exp, 'take', this.sw)) : [];
        applyOps(st, realign(st, S, exp), I.version);
        const post = basesOf(st, S);
        const { writes: w, undo } = this.diff(st, before);
        const kind = choice === 'keep' ? 'favor_app' : 'favor_mfc';
        const onRealigned = this.sw.favorUndoOnRealigned || this.sw.favorShownOnRealigned;
        const shown = choice !== 'keep' ? undo : onRealigned ? this.writesOf(st, S, this.takeSettled(st, S, exp)) : takeNow;
        st.changes.set(S, { kind, rev: `C${this.sw.favorRevWithoutImport ? '' : I.n}:${kind}:${stable(w)}`, import: I.n, writes: w, undo: shown, exp, known, baseRows: copyRows(baseRows), ...(choice === 'keep' ? { pre, post } : {}) });
        st.conflicts.delete(S);
        const [ackKnown, ackRows] = this.sw.ackBeforeRealign ? [known, baseRows] : this.rowsNow(st, S);
        this.acknowledge(st, S, exp, ackKnown, ackRows, choice === 'keep', I.policy);
        st.decisions.push([`import#${I.n}`, S, kind]);
      } else {
        const before = this.snapshot(st);
        applyOps(st, d.ops, I.version);
        if (cf !== undefined && cf.kind !== 'divergence' && !this.sw.keepStaleItem) st.conflicts.delete(S);
        if (writes && baseRows.size > 0) {
          const { writes: w, undo } = this.diff(st, before);
          st.changes.set(S, { kind: 'applied', rev: `C${this.sw.changeRevWithoutImport ? '' : I.n}:applied:${stable(w)}`, import: I.n, writes: w, undo, exp, known, baseRows: copyRows(baseRows) });
        }
        this.diverge(st, S, exp, known, baseRows, I.n);
        st.decisions.push([`import#${I.n}`, S, d.status]);
      }
      // ImportMfcExportResponse: what this decision did to the figure's rows and copies
      let wrote = false;
      let tombstoned = false;
      for (const c of st.copiesRel(S)) {
        const [was, now] = [statuses.get(c) ?? null, st.status(c)];
        if (was === now) continue;
        const live = (s: Json) => (KINDS as readonly unknown[]).includes(s);
        wrote = true;
        if (now === null) {
          stats.occurrences_removed++;
          tombstoned = true;
        } else if (live(now) && !live(was)) stats.occurrences_added++;
        else if (live(now) && live(was)) stats.occurrences_status_changed++;
      }
      const n = exp.size;
      if (baseRows.size === 0) stats.added += n;
      else if (heldForUser) stats.kept_newer += n;
      else if (wrote) stats.moved += n;
      else stats.unchanged += n;
      if (tombstoned) stats.removed += [...baseRows.keys()].filter((id) => !exp.has(id)).length;
      this.emitItems(st, S, I.version);
    }
    if (this.sw.divergeWithoutId) {
      const loose = new Set<string>();
      for (const c of st.copies()) {
        const h = st.head(c);
        if (h !== null && st.status(c) !== null && !figs.has(st.surv(h))) loose.add(st.surv(h));
      }
      for (const S of [...loose].sort()) {
        const app = this.appNow(st, S);
        if (KINDS.some((k) => app.counts[k] > 0)) {
          st.conflicts.set(S, { kind: 'divergence', rev: `D:${stable(app)}`, exp: new Map(), expFields: '', B: zero(), M: zero(), comps: {}, import: I.n, known: [] });
          this.emitItems(st, S, I.version);
        }
      }
    }
  }

  private applyAnswer(st: Canon, R: Answer): void {
    const S = R.fig;
    const policy = this.policyAt(R.arr);
    R.accepted = false;
    const cf = st.conflicts.get(S);
    // the answer names its item (res-answer `item`) and that item's rev
    const is = (item: ItemKind, rev: string | undefined) => (this.sw.ignoreItem || R.item === item) && rev !== undefined && rev === R.rev && !this.withdrawnUnseen(R);
    const heldRev = this.heldOn(st, S, R.arr).listed;
    if (cf !== undefined && (is('figure', cf.rev) || (this.sw.M9 && R.item === 'figure'))) this.answerFigure(st, S, cf, R, policy);
    else if (heldRev.length > 0 && is('held', this.heldRev(heldRev))) this.answerHeld(st, S, R);
    else if (is('change', st.changes.get(S)?.rev)) this.answerChange(st, S, st.changes.get(S)!, R, policy);
    else if (is('align', this.alignOf(st, S)?.rev) && R.choice === 'dismiss') {
      if (!this.sw.forgetDismiss) st.acks.get(S)!.dismissed = R.rev!;
      R.accepted = true;
    }
    st.decisions.push([`answer ${R.choice}`, S, R.accepted ? 'accepted' : 'STALE']);
    this.emitItems(st, S, R.version);
  }

  /** Mutant answerStaleAfterWithdrawal only: a revision the answer's device had not seen withdrew or re-revved the item it names. */
  private withdrawnUnseen(R: Answer): boolean {
    if (!this.sw.answerStaleAfterWithdrawal) return false;
    const at = this.arrSeq.get(R.arr) ?? 1e9;
    return (this.revisions.get(R.fig) ?? []).some((Rv) => R.basis < Rv.seq && Rv.seq < at && Rv.items.has(ITEM(R.item, R.fig)));
  }

  private answerFigure(st: Canon, S: string, cf: Card, R: Answer, policy: Policy): void {
    const allowed: Record<Card['kind'], Choice[]> = { conflict: ['keep', 'take', 'per_copy'], divergence: ['keep', 'take'] };
    if (!allowed[cf.kind].includes(R.choice)) return;
    const baseRows = baseRowsFor(st, S);
    const known = [...new Set([...cf.exp.keys(), ...baseRows.keys(), ...cf.known])].sort(byNum);
    if (cf.kind === 'divergence' && R.choice === 'keep') {
      st.conflicts.delete(S);
      const [dk, dr] = this.sw.ackBeforeRealign ? [known, baseRows] : this.rowsNow(st, S);
      this.acknowledge(st, S, cf.exp, dk, dr, true, policy);
      R.accepted = true;
      return;
    }
    if (cf.kind === 'conflict') applyOps(st, answerOps(st, S, cf.exp, R.choice, this.sw, R.copies, R.fields, cf.comps), R.version);
    else if (R.choice === 'take') applyOps(st, this.takeSettled(st, S, cf.exp), R.version);
    applyOps(st, realign(st, S, cf.exp), R.version);
    st.conflicts.delete(S);
    const [ackKnown, ackRows] = this.sw.ackBeforeRealign ? [known, baseRows] : this.rowsNow(st, S);
    this.acknowledge(st, S, cf.exp, ackKnown, ackRows, R.choice !== 'take', policy);
    R.accepted = true;
  }

  private answerHeld(st: Canon, S: string, R: Answer): void {
    const { listed } = this.heldOn(st, S, R.arr);
    if (listed.length === 0 || this.heldRev(listed) !== R.rev || !['keep', 'take'].includes(R.choice)) return;
    for (const e of listed) {
      st.heldAnswered.add(e.arr);
      if (R.choice === 'keep') {
        // as knowing edits, written now as the answer's writes are: above the facet's current version
        if (this.sw.keepAtOwnVersion) {
          const cur = st.facets.get(e.key);
          if (cur === undefined || gt(e.version, cur[1])) st.facets.set(e.key, [e.value, e.version]);
        } else st.set(e.key, e.value, R.version);
        this.recheck(st, e, R.version, !this.sw.heldKeepNotKnowing);
      }
    }
    R.accepted = true;
  }

  private answerChange(st: Canon, S: string, ch: Change, R: Answer, policy: Policy): void {
    if (R.choice === 'dismiss') {
      st.changes.delete(S);
      R.accepted = true;
      return;
    }
    if (R.choice !== 'undo') return;
    if (ch.kind === 'favor_app') {
      // the take the import would have written: the bases the settlement's realignment moved put back as they stood
      // before it, MFC's side of the entry's export made true against them, the bases realigned, the acknowledgement recorded
      const exp = this.sw.favorUndoAtLatestExport ? new Map([...baseRowsFor(st, S)].map(([id, b]) => [id, { id, ...b, fields: { ...b.fields } }])) : ch.exp;
      if (this.sw.favorUndoOnRealigned) applyOps(st, this.takeSettled(st, S, exp), R.version);
      else {
        if (this.sw.undoRestoresAllBases) restoreBases(st, S, ch.pre!);
        else restoreMoved(st, ch.pre!, ch.post!, this.sw);
        applyOps(st, this.sw.favorUndoTakeSettled ? this.takeSettled(st, S, exp) : answerOps(st, S, exp, 'take', this.sw), R.version);
      }
      const baseRows = baseRowsFor(st, S);
      if (!this.sw.favorUndoNoRealign) applyOps(st, realign(st, S, exp), R.version);
      if (this.sw.favorUndoEndsAck) st.acks.delete(S);
      else {
        const [ackKnown, ackRows] = this.sw.ackBeforeRealign ? [[...new Set([...exp.keys(), ...baseRows.keys()])].sort(byNum), baseRows] : this.rowsNow(st, S);
        this.acknowledge(st, S, exp, ackKnown, ackRows, false, policy);
      }
    } else {
      if (!this.sw.undoIgnoresLaterEdits && !ch.writes.every((w) => eq(st.val(w.key), w.value))) return;
      for (const u of ch.undo) st.set(u.key, u.value, R.version);
      if (this.sw.undoRealigns) applyOps(st, realign(st, S, ch.exp), R.version);
      // MFC's rows as they stand at the undo (ACKNOWLEDGED): S's row bases, as an import of the export that last settled S
      // finds them, so a row with no row base at the undo is none of them
      const baseRows = baseRowsFor(st, S);
      if (this.sw.undoAckAtImport) this.acknowledge(st, S, ch.exp, ch.known, ch.baseRows, true, policy);
      else if (this.sw.undoAckExportRows) this.acknowledge(st, S, ch.exp, [...new Set([...ch.exp.keys(), ...baseRows.keys()])].sort(byNum), baseRows, true, policy);
      else {
        const dropped = (id: string) => this.sw.undoAckLeavesDropped === true && ch.baseRows.has(id) && !ch.exp.has(id);
        const known = [...baseRows.keys()].filter((id) => !dropped(id));
        const kind = (id: string, b: RowBase) => (this.sw.undoAckKindFromExport === true ? (ch.exp.get(id)?.kind ?? b.kind) : b.kind);
        this.acknowledge(st, S, new Map([...baseRows].map(([id, b]) => [id, { id, ...b, kind: kind(id, b), fields: { ...b.fields } }])), known, baseRows, true, policy);
      }
    }
    st.changes.delete(S);
    R.accepted = true;
  }

  // ---------------------------------------------------------- emission
  private recompute(t: number): [number, string][] {
    const st = this.replay();
    this.canon = st;
    const out: [number, string][] = [];
    for (const k of [...new Set([...st.facets.keys(), ...this.emitted.keys()])].sort()) {
      if (k === MARKER) continue;
      const nv = st.facets.get(k);
      const val = nv === undefined ? null : nv[0];
      const old = this.emitted.get(k);
      if (eq(val, old === undefined ? null : old[0])) continue;
      let ver: Version;
      if (nv !== undefined && (old === undefined || gt(nv[1], old[1]))) ver = nv[1];
      else ver = [old === undefined ? t : Math.max(t, old[1][0]), 1_000_000 + this.feed.length, '0', 0];
      this.emit(k, val, ver);
      out.push([this.feed.length, k]);
    }
    return out;
  }

  private emit(key: string, value: Json, version: Version): void {
    this.emitted.set(key, [value, version]);
    this.feed.push({ seq: this.feed.length + 1, key, value, version, last: false });
    if (key.endsWith('/head') && typeof value === 'string') {
      const c = key.split('/')[1]!;
      this.headHist.set(c, new Set([...(this.headHist.get(c) ?? []), value]));
    }
  }

  /** F2: every server transaction's events are consecutive; its last one carries the commit cursor. */
  private commit(n0: number): void {
    if (this.feed.length > n0) this.feed[this.feed.length - 1]!.last = true;
  }

  figsOfKey(k: string, st: Canon): Set<string> {
    if (isItemKey(k)) return k.split('/').length === 4 ? new Set([k.split('/')[3]!]) : new Set();
    if (k.startsWith('uf/')) return new Set([st.surv(k.split('/')[1]!)]);
    if (k.startsWith('occ/')) {
      const c = k.split('/')[1]!;
      const hs = new Set(this.headHist.get(c) ?? []);
      const b = st.copyBase.get(c);
      if (b !== undefined) hs.add(b[0]);
      return new Set([...hs].map((h) => st.surv(h)));
    }
    return new Set();
  }

  private policyAt(arr: number): Policy {
    const I = this.inputs.filter((i): i is Import => i.type === 'import' && i.arr < arr).at(-1);
    return I?.policy ?? { import_policy: 'ASK' };
  }

  // ---------------------------------------------------------- API
  /** Emit the state as it stands (a seeded start) without an input. */
  settle(t: number): void {
    const n0 = this.feed.length;
    this.recompute(t);
    this.commit(n0);
  }

  runImport(rows: readonly Row[], t: number, opts: { keepIds?: readonly string[] } = {}): Import {
    this.nImports++;
    const pref = this.emitted.get(PREF)?.[0] as Partial<Policy> | null | undefined;
    const I: Import = {
      type: 'import',
      // a blank value is no value (ROWS): a row lists only the field values it states
      rows: rows.map((r) => ({ ...r, fields: this.sw.rowsKeepBlankFields ? { ...r.fields } : statedFields(r.fields) })),
      keepIds: [...(opts.keepIds ?? [])],
      t,
      n: this.nImports,
      version: [t, this.nImports, '0', 0],
      arr: this.inputs.length,
      lastSeq: new Map(),
      markerSeq: 0,
      policy: {
        import_policy: pref?.import_policy ?? 'ASK',
        ...(pref?.disposition_list === undefined ? {} : { disposition_list: pref.disposition_list }),
      },
    };
    this.inputs.push(I);
    const n0 = this.feed.length;
    // the figures the import decides: those of its rows and of the row bases as they stood before it (THE FIGURE DECISION)
    const before = this.sw.frameAfterImport || this.canon === undefined ? [] : [...this.canon.rowBase.values()].map((b) => b.head);
    for (const [seq, k] of this.recompute(t)) for (const f of this.figsOfKey(k, this.canon!)) I.lastSeq.set(f, Math.max(I.lastSeq.get(f) ?? 0, seq));
    if (!this.sw.noMarker) {
      // F1: the marker, last; a frame for every figure the import decided, written to or not
      this.emit(MARKER, { import: I.n }, [t, 10_000_000 + this.feed.length + 1, '0', 0]);
      const seq = this.feed.length;
      I.markerSeq = seq;
      const st = this.canon!;
      for (const f of new Set([...[...I.rows, ...before.map((head) => ({ head })), ...st.rowBase.values()].map((r) => st.surv(r.head))]))
        I.lastSeq.set(f, Math.max(I.lastSeq.get(f) ?? 0, seq));
    } else I.markerSeq = this.feed.length;
    this.commit(n0);
    // the response's counters (ImportMfcExportResponse 3 to 17), as they stand when the import returns
    const st = this.canon!;
    const items = [...st.conflicts.values()];
    const figs = new Set([...st.acks.keys()]);
    I.counters = {
      ...st.stats.get(I.n)!,
      facets_written: this.feed.length - n0,
      conflicts_pending: items.filter((c) => c.kind === 'conflict').length,
      divergences_pending: items.filter((c) => c.kind === 'divergence').length,
      align_pending: [...figs].filter((S) => this.alignOf(st, S) !== null).length,
      import_number: I.n,
    };
    return I;
  }

  redirect(head: string, survivor: string, t: number): void {
    this.inputs.push({ type: 'redirect', head, survivor, arr: this.inputs.length, version: [t, 0, '0', 0] });
    const n0 = this.feed.length;
    this.recompute(t);
    this.commit(n0);
  }

  push(items: readonly Pushable[], t: number): PushResult[] {
    if (items.length === 0) return [];
    const prev = this.canon ?? this.replay();
    for (const it of items) {
      it.arr = this.inputs.length;
      this.arrSeq.set(it.arr, this.feed.length + 1);
      this.inputs.push(it);
    }
    this.decideHolds(items, prev);
    if (this.sw.holdWithoutArrivedBefore) this.redecide(prev);
    // HELD (ii): a REVISION is a push that replays a late edit before an import; an answer's writes are none
    const replayed = items.filter((it): it is Edit => it.type === 'edit' && (!it.held || this.sw.heldLateIsRevision === true) && this.lates(it, prev).length > 0);
    const before = new Map(this.emitted);
    const n0 = this.feed.length;
    const out = this.recompute(t);
    this.commit(n0);
    if (replayed.length > 0 || this.sw.revisionsFromAnswers) this.recordRevision(items, replayed, before, prev);
    // HELD (iii): an accepted answer's position, its push's commit
    for (const it of items) {
      if (it.type !== 'answer') continue;
      if (this.sw.answerHoldFigureOnly) {
        for (const [seq, k] of out) if (k === CARD + it.fig) it.lastSeq.set(it.fig, seq);
      } else if (it.accepted && this.feed.length > n0) it.lastSeq.set(it.fig, this.feed.length);
    }
    return items.map((it) => {
      const key = it.type === 'edit' ? it.key : CARD + it.fig;
      const current = this.emitted.get(key);
      let outcome: Outcome;
      if (it.type === 'answer') outcome = it.accepted ? 'APPLIED' : 'STALE';
      else if (it.held) outcome = 'HELD';
      else outcome = eq(current?.[0] ?? null, it.value) ? 'APPLIED' : 'STALE';
      return { key, current, outcome };
    });
  }

  /**
   * HELD (ii): a REVISION, per figure: what this push's replayed late edits alone changed against S just before the push
   * (the push replayed without its answers and knowing edits), leaving out those late edits' own writes: the copies
   * whose live state moved and the items whose rev did. Every push that replays a late edit is a revision point for its
   * figures, whatever it changed; the item revs of both replays go with it, for what a device saw (sawWithdrawn).
   */
  private recordRevision(items: readonly Pushable[], replayed: readonly Edit[], before: Map<string, [Json, Version]>, prev: Canon): void {
    const st = this.canon!;
    const seq = this.feed.length;
    const imp = replayed.map((e) => this.lates(e, prev)[0]!).sort((a, b) => a.arr - b.arr)[0];
    const whole = this.sw.revisionWholePush === true || this.sw.revisionsFromAnswers === true;
    let after: Map<string, [Json, Version]> = this.emitted;
    let histAfter: RevHist = this.revHist.get(st) ?? new Map();
    if (!whole) {
      // the late edits alone: an answer's writes are no revision, and neither is a knowing edit of the same push
      const accepted = this.inputs.filter((i): i is Answer => i.type === 'answer').map((a) => [a, a.accepted] as const);
      this.skip = new Set(items.filter((it) => !(replayed as readonly Pushable[]).includes(it)).map((it) => it.arr));
      const late = this.replay();
      this.skip = new Set();
      for (const [a, v] of accepted) a.accepted = v;
      after = late.facets;
      histAfter = this.revHist.get(late) ?? new Map();
    }
    // the replayed late edits' own writes are no part of the change (round 7 left out every edit of the push)
    const ownEdits = this.sw.revisionCountsOwn ? [] : whole ? items.filter((it): it is Edit => it.type === 'edit') : replayed;
    const own = new Set(this.sw.ownByCopy ? ownEdits.flatMap((it) => (it.key.startsWith('occ/') ? [...UNIT_FACETS].map((f) => `occ/${it.key.split('/')[1]}/${f}`) : [it.key])) : ownEdits.map((it) => it.key));
    const liveOf = (m: Map<string, [Json, Version]>, c: string) => {
      const h = m.get(`occ/${c}/head`)?.[0];
      const s = m.get(`occ/${c}/status`)?.[0];
      return typeof h === 'string' && (KINDS as readonly unknown[]).includes(s) ? `${st.surv(h)}:${s as string}` : OUT;
    };
    const histBefore: RevHist = this.revHist.get(prev) ?? new Map();
    const per = new Map<string, Revision>();
    const at = (f: string) => per.get(f) ?? per.set(f, { seq, copies: new Set(), items: new Set(), imp, before: histBefore, after: histAfter }).get(f)!;
    const val = (m: Map<string, [Json, Version]>, k: string) => m.get(k)?.[0] ?? null;
    for (const k of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (own.has(k) || eq(val(before, k), val(after, k))) continue;
      const p = k.split('/');
      if (isItemKey(k)) {
        if (this.sw.revisionIgnoresItems || !(ITEM_KINDS as readonly string[]).includes(p[2]!)) continue;
        if (!this.sw.itemsByPayload && revOf(val(before, k)) === revOf(val(after, k))) continue;
        for (const f of this.figsOfKey(k, st)) at(f).items.add(k);
      } else if (p[0] === 'occ' && (p[2] === 'status' || p[2] === 'head') && liveOf(before, p[1]!) !== liveOf(after, p[1]!))
        for (const f of this.figsOfKey(k, st)) at(f).copies.add(p[1]!);
    }
    if (!this.sw.revisionFromPushStart) for (const e of replayed) for (const f of this.figsOf(e, st)) at(f);
    for (const [f, r] of per) this.revisions.set(f, [...(this.revisions.get(f) ?? []), r]);
  }

  // ---------------------------------------------------------- views
  live(c: string): Json {
    return this.emitted.get(`occ/${c}/status`)?.[0] ?? null;
  }
  /** Figures with a pending conflict. */
  pending(): string[] {
    return this.canon === undefined ? [] : [...this.canon.conflicts].filter(([, c]) => c.kind === 'conflict').map(([S]) => S).sort();
  }
  heldEdits(): [string, string][] {
    return (this.canon?.held ?? []).map((e) => [e.dev, e.key] as [string, string]).sort((a, b) => cmpStr(a.join(' '), b.join(' ')));
  }
  private live_(prefix: string): [string, Json][] {
    return [...this.emitted].filter(([k, v]) => k.startsWith(prefix) && v[0] !== null).map(([k, v]) => [k.slice(prefix.length), v[0]] as [string, Json]).sort(([a], [b]) => cmpStr(a, b));
  }
  /** Pending figure items (imp/{site}/figure/{head}) by kind. */
  figureItems(): Record<string, string> {
    return Object.fromEntries(this.live_('imp/mfc/figure/').map(([S, v]) => [S, (v as { kind: string }).kind]));
  }
  /** Held-edit cards (imp/{site}/held/{head}): the keys each holds. */
  heldCards(): Record<string, string[]> {
    return Object.fromEntries(this.live_('imp/mfc/held/').map(([S, v]) => [S, (v as { held: { key: string }[] }).held.map((h) => h.key)]));
  }
  /** Change entries (imp/{site}/change/{head}) by kind. */
  changeEntries(): Record<string, string> {
    return Object.fromEntries(this.live_('imp/mfc/change/').map(([S, v]) => [S, (v as { kind: string }).kind]));
  }
  /** Align-MFC entries (imp/{site}/align/{head}): their actions. */
  alignEntries(): Record<string, AlignAction[]> {
    return Object.fromEntries(this.live_('imp/mfc/align/').map(([S, v]) => [S, (v as unknown as { actions: AlignAction[] }).actions]));
  }

  /** The import's result for the client that asked for it (R7): the review set and the changes it made. */
  importResult(I: Import): ImportResult {
    const item = (kind: 'figure' | 'held' | 'change' | 'align', S: string, v: Json, answers: Choice[]): ReviewItem => ({
      key: ITEM(kind, S),
      head: S,
      rev: (v as { rev: string }).rev,
      answers,
    });
    const review: ReviewGroup[] = [];
    const figures = this.live_('imp/mfc/figure/');
    for (const kind of ['conflict', 'divergence'] as const) {
      const items = figures.filter(([, v]) => (v as { kind: string }).kind === kind).map(([S, v]) => item('figure', S, v, ANSWERS[kind].answers));
      if (items.length > 0) review.push({ kind, items, bulk: ANSWERS[kind].bulk });
    }
    const held = this.live_('imp/mfc/held/').map(([S, v]) => item('held', S, v, ANSWERS.held_edits.answers));
    if (held.length > 0) review.push({ kind: 'held_edits', items: held, bulk: ANSWERS.held_edits.bulk });
    const align = this.live_('imp/mfc/align/').map(([S, v]) => ({ ...item('align', S, v, ANSWERS.align_mfc.answers), actions: (v as unknown as { actions: AlignAction[] }).actions }));
    if (align.length > 0) review.push({ kind: 'align_mfc', items: align, bulk: ANSWERS.align_mfc.bulk });
    const applied = this.live_('imp/mfc/change/')
      .filter(([, v]) => (v as { import: number }).import === I.n)
      .map(([S, v]) => {
        const ch = v as { rev: string; kind: AppliedItem['kind']; writes: { key: string; value: Json }[] };
        return { key: ITEM('change', S), head: S, rev: ch.rev, kind: ch.kind, writes: ch.writes, answers: ['undo', 'dismiss'] as Choice[] };
      });
    return { review, applied, counters: I.counters! };
  }
}
