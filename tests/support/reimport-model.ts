// import.proto ROWS, and the harness for golden/import-vectors.json `reimports`: seed the server model with a
// case's copies (and their bases), figure values (and theirs) and spine survivors, run one import of the case's
// export, and report what the import wrote and carded. The import itself is server-model.ts.
import { canonicalMfcId } from '../../src/index.js';
import { Canon, OUT, Server, type Field, type Json, type Kind, type RowBase, type Row } from './server-model.js';

export type Status = Kind | 'former';
export type FigureField = Field;
export interface Copy {
  occ: string;
  /** The origin facet: the canonical MFC id and ordinal. Absent on a copy added in the app. */
  origin?: { id: string; ordinal: number };
  head: string;
  status: Status | null;
  filing?: string;
  /** The copy base the server holds (server-internal): its head and kind, status null for none. */
  base?: { head: string | null; status: Status | null };
}
export interface Cell {
  value: number | string | null;
  v?: number;
  base?: number | string | null;
  baseV?: number;
}
export type Figures = Record<string, Partial<Record<FigureField, Cell>>>;
export interface ExportRow {
  line: number;
  id: string;
  /** What the spine resolves the id to (a survivor), or null when it matches no product. */
  head: string | null;
  status: 'Owned' | 'Ordered' | 'Wished';
  count: string;
  score?: number;
  note?: string;
  wishability?: number;
}
export interface ReimportCase {
  name: string;
  survivors?: Record<string, string>;
  copies: Copy[];
  figures?: Figures;
  export: ExportRow[];
}
export interface ReimportResult {
  copies: Copy[];
  figures: Record<string, Partial<Record<FigureField, { value: Json; base?: Json }>>>;
  writes: string[];
  conflicts: string[];
  unresolved: { line: number; reason: string }[];
}

const KIND_OF = { Owned: 'owned', Ordered: 'ordered', Wished: 'wished' } as const;
const FIELDS: readonly Field[] = ['score', 'note', 'wishability'];

/** ROWS: canonical id, the first row of an id stands, Count, product. */
export function parseExport(rows: readonly ExportRow[]): { rows: Row[]; unresolved: { line: number; reason: string }[]; keepIds: string[] } {
  const out: Row[] = [];
  const unresolved: { line: number; reason: string }[] = [];
  const keepIds: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let id: string;
    try {
      id = canonicalMfcId(r.id);
    } catch {
      unresolved.push({ line: r.line, reason: 'invalid_id' });
      continue;
    }
    if (seen.has(id)) {
      unresolved.push({ line: r.line, reason: 'duplicate_id' });
      continue;
    }
    seen.add(id);
    const count = r.count === '' ? 1 : /^[0-9]+$/.test(r.count) ? Number(r.count) : Number.NaN;
    const reason = Number.isNaN(count) ? 'invalid_count' : count > 99 ? 'count_over_99' : r.head === null ? 'no_product' : undefined;
    if (reason !== undefined) {
      unresolved.push({ line: r.line, reason });
      keepIds.push(id);
      continue;
    }
    const fields: Row['fields'] = {};
    for (const f of FIELDS) if (r[f] !== undefined) fields[f] = r[f]!;
    out.push({ id, head: r.head!, kind: KIND_OF[r.status], count, fields });
  }
  return { rows: out, unresolved, keepIds };
}

/** The server state a case starts from: its copies, their bases, the row bases they imply, and the figure values. */
export function seed(c: ReimportCase): (st: Canon) => void {
  return (st) => {
    for (const [a, b] of Object.entries(c.survivors ?? {})) st.redirect.set(a, b);
    const V = (v: number | undefined): [number, number, string, number] => [v ?? 1, 0, '0', 0];
    const rows = new Map<string, { head: string; kind: Kind | null; count: number; fields: RowBase['fields'] }>();
    for (const x of c.copies) {
      if (x.origin !== undefined) st.facets.set(`occ/${x.occ}/origin`, [`${x.origin.id}#${x.origin.ordinal}`, V(1)]);
      st.facets.set(`occ/${x.occ}/head`, [x.head, V(1)]);
      st.facets.set(`occ/${x.occ}/status`, [x.status, V((x.base?.status ?? null) === x.status ? 1 : 2)]);
      if (x.filing !== undefined) st.facets.set(`occ/${x.occ}/collection`, [x.filing, V(1)]);
      if (x.base === undefined || x.base.head === null) continue;
      const bk = x.base.status;
      st.copyBase.set(x.occ, [x.base.head, bk === null || bk === 'former' ? OUT : bk]);
      if (bk === null && x.status === null && x.origin !== undefined) st.importRemoved.add(x.occ);
      if (x.origin !== undefined) {
        const r = rows.get(x.origin.id) ?? { head: x.base.head, kind: null, count: 0, fields: {} };
        if (bk !== null && bk !== 'former') {
          r.kind = bk;
          r.count++;
        }
        rows.set(x.origin.id, r);
      }
    }
    for (const [h, cells] of Object.entries(c.figures ?? {})) {
      for (const [f, cell] of Object.entries(cells) as [Field, Cell][]) {
        st.facets.set(`uf/${h}/${f}`, [cell.value, V(cell.v)]);
        if (cell.baseV !== undefined) {
          const m = st.fieldBase.get(h) ?? new Map<Field, Json>();
          m.set(f, cell.base ?? null);
          st.fieldBase.set(h, m);
        }
      }
    }
    for (const [rid, r] of rows) {
      for (const [h, fb] of st.fieldBase) {
        if (st.surv(h) === st.surv(r.head) && (h === r.head || !st.fieldBase.has(r.head))) for (const [f, v] of fb) if (!(f in r.fields)) r.fields[f] = v;
      }
      if (r.kind !== null) st.rowBase.set(rid, { head: r.head, kind: r.kind, count: r.count, fields: r.fields });
    }
  };
}

/** Run the case's export once on a server seeded with the case. */
export function reimport(c: ReimportCase): ReimportResult {
  const s = new Server({ namer: (_rid, k) => `new:${k}`, initial: seed(c) });
  s.settle(0);
  const n0 = s.feed.length;
  const { rows, unresolved, keepIds } = parseExport(c.export);
  s.runImport(rows, 100, { keepIds });
  const events = s.feed.slice(n0);
  const st = s.canon!;
  const copies: Copy[] = [...st.copies()].sort().map((occ) => {
    const o = st.val(`occ/${occ}/origin`);
    const b = st.copyBase.get(occ);
    const x: Copy = { occ, head: st.head(occ)!, status: st.status(occ) as Status | null };
    if (typeof o === 'string') {
      const [id, k] = o.split('#');
      return { occ, origin: { id: id!, ordinal: Number(k) }, ...stripOcc(x), ...rest(st, occ, b) };
    }
    return { ...x, ...rest(st, occ, b) };
  });
  const figures: ReimportResult['figures'] = {};
  for (const [k, [v]] of [...st.facets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!k.startsWith('uf/')) continue;
    const [, h, f] = k.split('/') as [string, string, Field];
    (figures[h] ??= {})[f] = { value: v };
  }
  for (const [h, fb] of st.fieldBase) for (const [f, v] of fb) ((figures[h] ??= {})[f] ??= { value: null }).base = v;
  return {
    copies,
    figures,
    writes: events.map((e) => e.key).filter((k) => k.startsWith('occ/') || k.startsWith('uf/')).sort(),
    // the figures this import carded as a conflict (a divergence, R4, is not a conflict)
    conflicts: events
      .filter((e) => e.key.startsWith('imp/mfc/figure/') && (e.value as { kind?: string } | null)?.kind === 'conflict')
      .map((e) => e.key.slice('imp/mfc/figure/'.length))
      .sort(),
    unresolved,
  };
}
const stripOcc = ({ occ: _o, ...x }: Copy) => x;
function rest(st: Canon, occ: string, b: [string, string] | undefined): Partial<Copy> {
  const out: Partial<Copy> = {};
  const fil = st.val(`occ/${occ}/collection`);
  if (typeof fil === 'string') out.filing = fil;
  if (b !== undefined) out.base = { head: b[0], status: b[1] === OUT ? null : (b[1] as Status) };
  return out;
}
