// import.proto's re-import rules (ROWS, THE THREE-WAY RULE, ER MERGES, A ROW'S COPIES, FILING), written
// the simplest way so golden/import-vectors.json `reimports` are executed here, not only stated. Ids and
// heads are abstract names (occ ids order by their names), values are abstract, and v/baseV are version
// ranks: every write of this import is at IMPORT_V, above any rank a case starts with.
import { canonicalMfcId } from '../../src/index.js';

export type Kind = 'owned' | 'ordered' | 'wished' | 'former';
export type FigureField = 'score' | 'note' | 'wishability';
export interface Copy {
  occ: string;
  /** The origin facet: the canonical MFC id and ordinal. Absent on a copy added in the app. */
  origin?: { id: string; ordinal: number };
  head: string;
  status: Kind | null;
  filing?: string;
  base?: { head: string | null; status: Kind | null };
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
  copies: Record<string, Copy>;
  figures: Figures;
  conflicts: string[];
  writes: string[];
  unresolved: { line: number; reason: string }[];
}

export const IMPORT_V = 100;
const KIND_OF = { Owned: 'owned', Ordered: 'ordered', Wished: 'wished' } as const;
const FIELDS: readonly FigureField[] = ['score', 'note', 'wishability'];
const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const byOcc = (a: Copy, b: Copy) => (a.occ < b.occ ? -1 : a.occ > b.occ ? 1 : 0);
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

export function reimport(c: ReimportCase): ReimportResult {
  const survivor = (h: string): string => {
    let x = h;
    for (let hop = 0; hop < 64 && c.survivors?.[x] !== undefined; hop++) x = c.survivors[x]!;
    return x;
  };
  // ER MERGES: heads are equal when they resolve to one survivor.
  const sameHead = (a: string | null | undefined, b: string | null | undefined) =>
    a == null || b == null ? same(a, b) : survivor(a) === survivor(b);
  const copies = new Map(c.copies.map((x) => [x.occ, structuredClone(x)]));
  const start = new Map(c.copies.map((x) => [x.occ, structuredClone(x)]));
  const figures: Figures = structuredClone(c.figures ?? {});
  const writes = new Set<string>();
  const conflicts = new Set<string>();
  const unresolved: { line: number; reason: string }[] = [];

  // ROWS: canonical id, first row stands, Count, product; an unresolved row's id is left alone.
  const rows = new Map<string, { kind: Kind; count: number; figure: string; row: ExportRow }>();
  const seen = new Set<string>();
  const skipped = new Set<string>();
  for (const r of c.export) {
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
      skipped.add(id);
      continue;
    }
    rows.set(id, { kind: KIND_OF[r.status], count, figure: survivor(r.head!), row: r });
  }

  const setStatus = (x: Copy, status: Kind | null) => {
    x.status = status;
    writes.add(`occ/${x.occ}/status`);
    // FILING: an upsert to a kind the filing is not of resets it to {status}/default.
    if (status !== null && x.filing !== undefined && x.filing.split('/')[0] !== status) {
      x.filing = `${status}/default`;
      writes.add(`occ/${x.occ}/collection`);
    }
  };

  const originIds = [...copies.values()].flatMap((x) => (x.origin === undefined ? [] : [x.origin.id]));
  for (const id of [...new Set([...rows.keys(), ...originIds])].sort(byId)) {
    if (skipped.has(id)) continue;
    const row = rows.get(id);
    const ofRow = () => [...copies.values()].filter((x) => x.origin?.id === id).sort(byOcc);
    const baseLive = ofRow().filter((x) => x.base?.status != null);
    const kindB = baseLive[0]?.base!.status ?? null;
    const countB = baseLive.length;
    // UNCHANGED: status and head at the start equal their bases at the start.
    const unchanged = (x: Copy) => {
      const s = start.get(x.occ);
      return s !== undefined && same(s.status, s.base?.status) && sameHead(s.head, s.base?.head);
    };
    const M = row === undefined ? 0 : row.count;
    const kind = M === 0 ? kindB : row!.kind;
    const baseHead = ofRow().map((x) => start.get(x.occ)?.base?.head).find((h) => h != null);
    const figure = row?.figure ?? (baseHead == null ? undefined : survivor(baseHead));

    // HEAD: the three-way on each copy's head, M being the row's figure.
    if (row !== undefined) {
      for (const x of ofRow()) {
        if (x.base?.head == null || sameHead(row.figure, x.base.head)) continue;
        if (sameHead(x.head, x.base.head)) {
          x.head = row.figure;
          writes.add(`occ/${x.occ}/head`);
        } else if (!sameHead(x.head, row.figure)) conflicts.add(`occ/${x.occ}/head`);
        x.base.head = row.figure;
      }
    }

    // KIND: the three-way on each base copy's status, M being the row's kind.
    if (M > 0 && kindB !== null && kindB !== kind) {
      for (const x of baseLive) {
        if (same(x.status, x.base!.status)) setStatus(x, kind);
        else if (!same(x.status, kind)) conflicts.add(`occ/${x.occ}/status`);
        x.base!.status = kind;
      }
    }

    // COUNT.
    if (kind === null || M === countB) continue;
    const liveOfKind = () => ofRow().filter((x) => x.status === kind && survivor(x.head) === figure);
    const A = liveOfKind().length;
    const raisedAdd: Copy[] = [];
    const raisedRemove: Copy[] = [];
    const nextOrdinal = () => {
      const used = new Set(ofRow().map((x) => x.origin!.ordinal));
      let k = 1;
      while (used.has(k)) k++;
      return k;
    };
    const mint = (live: boolean): Copy => {
      const k = nextOrdinal();
      const x: Copy = { occ: `new:${k}`, origin: { id, ordinal: k }, head: figure!, status: null };
      copies.set(x.occ, x);
      writes.add(`occ/${x.occ}/origin`).add(`occ/${x.occ}/head`);
      if (live) setStatus(x, kind);
      return x;
    };
    if (A === M) {
      // Only bases move.
    } else if (A === countB) {
      // Only MFC changed the count: PICKS, never a copy the app changed.
      let d = M - A;
      for (const x of ofRow()) {
        if (d > 0 && unchanged(x) && x.status === null && survivor(x.head) === figure) {
          setStatus(x, kind);
          d--;
        }
      }
      for (const x of [...copies.values()].sort(byOcc)) {
        if (d > 0 && x.origin === undefined && x.status === kind && survivor(x.head) === figure) {
          x.origin = { id, ordinal: nextOrdinal() };
          writes.add(`occ/${x.occ}/origin`);
          d--;
        }
      }
      for (; d > 0; d--) mint(true);
      let r = A - M;
      for (const x of liveOfKind().reverse()) {
        if (r > 0 && unchanged(x)) {
          setStatus(x, null);
          r--;
        }
      }
      for (const x of liveOfKind().reverse()) if (r-- > 0) raisedRemove.push(x);
    } else if (M > A) {
      let d = M - A;
      for (const x of ofRow()) if (d > 0 && x.status === null && survivor(x.head) === figure && d--) raisedAdd.push(x);
      for (; d > 0; d--) raisedAdd.push(mint(false));
    } else {
      const live = liveOfKind().reverse();
      raisedRemove.push(...[...live.filter(unchanged), ...live.filter((x) => !unchanged(x))].slice(0, A - M));
    }
    for (const x of [...raisedAdd, ...raisedRemove]) conflicts.add(`occ/${x.occ}/status`);
    // The row's bases then describe MFC.
    for (const x of ofRow()) {
      const keeps = raisedAdd.includes(x) || (x.status === kind && survivor(x.head) === figure && !raisedRemove.includes(x));
      x.base = { head: keeps ? figure! : (x.base?.head ?? null), status: keeps ? kind : null };
    }
  }

  // Figure values: per survivor, K is rule 6's write target, B the latest base, A the displayed value, equal
  // versions ordering by head_id (the lower first); M is B when a row of the survivor states it, else the
  // numerically lowest id's value.
  const leftAlone = new Set(
    c.copies.filter((x) => x.origin !== undefined && skipped.has(x.origin.id)).flatMap((x) => [x.head, x.base?.head ?? x.head].map(survivor)),
  );
  const stated = [...rows.entries()].sort(([a], [b]) => byId(a, b));
  const inPlay = new Set([
    ...stated.map(([, r]) => r.figure),
    ...Object.keys(figures).filter((h) => FIELDS.some((f) => figures[h]![f]?.baseV !== undefined)).map(survivor),
  ]);
  for (const s of inPlay) {
    if (leftAlone.has(s)) continue;
    const sources = stated.filter(([, r]) => r.figure === s).map(([, r]) => r.row);
    for (const f of FIELDS) {
      const heads = Object.keys(figures).filter((h) => survivor(h) === s && figures[h]![f] !== undefined);
      const newest = (rank: (h: string) => number) => (a: string, b: string) => rank(b) - rank(a) || (a < b ? -1 : 1);
      const live = heads.filter((h) => figures[h]![f]!.value !== null).sort(newest((h) => figures[h]![f]!.v!));
      const bases = heads.filter((h) => figures[h]![f]!.baseV !== undefined).sort(newest((h) => figures[h]![f]!.baseV!));
      const K = live[0] ?? s;
      const b = bases[0] === undefined ? null : (figures[bases[0]]![f]!.base ?? null);
      const m = sources.some((r) => same(r[f], b)) ? b : (sources[0]?.[f] ?? null);
      const a = live[0] === undefined ? null : figures[live[0]]![f]!.value;
      if (same(m, b)) continue;
      const cell = ((figures[K] ??= {})[f] ??= { value: null });
      if (same(a, b)) {
        for (const h of m === null ? live : [K]) {
          figures[h]![f]!.value = m;
          figures[h]![f]!.v = IMPORT_V;
          writes.add(`uf/${h}/${f}`);
        }
      } else if (!same(a, m)) conflicts.add(`uf/${K}/${f}`);
      cell.base = m;
      cell.baseV = IMPORT_V;
    }
  }

  return {
    copies: Object.fromEntries([...copies.values()].sort(byOcc).map((x) => [x.occ, x])),
    figures,
    conflicts: [...conflicts].sort(),
    writes: [...writes].sort(),
    unresolved,
  };
}
