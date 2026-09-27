// import.proto's server-side import rules (THE SERVER DECIDES), written the simplest way so that
// golden/import-vectors.json is executed, not only stated: a port of the reviewed Python reference model
// (design A with the review's fixes F1 to F3), plus Ross's review rules R1 to R8. The server keeps every
// input (device edits with their basis, imports, answers, spine redirects) and derives its state by REPLAY
// in canonical order; after every input it diffs that state against what it has emitted and emits the
// difference as ordinary feed events, one transaction per input.
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
  held: boolean;
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
  /** pref/{site}/import as the server held it when the import started. */
  policy: Policy;
}
export interface Redirect {
  type: 'redirect';
  head: string;
  survivor: string;
  arr: number;
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
/** A figure item (imp/{site}/figure/{S}): a conflict, a change held for confirmation, or a divergence. */
export interface Card {
  kind: 'conflict' | 'mfc_change' | 'divergence';
  rev: string;
  exp: Map<string, Row>;
  expFields: string;
  B: Counts;
  M: Counts;
  comps: Record<string, unknown>;
  /** The import that raised this rev. */
  import: number;
  /** The MFC ids known to the import that raised it (its rows and row bases), for the projection. */
  known: string[];
}
/** MFC's side of a figure (THE MFC PROJECTION): its rows, per-kind Counts and field values. */
export interface MfcSide {
  rows: { id: string; kind: Kind; count: number; fields: Partial<Record<Field, Json>> }[];
  counts: Counts;
  fields: Record<Field, Json>;
}
/** The app's side as MFC could state it. */
export interface AppSide {
  counts: Counts;
  fields: Record<Field, Json>;
}
/** ACKNOWLEDGED: both sides as the user left them; `align` when the answer kept the app's side. */
export interface Ack {
  mfc: MfcSide;
  app: AppSide;
  mfcDigest: string;
  appDigest: string;
  align: boolean;
  list?: string;
  soldRow?: string;
  dismissed?: string;
}
/** A change entry (imp/{site}/change/{S}): what an import wrote, and its undo. */
export interface Change {
  kind: 'applied' | 'favor_app' | 'favor_mfc';
  rev: string;
  import: number;
  writes: { key: string; value: Json }[];
  undo: { key: string; value: Json }[];
  exp: Map<string, Row>;
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

export function rowsFor(st: Canon, S: string, rows: readonly Row[]): Map<string, Row> {
  return new Map(rows.filter((r) => st.surv(r.head) === S).map((r) => [r.id, r]));
}
export function baseRowsFor(st: Canon, S: string): Map<string, RowBase> {
  return new Map([...st.rowBase].filter(([, b]) => st.surv(b.head) === S));
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
    else if (RA.length > 0 && [...kindsOf(RM)].some((k) => raKinds.has(k))) {
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
): Op[] {
  const d = decide(st, S, exp, sw);
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
          const a: [number, string] = [st.hasOrigin(c) ? 1 : 0, st.rank(c)];
          const b: [number, string] = [st.hasOrigin(best) ? 1 : 0, st.rank(best)];
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
    if (d.comps.counts !== 'conflict') ops.push(...d.ops.filter((op) => ['status', 'create', 'irem_add', 'irem_del'].includes(op[0])));
    for (const [c, v] of Object.entries(copies)) ops.push(['status', c, v === 'removed' ? null : v]);
    for (const f of FIELDS) {
      const comp = d.comps[f];
      if (comp === 'apply' || (comp === 'conflict' && (fields[f] ?? 'app') === 'mfc')) fieldWrite(f);
    }
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
  /** R3 off: mfc_only HOLD ignored. */
  ignoreHold?: boolean;
  /** R4 off: acknowledgements not kept. */
  noAck?: boolean;
  /** R5 off: a FAVOR preference applied to a change only MFC made too. */
  favorAll?: boolean;
  /** R8 off: a dismissed align-MFC entry shown again. */
  forgetDismiss?: boolean;
  /** R8 off: a divergence raised for a figure with no MFC id. */
  divergeWithoutId?: boolean;
}

// ------------------------------------------------------------------ the server
export type Outcome = 'APPLIED' | 'STALE' | 'HELD';
export type ReviewKind = 'conflict' | 'mfc_change' | 'divergence' | 'held_edits' | 'align_mfc';
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
  mfc_only: 'APPLY_AND_LIST' | 'HOLD';
  disposition_list?: string;
}
type HeldReason = 'late_after_knowing' | 'made_on_revised_result' | 'after_answer';

export const ITEM = (kind: 'figure' | 'held' | 'change' | 'align', S: string) => `imp/mfc/${kind}/${S}`;
export const MARKER = 'imp/mfc/import';
export const PREF = 'pref/mfc/import';
const ANSWERS: Record<ReviewKind, { answers: Choice[]; bulk: Choice[] }> = {
  conflict: { answers: ['keep', 'take', 'per_copy'], bulk: ['keep', 'take'] },
  mfc_change: { answers: ['take', 'keep'], bulk: ['take', 'keep'] },
  divergence: { answers: ['keep', 'take'], bulk: ['keep', 'take'] },
  held_edits: { answers: ['keep', 'take'], bulk: ['keep', 'take'] },
  align_mfc: { answers: ['dismiss'], bulk: ['dismiss'] },
};
const USER_WRITES = new Set(['status', 'create', 'field', 'fieldtomb']);
const isItemKey = (k: string) => k.startsWith('imp/');

export class Server {
  readonly inputs: Input[] = [];
  readonly emitted = new Map<string, [Json, Version]>();
  readonly feed: FeedEvent[] = [];
  canon: Canon | undefined;
  nImports = 0;
  private readonly headHist = new Map<string, Set<string>>();
  /** Per push arrival: the feed length + 1 when it arrived. */
  private readonly arrSeq = new Map<number, number>();
  /** Per figure: the seqs of replay emissions that revised an import's result. */
  private readonly epochHist = new Map<string, number[]>();
  private force = new Map<number, 'before' | 'arrival'>();
  private noHold = false;
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
    const imports = this.inputs.filter((i): i is Import => i.type === 'import');
    const answers = this.inputs.filter((i): i is Answer => i.type === 'answer');
    const anchored = new Map<number, Edit[]>();
    const placed = new Set<number>();
    const arrOf = (e: Input) => this.arrSeq.get(e.arr) ?? 1e9;
    for (const e of this.inputs) {
      if (e.type !== 'edit') continue;
      const figs = this.figsOf(e, prev);
      const lates = imports.filter((I) => I.arr < e.arr && this.lateFor(I, e, figs));
      this.heldReason.delete(e.arr);
      // 5.4 (iii): a late edit whose basis is before an answer on its figure
      const beforeAnswer = answers.some((r) => r.arr < e.arr && [...figs].some((f) => (r.lastSeq.get(f) ?? 0) > e.basis));
      e.held = beforeAnswer && (this.sw.broadHold === true || lates.length > 0);
      if (e.held) this.heldReason.set(e.arr, 'after_answer');
      const forced = this.force.get(e.arr);
      if (forced !== undefined) {
        if (forced === 'before') {
          anchored.set(lates[0]!.arr, [...(anchored.get(lates[0]!.arr) ?? []), e]);
          placed.add(e.arr);
        }
        continue;
      }
      const hold = !this.noHold && !this.sw.noHold;
      // F3 (i) HOLD ON REACTION: another device made a knowing edit to a copy of the figure after the import
      if (hold && lates.length > 0 && !e.held) {
        const I0 = lates[0]!;
        for (const k of this.inputs) {
          if (
            k.type === 'edit' &&
            k !== e &&
            I0.arr < k.arr &&
            k.key.startsWith('occ/') &&
            k.basis < arrOf(e) &&
            (this.sw.holdWithoutArrivedBefore === true || k.arr < e.arr || this.arrSeq.get(k.arr) === this.arrSeq.get(e.arr)) &&
            [...this.figsOf(k, prev)].some((f) => figs.has(f)) &&
            ![...figs].some((f) => (I0.lastSeq.get(f) ?? 0) > k.basis)
          ) {
            e.held = this.sw.holdWithoutRelevance === true || this.relevant(e, figs);
            if (e.held) this.heldReason.set(e.arr, 'late_after_knowing');
            break;
          }
        }
      }
      // F3 (ii): made on a result a later replay revised
      if (hold && lates.length === 0 && !e.held && [...figs].some((f) => e.basis < this.epochAt(f, e))) {
        e.held = true;
        this.heldReason.set(e.arr, 'made_on_revised_result');
      }
      if (e.held || this.sw.M1) continue;
      const I = lates[0];
      if (I !== undefined) {
        anchored.set(I.arr, [...(anchored.get(I.arr) ?? []), e]);
        placed.add(e.arr);
      }
    }
    const order: Input[] = [];
    for (const i of this.inputs) {
      if (i.type === 'import') {
        order.push(...(anchored.get(i.arr) ?? []).sort((a, b) => a.arr - b.arr), i);
      } else if (i.type === 'edit') {
        if (!placed.has(i.arr) && !i.held) order.push(i);
      } else order.push(i);
    }
    return order;
  }

  /** F3 (i): would placing the late edit before the import change that import's result on its figures? */
  private relevant(e: Edit, figs: Set<string>): boolean {
    const saved: [Map<number, 'before' | 'arrival'>, boolean] = [new Map(this.force), this.noHold];
    this.noHold = true;
    const out: Record<string, string>[] = [];
    for (const how of ['before', 'arrival'] as const) {
      this.force = new Map(saved[0]).set(e.arr, how);
      const st = this.replay();
      const view: Record<string, string> = {};
      for (const [k, [v]] of st.facets) {
        if (!k.startsWith('occ/') || k === e.key || !['status', 'head'].includes(k.split('/').at(-1)!)) continue;
        const c = k.split('/')[1]!;
        const hs = new Set(this.headHist.get(c) ?? []);
        const h = st.head(c);
        if (h !== null) hs.add(h);
        if ([...hs].some((x) => figs.has(st.surv(x)))) view[k] = stable(v);
      }
      for (const f of figs) view[`item:${f}`] = stable(this.cardDigest(st, f));
      out.push(view);
    }
    [this.force, this.noHold] = saved;
    const [a, b] = out as [Record<string, string>, Record<string, string>];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].some((k) => (a[k] ?? 'null') !== (b[k] ?? 'null'));
  }

  private epochAt(f: string, e: Edit): number {
    const at = this.arrSeq.get(e.arr) ?? 1e9;
    return Math.max(0, ...(this.epochHist.get(f) ?? []).filter((q) => q < at));
  }

  // ---------------------------------------------------------- replay
  replay(): Canon {
    const st = new Canon(this.namer, this.rank);
    if (this.sw.M5) st.surv = (h: string) => h;
    this.initial?.(st);
    const prev = this.canon ?? st;
    for (const inp of this.canonicalOrder(prev)) {
      if (inp.type === 'edit') this.applyEdit(st, inp);
      else if (inp.type === 'import') this.applyImport(st, inp);
      else if (inp.type === 'answer') this.applyAnswer(st, inp);
      else st.redirect.set(inp.head, inp.survivor);
    }
    st.held = this.inputs.filter((e): e is Edit => e.type === 'edit' && e.held);
    this.emitHeldCards(st);
    return st;
  }

  /** What the relevance test of F3 compares for a figure's item (the reviewed reference's card digest). */
  cardDigest(st: Canon, S: string): Json {
    const cf = st.conflicts.get(S);
    if (cf === undefined || cf.kind === 'divergence') return null;
    const summ = st.summary(S);
    return JSON.parse(stable({ rev: cf.rev, kind: cf.kind, base: cf.B, mfc: cf.M, app: summ.counts, app_copies: summ.copies, comps: cf.comps })) as Json;
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
    const keep = cf.kind === 'conflict' ? this.writesOf(st, S, answerOps(st, S, cf.exp, 'keep', this.sw)) : [];
    const takeOps =
      cf.kind === 'mfc_change' ? decide(st, S, cf.exp, this.sw).ops : cf.kind === 'divergence' ? this.takeSettled(st, S, cf.exp) : answerOps(st, S, cf.exp, 'take', this.sw);
    const take = this.writesOf(st, S, takeOps);
    return JSON.parse(stable({ rev: cf.rev, kind: cf.kind, import: cf.import, counts, fields, copies, mfc_rows: mfcRows, preview: { keep, take } })) as Json;
  }

  /** Set a server-owned facet to `v` (null: tombstone), only when it changes. */
  private put(st: Canon, key: string, v: Json, ver: Version): void {
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
  private heldOn(st: Canon, S: string, before: number): Edit[] {
    return this.inputs.filter((e): e is Edit => e.type === 'edit' && e.held && e.arr < before && !st.heldAnswered.has(e.arr) && this.figsOf(e, st).has(S));
  }
  private heldRev = (es: readonly Edit[]) => `H:${es.map((e) => e.arr).join(',')}`;

  private emitHeldCards(st: Canon): void {
    const held = this.inputs.filter((e): e is Edit => e.type === 'edit' && e.held && !st.heldAnswered.has(e.arr));
    const figs = new Set<string>();
    for (const e of held) for (const f of this.figsOf(e, st)) figs.add(f);
    for (const S of [...figs].sort()) {
      const es = held.filter((e) => this.figsOf(e, st).has(S));
      const ver = es.map((e) => e.version).sort(cmpVersion).at(-1)!;
      const held_ = es.map((e) => ({ key: e.key, value: e.value, version: e.version, reason: this.heldReason.get(e.arr) ?? 'after_answer' }));
      const payload = JSON.parse(stable({ rev: this.heldRev(es), held: held_ })) as Json;
      this.put(st, ITEM('held', S), payload, ver);
    }
  }

  // ---------------------------------------------------------- the projection, acknowledgements, align-MFC (R2, R4, R8)
  private mfcSide(st: Canon, S: string, exp: Map<string, Row>, known: readonly string[], baseRows: Map<string, RowBase>): MfcSide {
    const rows = known.map((id) => {
      const r = exp.get(id);
      if (r !== undefined) return { id, kind: r.kind, count: r.count, fields: { ...r.fields } };
      return { id, kind: baseRows.get(id)?.kind ?? ('owned' as Kind), count: 0, fields: {} };
    });
    const counts = zero();
    for (const r of rows) counts[r.kind] += r.count;
    const fields = Object.fromEntries(FIELDS.map((f) => [f, st.baseField(S, f)])) as Record<Field, Json>;
    return { rows, counts, fields };
  }

  private appSide(st: Canon, S: string, kinds: number): AppSide {
    const all = zero();
    for (const c of st.copiesRel(S)) {
      const k = st.curKind(c, S);
      if (k !== OUT) all[k]++;
    }
    const counts = zero();
    let kept = 0;
    for (const k of KINDS) {
      if (all[k] === 0) continue;
      if (this.sw.projectAllKinds || kept < kinds) counts[k] = all[k];
      kept++;
    }
    return { counts, fields: Object.fromEntries(FIELDS.map((f) => [f, st.displayField(S, f)])) as Record<Field, Json> };
  }

  private static digest(m: MfcSide | AppSide): string {
    return 'rows' in m ? stable({ rows: m.rows.filter((r) => r.count > 0).map((r) => [r.id, r.kind, r.count]), fields: m.fields }) : stable(m);
  }
  private static agree(m: MfcSide, a: AppSide): boolean {
    return eq(m.counts, a.counts) && eq(m.fields, a.fields);
  }

  private acknowledge(st: Canon, S: string, exp: Map<string, Row>, known: readonly string[], baseRows: Map<string, RowBase>, align: boolean, policy: Policy): void {
    if (this.sw.noAck) return;
    const mfc = this.mfcSide(st, S, exp, known, baseRows);
    const app = this.appSide(st, S, known.length);
    const sold = st
      .copiesRel(S)
      .filter((c) => {
        const d = st.val(`occ/${c}/disposal`);
        return st.status(c) === 'former' && typeof d === 'object' && d !== null && !Array.isArray(d) && ['sold', 'traded'].includes(d.reason as string);
      })
      .map((c) => (st.val(`occ/${c}/origin`) as string | null)?.split('#')[0]);
    const ids = mfc.rows.map((r) => r.id);
    const soldRow = sold.length === 0 ? undefined : (sold.find((id) => id !== undefined && ids.includes(id)) ?? [...ids].sort(byNum)[0]);
    st.acks.set(S, {
      mfc,
      app,
      mfcDigest: Server.digest(mfc),
      appDigest: Server.digest(app),
      align,
      ...(policy.disposition_list === undefined ? {} : { list: policy.disposition_list }),
      ...(soldRow === undefined ? {} : { soldRow }),
    });
  }

  /** ALIGN-MFC: what to change on MFC for it to hold the app's side, per MFC row. */
  private alignOf(st: Canon, S: string): { rev: string; actions: AlignAction[] } | null {
    const ack = st.acks.get(S);
    if (ack === undefined || !ack.align || Server.agree(ack.mfc, ack.app)) return null;
    const rows = [...ack.mfc.rows].sort((a, b) => byNum(a.id, b.id));
    const plan = rows.map((r) => ({ id: r.id, kind: r.count > 0 ? r.kind : (null as Kind | null), count: r.count }));
    const T = ack.app.counts;
    for (const k of KINDS) {
      const of = plan.filter((p) => p.kind === k);
      let excess = of.reduce((n, p) => n + p.count, 0) - T[k];
      for (const p of [...of].reverse()) {
        if (excess <= 0) break;
        const take = Math.min(excess, p.count);
        p.count -= take;
        excess -= take;
        if (p.count === 0) p.kind = null;
      }
    }
    for (const k of KINDS) {
      const of = plan.filter((p) => p.kind === k);
      const need = T[k] - of.reduce((n, p) => n + p.count, 0);
      if (need <= 0) continue;
      if (of.length > 0) of[0]!.count = Math.min(99, of[0]!.count + need);
      else {
        const free = plan.find((p) => p.kind === null);
        if (free !== undefined) {
          free.kind = k;
          free.count = Math.min(99, need);
        }
      }
    }
    const actions: AlignAction[] = [];
    rows.forEach((r, i) => {
      const p = plan[i]!;
      const was = r.count > 0 ? r.kind : null;
      const a: AlignAction = { mfc_id: r.id };
      if (was !== p.kind) a.status = { ...(was === null ? {} : { now: was }), ...(p.kind === null ? {} : { should: p.kind }) };
      if (p.kind !== null && (was === null || r.count !== p.count)) a.count = { ...(was === null ? {} : { now: r.count }), should: p.count };
      if (p.kind !== null)
        for (const f of FIELDS) {
          const now = r.fields[f] ?? null;
          const should = ack.app.fields[f];
          if (!eq(now, should)) a[f] = { ...(now === null ? {} : { now }), ...(should === null ? {} : { should }) };
        }
      if (ack.list !== undefined && ack.soldRow === r.id) a.add_to_list = ack.list;
      if (Object.keys(a).length > 1) actions.push(a);
    });
    if (actions.length === 0) return null;
    const rev = `A:${stable(actions)}`;
    if (ack.dismissed === rev) return null;
    return { rev, actions };
  }

  /** R4: after a settled decision, a difference of the projection is the app's: one divergence item. */
  private diverge(st: Canon, S: string, exp: Map<string, Row>, known: readonly string[], baseRows: Map<string, RowBase>, I: Import): void {
    const mfc = this.mfcSide(st, S, exp, known, baseRows);
    const app = this.appSide(st, S, known.length);
    const item = st.conflicts.get(S);
    if (Server.agree(mfc, app)) {
      if (item?.kind === 'divergence') st.conflicts.delete(S);
      st.acks.delete(S);
      return;
    }
    const ack = st.acks.get(S);
    if (ack !== undefined && ack.mfcDigest === Server.digest(mfc) && ack.appDigest === Server.digest(app)) {
      if (item?.kind === 'divergence') st.conflicts.delete(S);
      return;
    }
    st.acks.delete(S);
    const rev = `D:${Server.digest(mfc)}:${Server.digest(app)}`;
    if (item?.kind === 'divergence' && item.rev === rev) return;
    const M = zero();
    for (const r of exp.values()) M[r.kind] += r.count;
    st.conflicts.set(S, { kind: 'divergence', rev, exp, expFields: '', B: M, M, comps: {}, import: I.n, known: [...known] });
  }

  // ---------------------------------------------------------- inputs
  private applyEdit(st: Canon, e: Edit): void {
    const cur = st.facets.get(e.key);
    if (cur === undefined || gt(e.version, cur[1])) st.facets.set(e.key, [e.value, e.version]);
    this.recheck(st, e, e.version);
  }

  /** 6.3: a knowing edit may make a pending conflict's sides agree. */
  private recheck(st: Canon, e: Edit, ver: Version): void {
    for (const S of [...this.figsOf(e, st)].sort()) {
      const cf = st.conflicts.get(S);
      if (cf === undefined || cf.kind !== 'conflict') continue;
      const d = decide(st, S, cf.exp, this.sw);
      if (d.status !== 'conflict' && !this.sw.M7) {
        applyOps(st, d.ops, ver);
        st.conflicts.delete(S);
        st.decisions.push([`edit ${e.key}`, S, 'conflict closed: sides agree']);
      }
      this.emitItems(st, S, ver);
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

  private lateList(I: Import, S: string, st: Canon): number[] {
    return this.inputs
      .filter((e): e is Edit => e.type === 'edit' && e.arr > I.arr && !e.held && this.figsOf(e, st).has(S) && (I.lastSeq.get(S) ?? 0) > e.basis)
      .map((e) => e.arr)
      .sort((a, b) => a - b);
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
    const figs = new Set([...rows.map((r) => st.surv(r.head)), ...[...st.rowBase.values()].map((b) => st.surv(b.head))]);
    for (const S of [...figs].sort()) {
      const exp = rowsFor(st, S, rows);
      const baseRows = baseRowsFor(st, S);
      const known = [...new Set([...exp.keys(), ...baseRows.keys()])].sort(byNum);
      const d = decide(st, S, exp, this.sw);
      const cf = st.conflicts.get(S);
      const writes = d.ops.some((op) => USER_WRITES.has(op[0]));
      const favor = I.policy.import_policy !== 'ASK' && (d.status === 'conflict' || (this.sw.favorAll === true && writes && baseRows.size > 0));
      if (d.status === 'conflict' && !favor) {
        const late = this.lateList(I, S, st);
        const expFields = stable(Object.fromEntries([...exp].map(([r, row]) => [r, row.fields])));
        let rev = `I${I.n}:${stable(d.M)}:${expFields}:late${stable(late)}`;
        let raised = I.n;
        if (cf?.kind === 'conflict' && eq(cf.M, d.M) && cf.expFields === expFields && late.length === 0) [rev, raised] = [cf.rev, cf.import];
        st.conflicts.set(S, { kind: 'conflict', rev, exp, expFields, B: d.B, M: d.M, comps: d.comps, import: raised, known });
        st.acks.delete(S);
        st.decisions.push([`import#${I.n}`, S, 'conflict']);
      } else if (favor) {
        // R5: the preference answers a true conflict itself; the change entry records it, undoable like an answer
        const choice = I.policy.import_policy === 'FAVOR_APP' ? 'keep' : 'take';
        const before = this.snapshot(st);
        applyOps(st, answerOps(st, S, exp, choice, this.sw), I.version);
        applyOps(st, realign(st, S, exp), I.version);
        const { writes: w, undo } = this.diff(st, before);
        const kind = choice === 'keep' ? 'favor_app' : 'favor_mfc';
        const shown = choice === 'keep' ? this.writesOf(st, S, this.takeSettled(st, S, exp)) : undo;
        st.changes.set(S, { kind, rev: `C${I.n}:${kind}:${stable(w)}`, import: I.n, writes: w, undo: shown, exp });
        st.conflicts.delete(S);
        this.acknowledge(st, S, exp, known, baseRows, choice === 'keep', I.policy);
        st.decisions.push([`import#${I.n}`, S, kind]);
      } else if (d.status === 'apply' && writes && baseRows.size > 0 && I.policy.mfc_only === 'HOLD' && !this.sw.ignoreHold) {
        // R3: a change only MFC made, held for confirmation: nothing written, no base moved
        const expFields = stable(Object.fromEntries([...exp].map(([r, row]) => [r, row.fields])));
        const rev = `M${I.n}:${stable(d.M)}:${expFields}`;
        const keepRev = cf?.kind === 'mfc_change' && eq(cf.M, d.M) && cf.expFields === expFields;
        st.conflicts.set(S, keepRev ? cf : { kind: 'mfc_change', rev, exp, expFields, B: d.B, M: d.M, comps: d.comps, import: I.n, known });
        st.acks.delete(S);
        st.decisions.push([`import#${I.n}`, S, 'mfc_change held']);
      } else {
        const before = this.snapshot(st);
        applyOps(st, d.ops, I.version);
        if (cf !== undefined && cf.kind !== 'divergence') st.conflicts.delete(S);
        if (writes && baseRows.size > 0) {
          const { writes: w, undo } = this.diff(st, before);
          st.changes.set(S, { kind: 'applied', rev: `C${I.n}:applied:${stable(w)}`, import: I.n, writes: w, undo, exp });
        }
        this.diverge(st, S, exp, known, baseRows, I);
        st.decisions.push([`import#${I.n}`, S, d.status]);
      }
      this.emitItems(st, S, I.version);
    }
    if (this.sw.divergeWithoutId) {
      const loose = new Set<string>();
      for (const c of st.copies()) {
        const h = st.head(c);
        if (h !== null && st.status(c) !== null && !figs.has(st.surv(h))) loose.add(st.surv(h));
      }
      for (const S of [...loose].sort()) {
        const app = this.appSide(st, S, 3);
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
    if (cf !== undefined && (cf.rev === R.rev || this.sw.M9)) this.answerFigure(st, S, cf, R, policy);
    else if (R.rev !== null && R.rev.startsWith('H:')) this.answerHeld(st, S, R);
    else if (st.changes.get(S)?.rev === R.rev) this.answerChange(st, S, st.changes.get(S)!, R, policy);
    else if (R.rev !== null && this.alignOf(st, S)?.rev === R.rev && R.choice === 'dismiss') {
      if (!this.sw.forgetDismiss) st.acks.get(S)!.dismissed = R.rev;
      R.accepted = true;
    }
    st.decisions.push([`answer ${R.choice}`, S, R.accepted ? 'accepted' : 'STALE']);
    this.emitItems(st, S, R.version);
  }

  private answerFigure(st: Canon, S: string, cf: Card, R: Answer, policy: Policy): void {
    const allowed: Record<Card['kind'], Choice[]> = { conflict: ['keep', 'take', 'per_copy'], mfc_change: ['take', 'keep'], divergence: ['keep', 'take'] };
    if (!allowed[cf.kind].includes(R.choice)) return;
    const baseRows = baseRowsFor(st, S);
    const known = [...new Set([...cf.exp.keys(), ...baseRows.keys(), ...cf.known])].sort(byNum);
    if (cf.kind === 'mfc_change' && R.choice === 'take') {
      const d = decide(st, S, cf.exp, this.sw);
      if (d.status === 'conflict') {
        st.conflicts.set(S, { ...cf, kind: 'conflict', rev: `I${cf.import}:${stable(d.M)}:${cf.expFields}:answered${R.arr}`, B: d.B, M: d.M, comps: d.comps });
        return;
      }
      applyOps(st, d.ops, R.version);
      st.conflicts.delete(S);
      R.accepted = true;
      return;
    }
    if (cf.kind === 'divergence' && R.choice === 'keep') {
      st.conflicts.delete(S);
      this.acknowledge(st, S, cf.exp, known, baseRows, true, policy);
      R.accepted = true;
      return;
    }
    const choice = cf.kind === 'mfc_change' ? 'keep' : R.choice;
    if (cf.kind === 'conflict') applyOps(st, answerOps(st, S, cf.exp, choice, this.sw, R.copies, R.fields), R.version);
    else if (R.choice === 'take') applyOps(st, this.takeSettled(st, S, cf.exp), R.version);
    applyOps(st, realign(st, S, cf.exp), R.version);
    st.conflicts.delete(S);
    this.acknowledge(st, S, cf.exp, known, baseRows, R.choice !== 'take', policy);
    R.accepted = true;
  }

  private answerHeld(st: Canon, S: string, R: Answer): void {
    const es = this.heldOn(st, S, R.arr);
    if (es.length === 0 || this.heldRev(es) !== R.rev || !['keep', 'take'].includes(R.choice)) return;
    for (const e of es) {
      st.heldAnswered.add(e.arr);
      if (R.choice === 'keep') {
        st.set(e.key, e.value, R.version);
        this.recheck(st, e, R.version);
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
      applyOps(st, this.takeSettled(st, S, ch.exp), R.version);
      applyOps(st, realign(st, S, ch.exp), R.version);
      st.acks.delete(S);
    } else {
      if (!ch.writes.every((w) => eq(st.val(w.key), w.value))) return;
      for (const u of ch.undo) st.set(u.key, u.value, R.version);
      const baseRows = baseRowsFor(st, S);
      this.acknowledge(st, S, ch.exp, [...new Set([...ch.exp.keys(), ...baseRows.keys()])].sort(byNum), baseRows, true, policy);
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
    return I?.policy ?? { import_policy: 'ASK', mfc_only: 'APPLY_AND_LIST' };
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
      rows: rows.map((r) => ({ ...r, fields: { ...r.fields } })),
      keepIds: [...(opts.keepIds ?? [])],
      t,
      n: this.nImports,
      version: [t, this.nImports, '0', 0],
      arr: this.inputs.length,
      lastSeq: new Map(),
      policy: {
        import_policy: pref?.import_policy ?? 'ASK',
        mfc_only: pref?.mfc_only ?? 'APPLY_AND_LIST',
        ...(pref?.disposition_list === undefined ? {} : { disposition_list: pref.disposition_list }),
      },
    };
    this.inputs.push(I);
    const n0 = this.feed.length;
    for (const [seq, k] of this.recompute(t)) for (const f of this.figsOfKey(k, this.canon!)) I.lastSeq.set(f, Math.max(I.lastSeq.get(f) ?? 0, seq));
    if (!this.sw.noMarker) {
      // F1: the marker, last; a frame for every figure the import decided, written to or not
      this.emit(MARKER, { import: I.n }, [t, 10_000_000 + this.feed.length + 1, '0', 0]);
      const seq = this.feed.length;
      const st = this.canon!;
      for (const f of new Set([...I.rows.map((r) => st.surv(r.head)), ...[...st.rowBase.values()].map((b) => st.surv(b.head))]))
        I.lastSeq.set(f, Math.max(I.lastSeq.get(f) ?? 0, seq));
    }
    this.commit(n0);
    return I;
  }

  redirect(head: string, survivor: string, t: number): void {
    this.inputs.push({ type: 'redirect', head, survivor, arr: this.inputs.length });
    const n0 = this.feed.length;
    this.recompute(t);
    this.commit(n0);
  }

  push(items: readonly Pushable[], t: number): PushResult[] {
    if (items.length === 0) return [];
    for (const it of items) {
      it.arr = this.inputs.length;
      this.arrSeq.set(it.arr, this.feed.length + 1);
      this.inputs.push(it);
    }
    const n0 = this.feed.length;
    const out = this.recompute(t);
    this.commit(n0);
    const own = new Set(items.filter((it) => it.type === 'edit').map((it) => it.key));
    for (const [seq, k] of out) {
      if (own.has(k) || isItemKey(k)) continue;
      for (const f of this.figsOfKey(k, this.canon!)) this.epochHist.set(f, [...(this.epochHist.get(f) ?? []), seq]);
    }
    for (const it of items) {
      if (it.type !== 'answer') continue;
      for (const [seq, k] of out) if (k === CARD + it.fig) it.lastSeq.set(it.fig, seq);
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
    for (const kind of ['conflict', 'mfc_change', 'divergence'] as const) {
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
    return { review, applied };
  }
}
