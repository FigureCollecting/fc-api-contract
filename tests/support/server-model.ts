// import.proto's server-side import rules (THE SERVER DECIDES), written the simplest way so that
// golden/import-vectors.json is executed, not only stated. A port of the reviewed Python reference
// model (Design A). The server keeps every input (device edits with their basis, imports, answers,
// spine redirects) and derives its state by REPLAY in canonical order; after every input it diffs that
// state against what it has emitted and emits the difference as ordinary feed events.
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
export interface Card {
  rev: string;
  exp: Map<string, Row>;
  expFields: string;
  B: Counts;
  M: Counts;
  comps: Record<string, unknown>;
  import: number;
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
  conflicts = new Map<string, Card>();
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
        const deficit = (r: Row) => {
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
}
export type Pushable = Edit | Answer;

export class Server {
  readonly inputs: Input[] = [];
  readonly emitted = new Map<string, [Json, Version]>();
  readonly feed: FeedEvent[] = [];
  canon: Canon | undefined;
  nImports = 0;
  private readonly headHist = new Map<string, Set<string>>();
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
    for (const e of this.inputs) {
      if (e.type !== 'edit') continue;
      const figs = this.figsOf(e, prev);
      e.held = answers.some((r) => r.arr < e.arr && [...figs].some((f) => (r.lastSeq.get(f) ?? 0) > e.basis));
      if (e.held) continue;
      if (this.sw.M1) continue;
      const I = imports.find((I) => I.arr < e.arr && this.lateFor(I, e, figs));
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
    return st;
  }

  /** The digest a card is emitted from, and compared by. */
  cardValue(st: Canon, S: string): Json {
    const cf = st.conflicts.get(S);
    if (cf === undefined) return null;
    const summ = st.summary(S);
    return JSON.parse(
      stable({ rev: cf.rev, kind: 'conflict', import: cf.import, base: cf.B, mfc: cf.M, app: summ.counts, app_copies: summ.copies, comps: cf.comps }),
    ) as Json;
  }

  private emitCard(st: Canon, S: string, ver: Version): void {
    const v = this.cardValue(st, S);
    if (v === null) {
      if (st.val(CARD + S) !== null) st.set(CARD + S, null, ver);
      return;
    }
    st.set(CARD + S, v, ver);
  }

  private applyEdit(st: Canon, e: Edit): void {
    const cur = st.facets.get(e.key);
    if (cur === undefined || gt(e.version, cur[1])) st.facets.set(e.key, [e.value, e.version]);
    // a knowing edit may make a pending conflict's sides agree (6.3)
    for (const S of [...this.figsOf(e, st)].sort()) {
      const cf = st.conflicts.get(S);
      if (cf === undefined) continue;
      const d = decide(st, S, cf.exp, this.sw);
      if (d.status !== 'conflict' && !this.sw.M7) {
        applyOps(st, d.ops, e.version);
        st.conflicts.delete(S);
        st.decisions.push([`edit ${e.key}`, S, 'conflict closed: sides agree']);
      }
      this.emitCard(st, S, e.version);
    }
  }

  /** 4.3 ROW MOVED: the spine now resolves an MFC id to another figure (not a merge). */
  private rowMoved(st: Canon, I: Import): void {
    for (const r of I.rows) {
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

  private applyImport(st: Canon, I: Import): void {
    const rows = [...I.rows];
    for (const id of I.keepIds) {
      const b = st.rowBase.get(id);
      if (b !== undefined && !rows.some((r) => r.id === id)) rows.push({ id, head: b.head, kind: b.kind, count: b.count, fields: { ...b.fields } });
    }
    this.rowMoved(st, { ...I, rows });
    const figs = new Set([...rows.map((r) => st.surv(r.head)), ...[...st.rowBase.values()].map((b) => st.surv(b.head))]);
    for (const S of [...figs].sort()) {
      const exp = rowsFor(st, S, rows);
      const d = decide(st, S, exp, this.sw);
      const cf = st.conflicts.get(S);
      if (d.status === 'conflict') {
        const late = this.lateList(I, S, st);
        const expFields = stable(Object.fromEntries([...exp].map(([r, row]) => [r, row.fields])));
        let rev = `I${I.n}:${stable(d.M)}:${expFields}:late${stable(late)}`;
        if (cf !== undefined && eq(cf.M, d.M) && cf.expFields === expFields && late.length === 0) rev = cf.rev;
        st.conflicts.set(S, { rev, exp, expFields, B: d.B, M: d.M, comps: d.comps, import: I.n });
        st.decisions.push([`import#${I.n}`, S, 'conflict']);
      } else {
        applyOps(st, d.ops, I.version);
        if (cf !== undefined) st.conflicts.delete(S);
        st.decisions.push([`import#${I.n}`, S, d.status]);
      }
      this.emitCard(st, S, I.version);
    }
  }

  private applyAnswer(st: Canon, R: Answer): void {
    const S = R.fig;
    const cf = st.conflicts.get(S);
    R.accepted = cf !== undefined && (this.sw.M9 || cf.rev === R.rev);
    if (!R.accepted) {
      st.decisions.push([`answer ${R.choice}`, S, 'STALE']);
      return;
    }
    applyOps(st, answerOps(st, S, cf!.exp, R.choice, this.sw, R.copies, R.fields), R.version);
    applyOps(st, realign(st, S, cf!.exp), R.version);
    st.conflicts.delete(S);
    st.decisions.push([`answer ${R.choice}`, S, 'resolved']);
    this.emitCard(st, S, R.version);
  }

  // ---------------------------------------------------------- emission
  private recompute(t: number): [number, string][] {
    const st = this.replay();
    this.canon = st;
    const out: [number, string][] = [];
    for (const k of [...new Set([...st.facets.keys(), ...this.emitted.keys()])].sort()) {
      const nv = st.facets.get(k);
      const val = nv === undefined ? null : nv[0];
      const old = this.emitted.get(k);
      if (eq(val, old === undefined ? null : old[0])) continue;
      let ver: Version;
      if (nv !== undefined && (old === undefined || gt(nv[1], old[1]))) ver = nv[1];
      else ver = [old === undefined ? t : Math.max(t, old[1][0]), 1_000_000 + this.feed.length, '0', 0];
      this.emitted.set(k, [val, ver]);
      const seq = this.feed.length + 1;
      this.feed.push({ seq, key: k, value: val, version: ver });
      out.push([seq, k]);
      if (k.endsWith('/head') && typeof val === 'string') {
        const c = k.split('/')[1]!;
        this.headHist.set(c, new Set([...(this.headHist.get(c) ?? []), val]));
      }
    }
    return out;
  }

  figsOfKey(k: string, st: Canon): Set<string> {
    if (k.startsWith(CARD)) return new Set([k.slice(CARD.length)]);
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

  // ---------------------------------------------------------- API
  /** Emit the state as it stands (a seeded start) without an input. */
  settle(t: number): void {
    this.recompute(t);
  }

  runImport(rows: readonly Row[], t: number, opts: { keepIds?: readonly string[] } = {}): Import {
    this.nImports++;
    const I: Import = {
      type: 'import',
      rows: rows.map((r) => ({ ...r, fields: { ...r.fields } })),
      keepIds: [...(opts.keepIds ?? [])],
      t,
      n: this.nImports,
      version: [t, this.nImports, '0', 0],
      arr: this.inputs.length,
      lastSeq: new Map(),
    };
    this.inputs.push(I);
    for (const [seq, k] of this.recompute(t)) for (const f of this.figsOfKey(k, this.canon!)) I.lastSeq.set(f, Math.max(I.lastSeq.get(f) ?? 0, seq));
    return I;
  }

  redirect(head: string, survivor: string, _t: number): void {
    this.inputs.push({ type: 'redirect', head, survivor, arr: this.inputs.length });
    this.recompute(_t);
  }

  push(items: readonly Pushable[], t: number): PushResult[] {
    if (items.length === 0) return [];
    for (const it of items) {
      it.arr = this.inputs.length;
      this.inputs.push(it);
    }
    const out = this.recompute(t);
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
      return { key: it.type === 'edit' ? it.key : it.key, current, outcome };
    });
  }

  // ---------------------------------------------------------- views
  live(c: string): Json {
    return this.emitted.get(`occ/${c}/status`)?.[0] ?? null;
  }
  pending(): string[] {
    return this.canon === undefined ? [] : [...this.canon.conflicts.keys()].sort();
  }
  /** The import's result for the client that requested it (R7): the review set and the applied changes. */
  importResult(_I: Import): ImportResult {
    return { review: [], applied: [] };
  }
  /** Pending figure items (imp/mfc/figure/{head}) by kind. */
  figureItems(): Record<string, string> {
    return Object.fromEntries(this.pending().map((S) => [S, 'conflict']));
  }
  /** Held-edit cards (imp/mfc/held/{head}): the keys each holds. */
  heldCards(): Record<string, string[]> {
    return {};
  }
  /** Change entries (imp/mfc/change/{head}) by kind. */
  changeEntries(): Record<string, string> {
    return {};
  }
  /** Align-MFC entries (imp/mfc/align/{head}): their actions. */
  alignEntries(): Record<string, AlignAction[]> {
    return {};
  }
  heldEdits(): [string, string][] {
    return (this.canon?.held ?? []).map((e) => [e.dev, e.key] as [string, string]).sort((a, b) => cmpStr(a.join(' '), b.join(' ')));
  }
}
