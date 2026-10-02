// The judge's exhaustive worlds (reset/judge/fuzz_a.py 1 and 2, fuzz2_a.py) on the server model: each case runs the
// path where the phone pushed first (REF) and the offline paths, and compares live copies per (figure, kind) and the
// pending figure items.
import { Device } from './replica-client.js';
import { Server, type Choice, type ItemKind, type Json, type Kind, type Row, type Switches } from './server-model.js';

const T = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
type Op = ['sell' | 'cancel' | 'repoint' | 'arrive', string] | ['add', Kind];
type Start = { n: number; k0: Kind; other: boolean; app: boolean };
type Path = 'REF' | 'OFF' | 'PULL1' | 'BETWEEN';

const row = (id: string, head: string, kind: Kind, count: number): Row => ({ id, head, kind, count, fields: {} });

function apply(d: Device, op: Op, t: number): void {
  if (op[0] === 'sell') d.edit(`occ/${op[1]}/status`, 'former', t);
  else if (op[0] === 'cancel') d.edit(`occ/${op[1]}/status`, null, t);
  else if (op[0] === 'repoint') d.edit(`occ/${op[1]}/head`, 'H1b', t);
  else if (op[0] === 'arrive') d.edit(`occ/${op[1]}/status`, 'owned', t);
  else {
    d.edit('occ/a1/head', 'H1', t);
    d.edit('occ/a1/status', op[1], t);
  }
}

/** Live copies per (head, kind) and the pending figure items: what the property compares. */
function outcome(s: Server): string {
  const counts: Record<string, number> = {};
  const occs = new Set([...s.emitted.keys()].filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!));
  for (const x of occs) {
    const st = s.emitted.get(`occ/${x}/status`)?.[0];
    const h = s.emitted.get(`occ/${x}/head`)?.[0];
    if ((st === 'owned' || st === 'ordered' || st === 'wished') && typeof h === 'string' && h !== '') counts[`${h} ${st}`] = (counts[`${h} ${st}`] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify([sorted, s.figureItems()]);
}
const pendingOf = (o: string) => Object.keys((JSON.parse(o) as [unknown, Record<string, string>])[1]).length > 0;
const countsOf = (o: string) => JSON.stringify((JSON.parse(o) as unknown[])[0]);

function combinations<X>(xs: readonly X[], r: number): X[][] {
  if (r === 0) return [[]];
  const out: X[][] = [];
  xs.forEach((x, i) => {
    for (const rest of combinations(xs.slice(i + 1), r - 1)) out.push([x, ...rest]);
  });
  return out;
}

// ------------------------------------------------------------------ worlds 1 and 2 (fuzz_a.py)
const namer1 = (r: string, k: number) => (r === '1144' && k <= 8 ? `o${k}` : r === '900' && k === 1 ? 'p1' : `n${r}:${k}`);
const exportOf = (st: Start, d: number, kind: Kind, d900: number): Row[] => [
  row('1144', 'H1', kind, Math.max(0, st.n + d)),
  ...(st.other ? [row('900', 'H1', st.k0, Math.max(0, 1 + d900))] : []),
];

function run1(start: Start, ops: readonly Op[], exps: readonly Row[][], path: Path, sw: Switches, staging: boolean): string {
  const s = new Server({ namer: namer1, switches: sw });
  s.runImport(exportOf(start, 0, start.k0, 0), T('09:00'));
  const p = new Device(s, 'P', { staging });
  p.pull();
  if (start.app) {
    p.edit('occ/a0/head', 'H1', T('09:10'));
    p.edit('occ/a0/status', start.k0, T('09:10'));
    p.push(T('09:11'));
    p.pull();
  }
  ops.forEach((op, j) => apply(p, op, T('10:00') + j));
  const times = ['11:00', '13:00'];
  if (path === 'REF') {
    p.push(T('10:30'));
    exps.forEach((e, i) => s.runImport(e, T(times[i]!)));
  } else if (path === 'OFF') {
    exps.forEach((e, i) => s.runImport(e, T(times[i]!)));
    p.push(T('14:00'));
  } else if (path === 'PULL1') {
    s.runImport(exps[0]!, T('11:00'));
    p.pull();
    p.push(T('11:30'));
    for (const e of exps.slice(1)) s.runImport(e, T('13:00'));
  } else {
    s.runImport(exps[0]!, T('11:00'));
    p.pull();
    for (const e of exps.slice(1)) {
      s.runImport(e, T('13:00'));
      p.pull();
    }
    p.push(T('14:00'));
  }
  p.pull();
  return outcome(s);
}

export interface Tally {
  runs: number;
  same: number;
  sameWithItem: number;
  silentCounts: number;
  silentItem: number;
  differsShown: number;
  first: string[];
}

export function world(imports: 1 | 2, opts: { sw?: Switches; staging?: boolean; every?: number; limit?: number } = {}): Tally {
  const sw = opts.sw ?? {};
  const staging = opts.staging ?? true;
  const every = opts.every ?? 1;
  const t: Tally = { runs: 0, same: 0, sameWithItem: 0, silentCounts: 0, silentItem: 0, differsShown: 0, first: [] };
  const paths: Path[] = imports === 2 ? ['OFF', 'PULL1', 'BETWEEN'] : ['OFF', 'PULL1'];
  let k = 0;
  for (const n of [1, 2, 3])
    for (const k0 of ['owned', 'ordered'] as Kind[])
      for (const other of [false, true])
        for (const app of [false, true]) {
          const start: Start = { n, k0, other, app };
          const copies = [...Array.from({ length: n }, (_, i) => `o${i + 1}`), ...(other ? ['p1'] : []), ...(app ? ['a0'] : [])];
          const edits: Op[] = [];
          for (const x of copies) edits.push(['sell', x], ['cancel', x], ['repoint', x], ...(k0 === 'ordered' ? [['arrive', x] as Op] : []));
          edits.push(['add', k0]);
          const chs: [string, Row[]][] = [];
          for (const d of [-2, -1, 0, 1]) {
            if (n + d < 0) continue;
            for (const kind of [k0, ...(k0 === 'ordered' ? ['owned' as Kind] : [])])
              for (const d9 of other ? [-1, 0] : [0]) chs.push([`${d},${kind},${d9}`, exportOf(start, d, kind, d9)]);
          }
          for (const r of [0, 1, 2]) {
            for (const ops of combinations(edits, r)) {
              const onCopies = ops.filter((o) => o[0] !== 'add');
              if (new Set(onCopies.map((o) => o[1])).size < onCopies.length) continue;
              const seqs: [string, Row[]][][] = imports === 1 ? chs.map((c) => [c]) : chs.flatMap((a) => chs.map((b) => [a, b]));
              for (const seq of seqs) {
                if (seq[0]![0] === `0,${k0},0`) continue;
                if (k++ % every !== 0) continue;
                if (opts.limit !== undefined && t.runs >= opts.limit) return t;
                const exps = seq.map((c) => c[1]);
                const ref = run1(start, ops, exps, 'REF', sw, staging);
                for (const path of paths) {
                  t.runs++;
                  const got = run1(start, ops, exps, path, sw, staging);
                  if (got === ref) {
                    if (pendingOf(ref)) t.sameWithItem++;
                    else t.same++;
                    continue;
                  }
                  const what = `${path} ${JSON.stringify(start)} ${JSON.stringify(ops)} ${seq.map((c) => c[0]).join(' | ')} got ${got} ref ${ref}`;
                  if (countsOf(got) !== countsOf(ref) && !pendingOf(got)) t.silentCounts++;
                  else if (!pendingOf(got) && pendingOf(ref)) t.silentItem++;
                  else {
                    t.differsShown++;
                  }
                  if (t.first.length < 5) t.first.push(what);
                }
              }
            }
          }
        }
  return t;
}

// ------------------------------------------------------------------ world 3: two devices (fuzz2_a.py)
const namer2 = (r: string, k: number) => (r === '1144' ? `o${k}` : `n${r}:${k}`);
export function twoDevices(opts: { sw?: Switches; staging?: boolean } = {}): Tally {
  const t: Tally = { runs: 0, same: 0, sameWithItem: 0, silentCounts: 0, silentItem: 0, differsShown: 0, first: [] };
  for (const n of [2, 3])
    for (const k0 of ['owned', 'ordered'] as Kind[]) {
      const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`);
      const ops: Op[] = [];
      const kinds: ('sell' | 'cancel' | 'repoint' | 'arrive')[] = ['sell', 'cancel', 'repoint', ...(k0 === 'ordered' ? (['arrive'] as const) : [])];
      for (const x of copies) for (const kind of kinds) ops.push([kind, x]);
      for (const opa of ops)
        for (const opb of ops) {
          if (opa[1] === opb[1]) continue;
          for (const d of [-2, -1, 1]) {
            if (n + d < 0) continue;
            for (const kind of [k0, ...(k0 === 'ordered' ? ['owned' as Kind] : [])]) {
              const res: Record<string, string> = {};
              for (const path of ['REF', 'OFF'] as const) {
                const s = new Server({ namer: namer2, switches: opts.sw ?? {} });
                s.runImport([row('1144', 'H1', k0, n)], T('09:00'));
                const P = new Device(s, 'P', { staging: opts.staging ?? true });
                const Tb = new Device(s, 'T', { staging: opts.staging ?? true });
                P.pull();
                Tb.pull();
                apply(P, opa, T('10:00'));
                apply(Tb, opb, T('10:05'));
                if (path === 'REF') {
                  P.push(T('10:30'));
                  Tb.push(T('10:31'));
                }
                s.runImport([row('1144', 'H1', kind, n + d)], T('11:00'));
                if (path === 'OFF') {
                  P.pull();
                  Tb.pull();
                  P.push(T('12:00'));
                  Tb.push(T('12:10'));
                }
                for (let i = 0; i < 2; i++) {
                  P.pull();
                  Tb.pull();
                }
                res[path] = outcome(s);
              }
              t.runs++;
              if (res.OFF === res.REF) {
                if (pendingOf(res.REF!)) t.sameWithItem++;
                else t.same++;
              } else if (!pendingOf(res.OFF!)) {
                t.silentCounts++;
                if (t.first.length < 5) t.first.push(`${n} ${k0} ${JSON.stringify([opa, opb])} ${d} ${kind} ${JSON.stringify(res)}`);
              } else t.differsShown++;
            }
          }
        }
    }
  return t;
}

// ------------------------------------------------------------------ world 4: late units and a knowing reaction (HELD)
type LateUnit = ['sell' | 'sell+disposal' | 'cancel' | 'tag', string] | ['add' | 'score', ''];
type Reaction = 'none' | 'readd' | 'tag-o1' | 'tag-o2' | 'sell-o2' | 'file-new' | 'score';
type RPath = 'REF' | 'OFF1' | 'OFF2';

function lateUnit(d: Device, u: LateUnit, t: number): void {
  const [op, x] = u;
  if (op === 'sell' || op === 'sell+disposal') d.edit(`occ/${x}/status`, 'former', t);
  if (op === 'sell+disposal') d.edit(`occ/${x}/disposal`, { reason: 'sold' }, t);
  if (op === 'cancel') d.edit(`occ/${x}/status`, null, t);
  if (op === 'tag') d.edit(`occ/${x}/tag/t1`, {}, t);
  if (op === 'add') {
    d.edit('occ/a1/head', 'H1', t);
    d.edit('occ/a1/status', 'owned', t);
  }
  if (op === 'score') d.edit('uf/H1/score', 9, t);
}

function react(d: Device, r: Reaction, n: number, t: number): void {
  if (r === 'readd') {
    d.edit('occ/a3/head', 'H1', t);
    d.edit('occ/a3/status', 'owned', t);
  } else if (r === 'tag-o1' || r === 'tag-o2') d.edit(`occ/${r.slice(4)}/tag/t9`, {}, t);
  else if (r === 'sell-o2') d.edit('occ/o2/status', 'former', t);
  else if (r === 'file-new') d.edit(`occ/o${n + 1}/collection`, 'owned/shelf-b', t);
  else if (r === 'score') d.edit('uf/H1/score', 7, t);
}

/** Live copies per (head, kind), the pending figure items, and the held edits. */
function reactionOutcome(s: Server): { counts: string; items: string; held: string[] } {
  const [counts, items] = JSON.parse(outcome(s)) as [unknown, unknown];
  return { counts: JSON.stringify(counts), items: JSON.stringify(items), held: Object.values(s.heldCards()).flat().sort() };
}

function runReaction(n: number, units: readonly LateUnit[], d: number, r: Reaction, path: RPath, sw: Switches) {
  const s = new Server({ namer: namer2, switches: sw });
  const P = new Device(s, 'P');
  const Tb = new Device(s, 'T');
  s.runImport([row('1144', 'H1', 'owned', n)], T('09:00'));
  P.pull();
  Tb.pull();
  units.forEach((u, j) => lateUnit(P, u, T('10:00') + j));
  const firstUnit = P.outbox.filter((e) => e.type === 'edit' && e.key.startsWith(units[0]![0] === 'add' ? 'occ/a1/' : units[0]![0] === 'score' ? 'uf/' : `occ/${units[0]![1]}/`)).length;
  if (path === 'REF') P.push(T('10:30'));
  s.runImport([row('1144', 'H1', 'owned', n + d)], T('11:00'));
  Tb.pull();
  react(Tb, r, n, T('11:10'));
  Tb.push(T('11:11'));
  if (path === 'OFF1') P.push(T('12:00'));
  if (path === 'OFF2') {
    // the two late units in two pushes: the second's relevance test must not undo the first's hold
    const rest = P.outbox.splice(firstUnit);
    P.push(T('12:00'));
    P.outbox.push(...rest);
    P.push(T('12:05'));
  }
  P.pull();
  Tb.pull();
  return reactionOutcome(s);
}

export interface ReactionTally {
  runs: number;
  same: number;
  sameCountsShown: number;
  differsShown: number;
  silent: number;
  /** With no reaction, anything but the pushed-first result (a hold with no reaction to justify it). */
  noReactionDiffers: number;
  first: string[];
}

/**
 * The phone makes one or two late units offline (a sale, a sale with its disposal, a cancel, a tag, an added copy, a
 * score), MFC changes the Count, the tablet pulls the import and reacts knowingly (or not), and the phone pushes its
 * units in one push or in two. REF: the phone pushed first. No path may differ from REF silently.
 */
export function reactionWorld(opts: { sw?: Switches } = {}): ReactionTally {
  const sw = opts.sw ?? {};
  const t: ReactionTally = { runs: 0, same: 0, sameCountsShown: 0, differsShown: 0, silent: 0, noReactionDiffers: 0, first: [] };
  for (const n of [1, 2, 3]) {
    const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`);
    const ops: LateUnit[] = [...copies.flatMap((x) => (['sell', 'sell+disposal', 'cancel', 'tag'] as const).map((op): LateUnit => [op, x])), ['add', ''], ['score', '']];
    const combos: LateUnit[][] = [...ops.map((u) => [u]), ...combinations(ops, 2).filter(([a, b]) => a![1] !== b![1] || a![1] === '')];
    for (const units of combos)
      for (const d of [-2, -1, 1]) {
        if (n + d < 0) continue;
        for (const r of ['none', 'readd', 'tag-o1', 'tag-o2', 'sell-o2', 'file-new', 'score'] as Reaction[]) {
          if ((r === 'tag-o2' || r === 'sell-o2') && n < 2) continue;
          if (r === 'file-new' && d < 1) continue;
          const ref = runReaction(n, units, d, r, 'REF', sw);
          for (const path of (units.length === 2 ? ['OFF1', 'OFF2'] : ['OFF1']) as RPath[]) {
            const got = runReaction(n, units, d, r, path, sw);
            t.runs++;
            const shown = got.held.length > 0 || got.items !== '{}';
            const what = `n=${n} ${JSON.stringify(units)} d=${d} T:${r} ${path} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`;
            if (got.counts === ref.counts && got.items === ref.items && got.held.length === 0) t.same++;
            else if (got.counts === ref.counts && shown) t.sameCountsShown++;
            else if (shown) t.differsShown++;
            else {
              t.silent++;
              if (t.first.length < 5) t.first.push(what);
            }
            if (r === 'none' && (got.counts !== ref.counts || got.items !== ref.items || got.held.length > 0)) {
              t.noReactionDiffers++;
              if (t.first.length < 10) t.first.push(`no reaction: ${what}`);
            }
          }
        }
      }
  }
  return t;
}


// ------------------------------------------------------------------ world 5: reactions to an item (HELD (i) and (ii))
// The tablet reacts only when the import showed it something for the figure (a figure item or a change entry), by hand
// or by an answer, and the phone's late unit arrives after the tablet's reaction (OFF-T) or before it (OFF-P). A path
// where the tablet did not react is compared with pushed-first and no reaction; one where it reacted, with pushed-first
// and the same conditional reaction. A STALE answer is shown: the client shows the item as it now is.
type ItemUnit = ['sell' | 'sell+disposal' | 'cancel' | 'tag', string] | ['add', ''];
type ItemReaction = 'none' | 'readd' | 'tag-o1' | 'sell-o1' | 'sell-o2' | 'sell-high' | 'reown' | 'take' | 'keep' | 'undo' | 'dismiss';
type ItemPath = 'REF' | 'OFF-T' | 'OFF-P';

const liveOn = (d: Device) =>
  [...d.replica.keys()]
    .filter((k) => k.startsWith('occ/') && k.endsWith('/status'))
    .map((k) => k.split('/')[1]!)
    .filter((c) => ['owned', 'ordered', 'wished'].includes(d.show(`occ/${c}/status`) as string) && d.show(`occ/${c}/head`) === 'H1')
    .sort();
const removedOn = (d: Device) =>
  [...d.replica.keys()]
    .filter((k) => k.startsWith('occ/') && k.endsWith('/head') && d.show(k) === 'H1')
    .map((k) => k.split('/')[1]!)
    .filter((c) => d.show(`occ/${c}/status`) === null && d.show(`occ/${c}/origin`) !== null)
    .sort();

/** The tablet's reaction, if the import showed it something: whether it reacted, and the copy a by-hand sale wrote. */
function reactToItem(Tb: Device, r: ItemReaction, t: number): { reacted: boolean; sold: string | null } {
  const no = { reacted: false, sold: null };
  const fig = Tb.show('imp/mfc/figure/H1');
  const ch = Tb.show('imp/mfc/change/H1');
  if ((fig === null && ch === null) || r === 'none') return no;
  if (r === 'readd') {
    Tb.edit('occ/a3/head', 'H1', t);
    Tb.edit('occ/a3/status', 'owned', t);
  } else if (r === 'tag-o1') Tb.edit('occ/o1/tag/t9', {}, t);
  else if (r === 'sell-o1' || r === 'sell-o2' || r === 'sell-high') {
    // by name, or by PICKS: the highest-id live copy the tablet shows
    const c = r === 'sell-high' ? liveOn(Tb).at(-1) : liveOn(Tb).includes(r.slice(5)) ? r.slice(5) : undefined;
    if (c === undefined) return no;
    Tb.edit(`occ/${c}/status`, 'former', t);
    return { reacted: true, sold: c };
  } else if (r === 'reown') {
    const c = removedOn(Tb).at(-1);
    if (c === undefined) return no;
    Tb.edit(`occ/${c}/status`, 'owned', t);
  } else if (r === 'take' || r === 'keep') {
    if (fig === null) return no;
    Tb.answer('H1', r, t);
  } else {
    if (ch === null) return no;
    Tb.answer('H1', r, t, {}, {}, 'change');
  }
  return { reacted: true, sold: null };
}

function runItemReaction(policy: string, pre: string, n: number, u: ItemUnit, d: number, r: ItemReaction, path: ItemPath, sw: Switches) {
  const s = new Server({ namer: namer2, switches: sw });
  const P = new Device(s, 'P');
  const Tb = new Device(s, 'T');
  Tb.edit('pref/mfc/import', { import_policy: policy }, T('08:00'));
  Tb.push(T('08:01'));
  s.runImport([row('1144', 'H1', 'owned', n)], T('09:00'));
  P.pull();
  Tb.pull();
  if (pre === 'appadd') {
    Tb.edit('occ/b1/head', 'H1', T('09:30'));
    Tb.edit('occ/b1/status', 'owned', T('09:30'));
  } else if (pre === 'appsell') Tb.edit(`occ/o${n}/status`, 'former', T('09:30'));
  Tb.push(T('09:31'));
  const [op, x] = u;
  if (op === 'sell' || op === 'sell+disposal') P.edit(`occ/${x}/status`, 'former', T('10:00'));
  if (op === 'sell+disposal') P.edit(`occ/${x}/disposal`, { reason: 'sold' }, T('10:00'));
  if (op === 'cancel') P.edit(`occ/${x}/status`, null, T('10:00'));
  if (op === 'tag') P.edit(`occ/${x}/tag/t1`, {}, T('10:00'));
  if (op === 'add') {
    P.edit('occ/a1/head', 'H1', T('10:00'));
    P.edit('occ/a1/status', 'owned', T('10:00'));
  }
  if (path === 'REF') P.push(T('10:30'));
  s.runImport([row('1144', 'H1', 'owned', n + d)], T('11:00'));
  Tb.pull();
  const { reacted, sold } = reactToItem(Tb, r, T('11:10'));
  if (path === 'OFF-P') P.push(T('11:20'));
  const stale = Tb.push(T('11:30')).some((x) => x.outcome === 'STALE') && ['take', 'keep', 'undo', 'dismiss'].includes(r);
  if (path === 'OFF-T') P.push(T('12:00'));
  for (let i = 0; i < 2; i++) {
    P.pull();
    Tb.pull();
  }
  const [counts, items] = JSON.parse(outcome(s)) as [unknown, unknown];
  // both devices took the same copy out, offline: plain concurrency on one copy, which no import decided
  const collision = sold !== null && sold === x && op !== 'tag';
  return { counts: JSON.stringify(counts), items: JSON.stringify(items), held: Object.values(s.heldCards()).flat().sort(), reacted, stale, collision };
}

export interface ItemReactionTally {
  runs: number;
  same: number;
  shown: number;
  silent: number;
  /** Counts equal, pushed-first has an item and this path shows nothing. */
  silentItem: number;
  /** The tablet's by-hand sale took the very copy the phone sold offline: counted apart, never silent. */
  collisions: number;
  reacted: number;
  first: string[];
}

/**
 * One late unit on the phone (a sale, a sale with its disposal, a cancel, a tag, an added copy), MFC changes the Count,
 * and the tablet, having pulled the import, reacts to the figure item or change entry it shows (ASK, FAVOR_APP and
 * FAVOR_MFC; the app unchanged, a copy added, or a copy sold before the import). No path may differ from its
 * pushed-first reference silently.
 */
export function itemReactionWorld(opts: { sw?: Switches } = {}): ItemReactionTally {
  const sw = opts.sw ?? {};
  const t: ItemReactionTally = { runs: 0, same: 0, shown: 0, silent: 0, silentItem: 0, collisions: 0, reacted: 0, first: [] };
  for (const policy of ['ASK', 'FAVOR_APP', 'FAVOR_MFC'])
    for (const pre of ['none', 'appadd', 'appsell'])
      for (const n of [1, 2, 3]) {
        const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`).filter((c) => !(pre === 'appsell' && c === `o${n}`));
        const units: ItemUnit[] = [...copies.flatMap((x) => (['sell', 'sell+disposal', 'cancel', 'tag'] as const).map((op): ItemUnit => [op, x])), ['add', '']];
        for (const u of units)
          for (const d of [-2, -1, 1]) {
            if (n + d < 0) continue;
            for (const r of ['none', 'readd', 'tag-o1', 'sell-o1', 'sell-o2', 'sell-high', 'reown', 'take', 'keep', 'undo', 'dismiss'] as ItemReaction[]) {
              const refR = runItemReaction(policy, pre, n, u, d, r, 'REF', sw);
              const refNone = runItemReaction(policy, pre, n, u, d, 'none', 'REF', sw);
              for (const path of ['OFF-T', 'OFF-P'] as ItemPath[]) {
                const got = runItemReaction(policy, pre, n, u, d, r, path, sw);
                const ref = got.reacted ? refR : refNone;
                t.runs++;
                if (got.reacted) t.reacted++;
                const shown = got.held.length > 0 || got.items !== '{}' || got.stale;
                if (got.counts === ref.counts && got.items === ref.items && got.held.length === 0) t.same++;
                else if (shown) t.shown++;
                else if (got.counts === ref.counts) {
                  t.silentItem++;
                  if (t.first.length < 5) t.first.push(`item: ${policy} ${pre} ${path} n=${n} ${JSON.stringify(u)} d=${d} T:${r} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
                } else if (got.collision) t.collisions++;
                else {
                  t.silent++;
                  if (t.first.length < 5) t.first.push(`${policy} ${pre} ${path} n=${n} ${JSON.stringify(u)} d=${d} T:${r} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
                }
              }
            }
          }
      }
  return t;
}

// ------------------------------------------------------------------ world 7: compound reactions (HELD (i) and (ii))
// The tablet answers the item it was shown (undo or dismiss a change entry, keep or take a figure item, dismiss an
// align-MFC entry) AND someone acts by hand on the same showing: the tablet itself, its outbox going as one push or as
// two (the answer first) with the phone's late unit between or after, or a third device U that pulled the same showing.
// Each offline path is compared with pushed-first plus the same conditional reactions, the other devices' pushes in the
// path's own order. When pushed-first the by-hand pick (the highest or lowest live copy) is the phone's own late copy,
// which the device could not see offline, the path is compared once more with pushed-first where the device takes out
// the copy it took out offline, by name: equal there, it is counted apart as a pick, never as silent.
type CAnswer = 'undo' | 'dismiss' | 'take' | 'keep' | 'dismiss-align';
type CHand = 'sell-high' | 'sell-low' | 'reown' | 'readd' | 'tag';
export type COrder = 'T-P' | 'P-T' | 'T1-P-T2' | 'T1-T2-P' | 'P-T1-T2' | 'T-P-U' | 'T-U-P' | 'P-T-U' | 'U-T-P' | 'U-P-T' | 'P-U-T';
/** Pushed-first: the phone's unit before the import, the other devices' pushes in the path's own order. */
type CRef = 'REF T' | 'REF T1-T2' | 'REF T-U' | 'REF U-T';
export interface CCase {
  policy: string;
  pre: string;
  n: number;
  u: [string, string];
  d: number;
  a: CAnswer;
  h: CHand;
  /** T: the tablet answers and acts by hand; TU: the tablet answers and U acts by hand. */
  who: 'T' | 'TU';
}
/** What a device shows for H1 when it acts by hand (its outbox then holds its answer at most, never an edit). */
const liveAndRemoved = (d: Device) => {
  const occs = [...new Set([...d.replica.keys()].filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!))].sort();
  return {
    live: occs.filter((c) => d.show(`occ/${c}/status`) === 'owned' && d.show(`occ/${c}/head`) === 'H1'),
    removed: occs.filter((c) => d.show(`occ/${c}/status`) === null && d.show(`occ/${c}/head`) === 'H1'),
  };
};

export function runCompound(c: CCase, path: CRef | COrder, allow: { a: boolean; h: boolean }, sw: Switches, byName?: string) {
  const s = new Server({ namer: namer2, switches: sw });
  const P = new Device(s, 'P');
  const Tb = new Device(s, 'T');
  const U = new Device(s, 'U');
  Tb.edit('pref/mfc/import', { import_policy: c.policy }, T('07:50'));
  Tb.push(T('07:51'));
  s.runImport([row('1144', 'H1', 'owned', c.n)], T('08:00'));
  for (const d of [P, Tb, U]) d.pull();
  if (c.pre === 'appadd') {
    Tb.edit('occ/b1/head', 'H1', T('08:10'));
    Tb.edit('occ/b1/status', 'owned', T('08:10'));
  } else if (c.pre === 'appsell') Tb.edit(`occ/o${c.n}/status`, 'former', T('08:10'));
  Tb.push(T('08:11'));
  const [op, x] = c.u;
  if (op === 'sell' || op === 'sell+disposal') P.edit(`occ/${x}/status`, 'former', T('08:20'));
  if (op === 'sell+disposal') P.edit(`occ/${x}/disposal`, { reason: 'sold' }, T('08:20'));
  if (op === 'cancel') P.edit(`occ/${x}/status`, null, T('08:20'));
  if (op === 'add') {
    P.edit('occ/a1/head', 'H1', T('08:20'));
    P.edit('occ/a1/status', 'owned', T('08:20'));
  }
  if (path.startsWith('REF')) P.push(T('08:30'));
  s.runImport([row('1144', 'H1', 'owned', Math.max(0, c.n + c.d))], T('10:00'));
  Tb.pull();
  const fig = Tb.show('imp/mfc/figure/H1');
  const ch = Tb.show('imp/mfc/change/H1');
  const al = Tb.show('imp/mfc/align/H1');
  let didA = false;
  if (allow.a) {
    if ((c.a === 'undo' || c.a === 'dismiss') && ch !== null) didA = true;
    if ((c.a === 'take' || c.a === 'keep') && fig !== null) didA = true;
    if (c.a === 'dismiss-align' && al !== null) didA = true;
    if (didA) Tb.answer('H1', c.a === 'dismiss-align' ? 'dismiss' : c.a, T('10:10'), {}, {}, c.a === 'dismiss-align' ? 'align' : c.a === 'undo' || c.a === 'dismiss' ? 'change' : 'figure');
  }
  const nA = Tb.outbox.length;
  // the by-hand device: the tablet, or U, which pulled the same showing
  const H = c.who === 'T' ? Tb : U;
  if (c.who === 'TU') U.pull();
  const shown = ['figure', 'change', 'align'].some((k) => H.show(`imp/mfc/${k}/H1`) !== null);
  let didH = '';
  if (allow.h && shown) {
    const { live, removed } = liveAndRemoved(H);
    const t = T('10:11');
    if (c.h === 'sell-high' || c.h === 'sell-low') {
      const o = byName ?? (c.h === 'sell-low' ? live[0] : live.at(-1));
      if (o !== undefined) {
        H.edit(`occ/${o}/status`, 'former', t);
        didH = o;
      }
    } else if (c.h === 'reown') {
      const o = removed.at(-1);
      if (o !== undefined) {
        H.edit(`occ/${o}/status`, 'owned', t);
        didH = 'reown';
      }
    } else if (c.h === 'readd') {
      H.edit('occ/r1/head', 'H1', t);
      H.edit('occ/r1/status', 'owned', t);
      didH = 'readd';
    } else if (live[0] !== undefined) {
      H.edit(`occ/${live[0]}/tag/t9`, {}, t);
      didH = 'tag';
    }
  }
  const res: string[] = [];
  const pT = (n?: number) => res.push(...Tb.push(T('11:00') + res.length, n).map((r) => r.outcome));
  const pP = () => res.push(...P.push(T('11:00') + res.length).map((r) => r.outcome));
  const pU = () => res.push(...U.push(T('11:00') + res.length).map((r) => r.outcome));
  const split = nA > 0 && Tb.outbox.length > nA;
  const seq: Record<CRef | COrder, (() => void)[]> = {
    'REF T': [() => pT()],
    'REF T1-T2': [() => pT(nA), () => pT()],
    'REF T-U': [() => pT(), pU],
    'REF U-T': [pU, () => pT()],
    'T-P': [() => pT(), pP],
    'P-T': [pP, () => pT()],
    'T1-P-T2': [() => pT(nA), pP, () => pT()],
    'T1-T2-P': [() => pT(nA), () => pT(), pP],
    'P-T1-T2': [pP, () => pT(nA), () => pT()],
    'T-P-U': [() => pT(), pP, pU],
    'T-U-P': [() => pT(), pU, pP],
    'P-T-U': [pP, () => pT(), pU],
    'U-T-P': [pU, () => pT(), pP],
    'U-P-T': [pU, pP, () => pT()],
    'P-U-T': [pP, pU, () => pT()],
  };
  for (const f of seq[path]) f();
  for (let i = 0; i < 2; i++) for (const d of [P, Tb, U]) d.pull();
  let counts = 0;
  for (const [k, v] of s.emitted) if (k.endsWith('/status') && v[0] === 'owned' && s.emitted.get(k.replace('/status', '/head'))?.[0] === 'H1') counts++;
  const items = JSON.stringify({ f: s.figureItems(), c: Object.keys(s.changeEntries()).sort(), a: Object.keys(s.alignEntries()).sort() });
  const held = Object.values(s.heldCards()).flat().length;
  return { counts, items, held, stale: didA && res.includes('STALE'), didA, didH, split, out: res.join(',') };
}

export interface CompoundTally {
  runs: number;
  same: number;
  sameCountsShown: number;
  differsShown: number;
  /** A by-hand pick the replay made differ, equal to pushed-first with the copy taken out by name. */
  picks: number;
  pickCases: string[];
  silent: number;
  /** Counts equal, pushed-first has an item and this path shows nothing. */
  silentItem: number;
  first: string[];
}

/**
 * One late unit on the phone (a sale, a sale with its disposal, a cancel, an added copy), MFC changes the Count by -2 to
 * +2, and the tablet answers what it shows while it, or a third device, acts by hand on the same showing (ASK, FAVOR_APP
 * and FAVOR_MFC; the app unchanged, a copy added, or a copy sold before the import). No path may differ from its
 * pushed-first reference silently. `every` runs every k-th case (CI); FC_PROPERTY_FULL runs them all.
 */
export function compoundReactionWorld(opts: { sw?: Switches; every: number }): CompoundTally {
  const sw = opts.sw ?? {};
  const every = opts.every;
  const t: CompoundTally = { runs: 0, same: 0, sameCountsShown: 0, differsShown: 0, picks: 0, pickCases: [], silent: 0, silentItem: 0, first: [] };
  const EMPTY = '{"f":{},"c":[],"a":[]}';
  const sameAs = (r: { counts: number; items: string }, g: { counts: number; items: string }) => r.counts === g.counts && r.items === g.items;
  let k = 0;
  for (const policy of ['ASK', 'FAVOR_APP', 'FAVOR_MFC'])
    for (const pre of ['none', 'appadd', 'appsell'])
      for (const n of [1, 2, 3]) {
        const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`).filter((x) => !(pre === 'appsell' && x === `o${n}`));
        const units: [string, string][] = [...copies.flatMap((x) => ['sell', 'sell+disposal', 'cancel'].map((op): [string, string] => [op, x])), ['add', '']];
        for (const u of units)
          for (const d of [-2, -1, 1, 2]) {
            if (n + d < 0) continue;
            for (const a of ['undo', 'dismiss', 'take', 'keep', 'dismiss-align'] as CAnswer[])
              for (const h of ['sell-high', 'sell-low', 'reown', 'readd', 'tag'] as CHand[])
                for (const who of ['T', 'TU'] as const) {
                  if (k++ % every !== 0) continue;
                  const c: CCase = { policy, pre, n, u, d, a, h, who };
                  const refs = new Map<string, ReturnType<typeof runCompound>>();
                  const orders: COrder[] = who === 'T' ? ['T-P', 'P-T', 'T1-P-T2', 'T1-T2-P', 'P-T1-T2'] : ['T-P-U', 'T-U-P', 'P-T-U', 'U-T-P', 'U-P-T', 'P-U-T'];
                  for (const path of orders) {
                    const got = runCompound(c, path, { a: true, h: true }, sw);
                    if (!got.split && path.includes('1')) continue; // one push: the same as T-P or P-T
                    const allow = { a: got.didA, h: got.didH !== '' };
                    const refPath = `REF ${path.split('-').filter((x) => x !== 'P').join('-')}` as CRef;
                    const key = `${allow.a}|${allow.h}|${refPath}`;
                    if (!refs.has(key)) refs.set(key, runCompound(c, refPath, allow, sw));
                    const ref = refs.get(key)!;
                    t.runs++;
                    if (got.counts === ref.counts && got.items === ref.items && got.held === 0) {
                      t.same++;
                      continue;
                    }
                    const shown = got.held > 0 || got.stale || (got.items !== ref.items && got.items !== EMPTY);
                    const what = `${JSON.stringify(c)} ${path} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`;
                    if (got.counts === ref.counts) {
                      if (shown) t.sameCountsShown++;
                      else {
                        t.silentItem++;
                        if (t.first.length < 5) t.first.push(`item: ${what}`);
                      }
                    } else if (shown) t.differsShown++;
                    else if (u[0] === 'add' && ref.didH === 'a1' && got.didH !== 'a1' && sameAs(runCompound(c, refPath, allow, sw, got.didH), got)) {
                      t.picks++;
                      if (t.pickCases.length < 20) t.pickCases.push(what);
                    }
                    else {
                      t.silent++;
                      if (t.first.length < 5) t.first.push(what);
                    }
                  }
                }
          }
      }
  return t;
}

// ------------------------------------------------------------------ world 8: reactions across two imports (HELD (i), (ii))
// Random scripts (adopted from the round-8 recheck's world 8): the phone makes one late unit before import 1 (late for
// both imports) or between the imports (late for import 2 only); the tablet and a third device U react between the
// imports and after import 2 (an answer of any kind, a by-hand sale, re-own, re-add or tag), a reaction made between the
// imports possibly pushed only after import 2 (so late itself); then the phone, the tablet (possibly in two pushes) and
// U push in a random order, with pulls between. Each script is compared with pushed-first (the phone pushes its unit
// just before the next import), every reaction there conditional on what its device shows and allowed only where it
// fired offline. SILENT: other live counts and nothing shown (no held card, no STALE answer, no item pushed-first lacks).
// Three differences are not silent, and are counted apart: a by-hand pick the device made among other copies (equal to
// pushed-first with the same copy taken by name); pushed-first holding another device's late reaction, where the path
// ends as pushed-first does once that card is answered; and a by-hand status write to the very copy the phone's unit
// wrote (both devices took out, or re-owned, one copy: plain concurrency).
type XHand = 'sell-high' | 'sell-low' | 'reown' | 'readd' | 'tag';
type XStep =
  | { op: 'import'; n: number }
  | { op: 'pull'; dev: string }
  | { op: 'edit'; dev: string; key: string; value: Json }
  | { op: 'unit'; kind: string; c: string }
  | { op: 'ans'; dev: string; a: 'undo' | 'dismiss' | 'take' | 'keep' | 'dismiss-align'; id: number }
  | { op: 'hand'; dev: string; h: XHand; id: number }
  | { op: 'push'; dev: string; n?: number };

/** A seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function crossImportScript(seed: number): { steps: XStep[]; desc: string } {
  const r = rng(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;
  const policy = pick(['ASK', 'ASK', 'FAVOR_APP', 'FAVOR_MFC']);
  const n = 1 + Math.floor(r() * 3);
  const pre = pick(['none', 'none', 'appadd', 'appsell']);
  const timing = pick(['before', 'between']);
  const d1 = pick([-1, 0, 1, -2, 2]);
  const d2 = pick([-1, 0, 0, 1]);
  const steps: XStep[] = [];
  let id = 0;
  steps.push({ op: 'edit', dev: 'T', key: 'pref/mfc/import', value: { import_policy: policy } }, { op: 'push', dev: 'T' });
  steps.push({ op: 'import', n }, { op: 'pull', dev: 'P' }, { op: 'pull', dev: 'T' }, { op: 'pull', dev: 'U' });
  if (pre === 'appadd') steps.push({ op: 'edit', dev: 'T', key: 'occ/b1/head', value: 'H1' }, { op: 'edit', dev: 'T', key: 'occ/b1/status', value: 'owned' }, { op: 'push', dev: 'T' });
  if (pre === 'appsell') steps.push({ op: 'edit', dev: 'T', key: `occ/o${n}/status`, value: 'former' }, { op: 'push', dev: 'T' });
  const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`).filter((x) => !(pre === 'appsell' && x === `o${n}`));
  const unit = (): XStep => {
    const kind = pick(['sell', 'selldisp', 'cancel', 'add', 'reown']);
    return { op: 'unit', kind, c: kind === 'add' ? 'a1' : pick(copies.length > 0 ? copies : ['o1']) };
  };
  if (timing === 'before') steps.push(unit());
  const c1 = Math.max(0, n + d1);
  steps.push({ op: 'import', n: c1 });
  const react = (dev: string, deferPush: boolean) => {
    if (r() < 0.8) steps.push({ op: 'pull', dev });
    const k = r();
    if (k < 0.4 || k >= 0.7) steps.push({ op: 'ans', dev, a: pick(['undo', 'dismiss', 'take', 'keep', 'dismiss-align', 'undo', 'keep'] as const), id: ++id });
    if (k >= 0.4) steps.push({ op: 'hand', dev, h: pick(['sell-high', 'sell-low', 'reown', 'readd', 'tag', 'sell-high'] as const), id: ++id });
    if (!deferPush) steps.push({ op: 'push', dev });
  };
  if (timing === 'between') steps.push({ op: 'pull', dev: 'P' }, unit());
  if (r() < 0.5) react('T', r() < 0.5);
  if (r() < 0.3) react('U', r() < 0.5);
  steps.push({ op: 'import', n: Math.max(0, c1 + d2) });
  if (r() < 0.85) react('T', true);
  if (r() < 0.6) react('U', true);
  // the pushes in a random order (V8's sort on three items: deterministic for a seed), the tablet possibly split
  const order = ['P', 'T', 'U'].sort(() => r() - 0.5);
  for (const d of order) {
    if (r() < 0.2) steps.push({ op: 'pull', dev: pick(['P', 'T', 'U']) });
    if (d === 'T' && r() < 0.3) steps.push({ op: 'push', dev: 'T', n: 1 });
    steps.push({ op: 'push', dev: d });
  }
  for (let i = 0; i < 2; i++) for (const d of ['P', 'T', 'U']) steps.push({ op: 'pull', dev: d });
  return { steps, desc: JSON.stringify({ policy, n, pre, timing, d1, d2 }) };
}

/** An answer a device gave: the item it named, the choice and the rev it saw. */
interface XAnswer {
  item: ItemKind;
  choice: Choice;
  rev: string;
}
interface XRun {
  counts: number;
  items: string;
  held: number;
  stale: boolean;
  fired: Set<number>;
  picks: Map<number, string>;
  answers: XAnswer[];
  unitKind: string;
  unitCopy: string;
}
/**
 * One script: offline (`ref` false) or pushed-first (the phone pushes its unit just before the next import), with only
 * the `allow`ed reactions, by-hand sales by name where `byName` says, and at the end each held card answered where
 * `answerHeld` says, or the `later` answers given again to the items still pending with the rev they named.
 */
export function runCrossImport(steps: readonly XStep[], sw: Switches, ref: boolean, allow?: Set<number>, byName?: Map<number, string>, answerHeld?: 'keep' | 'take', later?: readonly XAnswer[]): XRun {
  const s = new Server({ namer: namer2, switches: sw });
  const devs: Record<string, Device> = { P: new Device(s, 'P'), T: new Device(s, 'T'), U: new Device(s, 'U') };
  let t = T('08:00');
  const fired = new Set<number>();
  const picks = new Map<number, string>();
  const answers: XAnswer[] = [];
  const res: string[] = [];
  let unitKind = '';
  let unitCopy = '';
  let pendingP = false;
  const push = (d: Device, n?: number) => res.push(...d.push(t, n).map((x) => x.outcome));
  for (const st of steps) {
    t++;
    if (st.op === 'import') {
      if (pendingP) push(devs.P!);
      pendingP = false;
      s.runImport([row('1144', 'H1', 'owned', st.n)], t);
    } else if (st.op === 'pull') devs[st.dev]!.pull();
    else if (st.op === 'edit') devs[st.dev]!.edit(st.key, st.value, t);
    else if (st.op === 'push') push(devs[st.dev]!, st.n);
    else if (st.op === 'unit') {
      const P = devs.P!;
      unitKind = st.kind;
      unitCopy = st.c;
      if (st.kind === 'sell' || st.kind === 'selldisp') P.edit(`occ/${st.c}/status`, 'former', t);
      if (st.kind === 'selldisp') P.edit(`occ/${st.c}/disposal`, { reason: 'sold' }, t);
      if (st.kind === 'cancel') P.edit(`occ/${st.c}/status`, null, t);
      if (st.kind === 'reown') P.edit(`occ/${st.c}/status`, 'owned', t);
      if (st.kind === 'add') {
        P.edit('occ/a1/head', 'H1', t);
        P.edit('occ/a1/status', 'owned', t);
      }
      pendingP = ref;
    } else if (allow !== undefined && !allow.has(st.id)) continue;
    else if (st.op === 'ans') {
      const d = devs[st.dev]!;
      const item = st.a === 'dismiss-align' ? 'align' : st.a === 'undo' || st.a === 'dismiss' ? 'change' : 'figure';
      const shown = d.show(`imp/mfc/${item}/H1`) as { rev: string } | null;
      if (shown === null) continue;
      const choice = st.a === 'dismiss-align' ? 'dismiss' : st.a;
      d.answer('H1', choice, t, {}, {}, item);
      answers.push({ item, choice, rev: shown.rev });
      fired.add(st.id);
    } else {
      const d = devs[st.dev]!;
      if (!['figure', 'change', 'align'].some((k) => d.show(`imp/mfc/${k}/H1`) !== null)) continue;
      const occs = [...new Set([...d.replica.keys(), ...d.outbox.filter((e) => e.type === 'edit').map((e) => e.key)].filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!))].sort();
      const live = occs.filter((c) => d.show(`occ/${c}/status`) === 'owned' && d.show(`occ/${c}/head`) === 'H1');
      const removed = occs.filter((c) => d.show(`occ/${c}/status`) === null && d.show(`occ/${c}/head`) === 'H1');
      if (st.h === 'sell-high' || st.h === 'sell-low') {
        const o = byName?.get(st.id) ?? (st.h === 'sell-low' ? live[0] : live.at(-1));
        if (o === undefined) continue;
        d.edit(`occ/${o}/status`, 'former', t);
        picks.set(st.id, o);
      } else if (st.h === 'reown') {
        const o = removed.at(-1);
        if (o === undefined) continue;
        d.edit(`occ/${o}/status`, 'owned', t);
        picks.set(st.id, `reown:${o}`);
      } else if (st.h === 'readd') {
        d.edit(`occ/r${st.id}/head`, 'H1', t);
        d.edit(`occ/r${st.id}/status`, 'owned', t);
      } else {
        if (live[0] === undefined) continue;
        d.edit(`occ/${live[0]}/tag/t9`, {}, t);
      }
      fired.add(st.id);
    }
  }
  if (answerHeld !== undefined) {
    const X = new Device(s, 'X');
    for (let i = 0; i < 4; i++) {
      X.pull();
      if (X.show('imp/mfc/held/H1') === null) break;
      t++;
      X.answer('H1', answerHeld, t, {}, {}, 'held');
      X.push(t);
    }
  }
  for (const a of later ?? []) {
    const X = new Device(s, 'X');
    X.pull();
    if ((X.show(`imp/mfc/${a.item}/H1`) as { rev: string } | null)?.rev !== a.rev) continue;
    t++;
    X.answer('H1', a.choice, t, {}, {}, a.item);
    X.push(t);
  }
  let counts = 0;
  for (const [k, v] of s.emitted) if (k.endsWith('/status') && v[0] === 'owned' && s.emitted.get(k.replace('/status', '/head'))?.[0] === 'H1') counts++;
  const items = JSON.stringify({ f: s.figureItems(), c: Object.keys(s.changeEntries()).sort(), a: Object.keys(s.alignEntries()).sort() });
  return { counts, items, held: Object.values(s.heldCards()).flat().length, stale: res.includes('STALE'), fired, picks, answers, unitKind, unitCopy };
}

export interface CrossImportTally {
  runs: number;
  same: number;
  sameCountsShown: number;
  differsShown: number;
  picks: number;
  refHeldAnswered: number;
  /** Ends as pushed-first once the answers the devices gave offline are given to the items pushed-first leaves pending at the same revs. */
  answeredSameRev: number;
  collisions: number;
  silent: number;
  silentItem: number;
  first: string[];
}

/** Scripts `from` to `to` (seeds), each offline and pushed-first; no script may differ silently. */
export function crossImportWorld(opts: { sw?: Switches; from: number; to: number }): CrossImportTally {
  const sw = opts.sw ?? {};
  const t: CrossImportTally = { runs: 0, same: 0, sameCountsShown: 0, differsShown: 0, picks: 0, refHeldAnswered: 0, answeredSameRev: 0, collisions: 0, silent: 0, silentItem: 0, first: [] };
  const EMPTY = '{"f":{},"c":[],"a":[]}';
  for (let seed = opts.from; seed <= opts.to; seed++) {
    const { steps, desc } = crossImportScript(seed);
    const got = runCrossImport(steps, sw, false);
    const ref = runCrossImport(steps, sw, true, got.fired);
    t.runs++;
    if (got.counts === ref.counts && got.items === ref.items && got.held === 0) {
      t.same++;
      continue;
    }
    const shown = got.held > 0 || got.stale || (got.items !== ref.items && got.items !== EMPTY);
    const what = `seed ${seed} ${desc} got ${JSON.stringify({ ...got, fired: [...got.fired], picks: [...got.picks] })} ref ${JSON.stringify({ ...ref, fired: [...ref.fired], picks: [...ref.picks] })}`;
    // an answer accepted offline on an item a replay withdrew and a later replay gave back at the same rev
    const answeredSameRev = () => {
      const r3 = runCrossImport(steps, sw, true, got.fired, undefined, undefined, got.answers);
      return got.held === 0 && r3.counts === got.counts && r3.items === got.items && r3.held === 0;
    };
    if (got.counts === ref.counts) {
      if (shown) t.sameCountsShown++;
      else if (answeredSameRev()) t.answeredSameRev++;
      else {
        t.silentItem++;
        if (t.first.length < 5) t.first.push(`item: ${what}`);
      }
      continue;
    }
    if (shown) {
      t.differsShown++;
      continue;
    }
    const byName = new Map([...got.picks].filter(([, v]) => !v.startsWith('reown:')));
    const ref2 = runCrossImport(steps, sw, true, got.fired, byName);
    if (ref2.counts === got.counts && ref2.items === got.items) {
      t.picks++;
      continue;
    }
    if (ref.held > 0 || ref2.held > 0) {
      const ends = (['keep', 'take'] as const).flatMap((x) => [runCrossImport(steps, sw, true, got.fired, undefined, x), runCrossImport(steps, sw, true, got.fired, byName, x)]);
      if (ends.some((e) => e.counts === got.counts)) {
        t.refHeldAnswered++;
        continue;
      }
    }
    if (got.unitKind !== 'add' && [...got.picks.values()].some((v) => v === got.unitCopy || v === `reown:${got.unitCopy}`)) {
      t.collisions++;
      continue;
    }
    if (answeredSameRev()) {
      t.answeredSameRev++;
      continue;
    }
    t.silent++;
    if (t.first.length < 5) t.first.push(what);
  }
  return t;
}

// ------------------------------------------------------------------ world 9: late units and every reaction (HELD)
// Adopted from the round-7 recheck's world 6, run in full (W6_FULL): the phone makes one late unit or two (a sale, a sale
// with its disposal, a cancel, an added copy), in one push or two; MFC changes the Count; the tablet and a third device
// U pull the import and react to what they are shown (a figure item, a change entry or an align-MFC entry): by hand (a
// sale of the highest or lowest live copy, a re-own, an added copy, a tag, a sale plus an added copy) or by an answer
// (take, keep, undo, dismiss the align-MFC entry); sometimes a second import follows the reactions (the same Count, one
// less or one more); then the devices push in every order. Each path is compared with pushed-first plus the same
// conditional reactions. SILENT: other live counts and nothing shown (no held card, no STALE answer, no figure item that
// pushed-first lacks). Four differences are counted apart: a by-hand pick the device made among other copies (equal to
// pushed-first with that copy taken by name), an answer the device gave to an item of another kind than pushed-first
// shows it (an undo of an applied change offline, of a favor_app settlement pushed-first: equal to pushed-first without
// that answer), a by-hand sale of the very copy a late unit took out (plain concurrency between the phone and that
// device), and the tablet and U taking out one copy (plain concurrency between them).
type W9Unit = [string, string];
type W9React = 'none' | 'sell-high' | 'sell-low' | 'reown' | 'add' | 'tag' | 'take' | 'keep' | 'undo' | 'dismiss-align' | 'sell+add';
export interface W9Case {
  policy: string;
  pre: string;
  n: number;
  units: W9Unit[];
  split: boolean;
  d: number;
  second: number | null;
  rT: W9React;
  rU: W9React;
  order: string;
}
const namer9 = (r: string, k: number) => (r === '1144' ? `o${k}` : `n${r}:${k}`);

/** The kind of the item an answer of world 9 or 10 names, as its device shows it (conflict, divergence, applied, favor_app, favor_mfc, align). */
const kindShown = (v: Json, item: string): string => (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.kind === 'string' ? v.kind : item);

function w9React(d: Device, r: W9React, t: number, tag: string, byName?: string, kinds?: Record<string, string>, kindOf?: string): string {
  const fig = d.show('imp/mfc/figure/H1');
  const ch = d.show('imp/mfc/change/H1');
  const al = d.show('imp/mfc/align/H1');
  // an answer only to an item of the kind the offline path answered, where one is named
  const answers = (v: Json, item: string) => {
    const k = kindShown(v, item);
    if (kindOf !== undefined && kindOf !== k) return false;
    if (kinds !== undefined) kinds[tag] = k;
    return true;
  };
  if (r === 'none' || (fig === null && ch === null && al === null)) return 'no';
  const occs = [...new Set([...d.replica.keys()].filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!))].sort();
  const live = occs.filter((c) => d.show(`occ/${c}/status`) === 'owned' && d.show(`occ/${c}/head`) === 'H1');
  const removed = occs.filter((c) => d.show(`occ/${c}/status`) === null && d.show(`occ/${c}/head`) === 'H1');
  if (r === 'sell-high' || r === 'sell-low' || r === 'sell+add') {
    // by name only a copy this device shows live here: a copy that exists only offline (one a late unit's replay
    // withdraws) is no pick
    const c = byName !== undefined ? (live.includes(byName) ? byName : undefined) : r === 'sell-low' ? live[0] : live.at(-1);
    if (c === undefined) return 'no';
    d.edit(`occ/${c}/status`, 'former', t);
    if (r === 'sell+add') {
      d.edit(`occ/x${tag}/head`, 'H1', t);
      d.edit(`occ/x${tag}/status`, 'owned', t);
    }
    return `${r} ${c}`;
  }
  if (r === 'reown') {
    const c = removed.at(-1);
    if (c === undefined) return 'no';
    d.edit(`occ/${c}/status`, 'owned', t);
    return `reown ${c}`;
  }
  if (r === 'add') {
    d.edit(`occ/x${tag}/head`, 'H1', t);
    d.edit(`occ/x${tag}/status`, 'owned', t);
    return 'add';
  }
  if (r === 'tag') {
    if (live[0] === undefined) return 'no';
    d.edit(`occ/${live[0]}/tag/t9`, {}, t);
    return 'tag';
  }
  if (r === 'take' || r === 'keep') {
    if (fig === null || !answers(fig, 'figure')) return 'no';
    d.answer('H1', r, t);
    return r;
  }
  if (r === 'undo') {
    if (ch === null || !answers(ch, 'change')) return 'no';
    d.answer('H1', 'undo', t, {}, {}, 'change');
    return r;
  }
  if (al === null || !answers(al, 'align')) return 'no';
  d.answer('H1', 'dismiss', t, {}, {}, 'align');
  return r;
}

function w9Unit(d: Device, [op, x]: W9Unit, t: number): void {
  if (op === 'sell' || op === 'selldisp') d.edit(`occ/${x}/status`, 'former', t);
  if (op === 'selldisp') d.edit(`occ/${x}/disposal`, { reason: 'sold' }, t);
  if (op === 'cancel') d.edit(`occ/${x}/status`, null, t);
  if (op === 'add') {
    d.edit(`occ/a${x}/head`, 'H1', t);
    d.edit(`occ/a${x}/status`, 'owned', t);
  }
}

/**
 * One path of a world-9 case; `names` gives a by-hand sale's copy by name (pushed-first with the offline pick), and
 * `kindOf` lets a device answer only an item of the kind the offline path answered.
 */
export function runLateUnits(c: W9Case, path: 'REF' | 'OFF', sw: Switches, names: { T?: string; U?: string } = {}, kindOf: Record<string, string> = {}) {
  const s = new Server({ namer: namer9, switches: sw });
  const P = new Device(s, 'P');
  const Tb = new Device(s, 'T');
  const U = new Device(s, 'U');
  Tb.edit('pref/mfc/import', { import_policy: c.policy }, 470);
  Tb.push(471);
  s.runImport([row('1144', 'H1', 'owned', c.n)], 480);
  for (const d of [P, Tb, U]) d.pull();
  if (c.pre === 'appadd') {
    Tb.edit('occ/b1/head', 'H1', 490);
    Tb.edit('occ/b1/status', 'owned', 490);
  }
  if (c.pre === 'appsell') Tb.edit(`occ/o${c.n}/status`, 'former', 490);
  Tb.push(491);
  c.units.forEach((u, i) => w9Unit(P, u, 500 + i));
  const k1 = c.split ? 1 : c.units.reduce((a, u) => a + (u[0] === 'add' || u[0] === 'selldisp' ? 2 : 1), 0);
  if (path === 'REF') P.push(510);
  s.runImport([row('1144', 'H1', 'owned', Math.max(0, c.n + c.d))], 600);
  Tb.pull();
  const kinds: Record<string, string> = {};
  const shownT = w9React(Tb, c.rT, 610, 'T', names.T, kinds, kindOf.T);
  U.pull();
  const shownU = w9React(U, c.rU, 615, 'U', names.U, kinds, kindOf.U);
  const res: string[] = [];
  const answered = ['take', 'keep', 'undo', 'dismiss-align'];
  let stale = false;
  const pushOf = (d: Device, react: string, t: number, n?: number) => {
    const out = d.push(t, n).map((x) => x.outcome);
    // a STALE answer is shown: the client shows the item as it now is
    if (out.includes('STALE') && answered.includes(react)) stale = true;
    res.push(...out);
  };
  if (c.second !== null) {
    pushOf(Tb, shownT, 620);
    pushOf(U, shownU, 621);
    s.runImport([row('1144', 'H1', 'owned', Math.max(0, c.n + c.d + c.second))], 630);
  }
  const pushP = (n?: number) => pushOf(P, 'no', 700 + res.length, n);
  const pushT = () => pushOf(Tb, shownT, 700 + res.length);
  const pushU = () => pushOf(U, shownU, 700 + res.length);
  if (path === 'OFF') {
    if (c.order === 'P-T-U') {
      pushP(k1);
      pushP();
      pushT();
      pushU();
    } else if (c.order === 'T-U-P') {
      pushT();
      pushU();
      pushP(k1);
      pushP();
    } else if (c.order === 'T-P-U') {
      pushT();
      pushP(k1);
      pushP();
      pushU();
    } else {
      pushP(k1);
      pushT();
      pushU();
      pushP();
    }
  } else {
    pushT();
    pushU();
    pushP();
  }
  for (let i = 0; i < 2; i++) for (const d of [P, Tb, U]) d.pull();
  const counts: Record<string, number> = {};
  for (const [k, v] of s.emitted)
    if (k.endsWith('/status') && v[0] === 'owned') {
      const h = s.emitted.get(k.replace('/status', '/head'))?.[0];
      if (typeof h === 'string') counts[h] = (counts[h] ?? 0) + 1;
    }
  return { counts: JSON.stringify(counts), figure: JSON.stringify(s.figureItems()), held: Object.values(s.heldCards()).flat().length, stale, reacted: `${shownT}|${shownU}`, kinds, out: res.join(',') };
}

export interface LateUnitsTally {
  runs: number;
  same: number;
  sameCountsShown: number;
  differsShown: number;
  picks: number;
  /** An answer the offline path gave to an item of another kind than pushed-first shows (an undo of an applied change against one of a favor_app settlement): pushed-first without it ends the same. */
  answerKind: number;
  collisions: number;
  tuCollisions: number;
  silent: number;
  /** Of the silent paths, those where both paths have a figure item (the challenger's silentButFigureItemInBoth). */
  silentWithItemInBoth: number;
  first: string[];
  /** The first paths counted apart, for reading. */
  apart: string[];
}

/** Every `every`-th case from `offset` (whole cases: all of a case's orders), for the policies given. */
export function lateUnitsWorld(opts: { sw?: Switches; every?: number; offset?: number; policies?: readonly string[] } = {}): LateUnitsTally {
  const sw = opts.sw ?? {};
  const every = opts.every ?? 1;
  const offset = opts.offset ?? 0;
  const t: LateUnitsTally = { runs: 0, same: 0, sameCountsShown: 0, differsShown: 0, picks: 0, answerKind: 0, collisions: 0, tuCollisions: 0, silent: 0, silentWithItemInBoth: 0, first: [], apart: [] };
  const apart = (why: string, c: W9Case, got: unknown, ref: unknown) => {
    if (t.apart.length < 30) t.apart.push(`${why}: ${JSON.stringify(c)} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
  };
  const reacts: W9React[] = ['none', 'sell-high', 'sell-low', 'reown', 'add', 'tag', 'take', 'keep', 'undo', 'dismiss-align', 'sell+add'];
  let k = 0;
  for (const policy of opts.policies ?? ['ASK', 'FAVOR_APP', 'FAVOR_MFC'])
    for (const pre of ['none', 'appadd', 'appsell'])
      for (const n of [1, 2, 3]) {
        const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`).filter((x) => !(pre === 'appsell' && x === `o${n}`));
        const one: W9Unit[] = [...copies.flatMap((x) => ['sell', 'selldisp', 'cancel'].map((op): W9Unit => [op, x])), ['add', '1']];
        const unitSets: W9Unit[][] = [...one.map((u) => [u]), ...one.flatMap((u, i) => one.slice(i + 1).filter((v) => v[1] !== u[1] || v[0] === 'add').map((v) => [u, v]))];
        for (const units of unitSets)
          for (const d of [-2, -1, 1, 2]) {
            if (n + d < 0) continue;
            for (const second of [null, 0, -1, 1])
              for (const rT of reacts)
                for (const rU of ['none', 'sell-high', 'add', 'keep', 'undo'] as W9React[])
                  for (const split of units.length > 1 ? [false, true] : [false]) {
                    if (k++ % every !== offset) continue;
                    const base: W9Case = { policy, pre, n, units, split, d, second, rT, rU, order: 'P-T-U' };
                    const refs = new Map<string, ReturnType<typeof runLateUnits>>();
                    for (const order of ['P-T-U', 'T-U-P', 'T-P-U', 'P1-T-U-P2']) {
                      if (order === 'P1-T-U-P2' && !split) continue;
                      const c = { ...base, order };
                      const got = runLateUnits(c, 'OFF', sw);
                      // pushed-first with the reactions this path made (a device that reacted here reacts there by the same rule)
                      const [gt, gu] = got.reacted.split('|') as [string, string];
                      const refCase = { ...base, rT: gt !== 'no' ? rT : 'none', rU: gu !== 'no' ? rU : 'none' } as W9Case;
                      const refKey = `${gt !== 'no'}|${gu !== 'no'}`;
                      if (!refs.has(refKey)) refs.set(refKey, runLateUnits(refCase, 'REF', sw));
                      const ref = refs.get(refKey)!;
                      t.runs++;
                      const sameCounts = got.counts === ref.counts;
                      if (sameCounts && got.figure === ref.figure && got.held === 0) {
                        t.same++;
                        continue;
                      }
                      const shown = got.held > 0 || got.stale || (got.figure !== ref.figure && got.figure !== '{}');
                      if (shown) {
                        if (sameCounts) t.sameCountsShown++;
                        else t.differsShown++;
                        continue;
                      }
                      // the offline path answered an item of another kind than pushed-first shows: the same answer means
                      // another thing there (an undo of an applied change restores the app's copies, an undo of a
                      // favor_app settlement takes MFC's side); pushed-first without that answer ends the same
                      if (Object.entries(got.kinds).some(([dv, k]) => ref.kinds[dv] !== undefined && ref.kinds[dv] !== k)) {
                        const same = runLateUnits(refCase, 'REF', sw, {}, got.kinds);
                        if (same.counts === got.counts && (!sameCounts || same.figure === got.figure)) {
                          t.answerKind++;
                          apart('answer kind', c, got, same);
                          continue;
                        }
                      }
                      if (sameCounts) {
                        // the same counts, and pushed-first's figure item gone: counted with the silent paths
                        t.silent++;
                        if (t.first.length < 5) t.first.push(`item: ${JSON.stringify(c)} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
                        continue;
                      }
                      // a by-hand pick among other copies: pushed-first with the copies this path took out, by name
                      const pick = (x: string) => (x.startsWith('sell') ? x.split(' ')[1] : undefined);
                      const names = { T: pick(gt), U: pick(gu) };
                      if (names.T !== undefined || names.U !== undefined) {
                        const ref2 = runLateUnits(refCase, 'REF', sw, names);
                        if (ref2.reacted === got.reacted && ref2.counts === got.counts && ref2.figure === got.figure) {
                          t.picks++;
                          apart('pick', c, got, ref2);
                          continue;
                        }
                      }
                      // a device took out the very copy a late unit took out (plain concurrency)
                      const outs = units.filter((u) => ['sell', 'selldisp', 'cancel'].includes(u[0])).map((u) => u[1]);
                      const sold = [names.T, names.U].filter((x): x is string => x !== undefined);
                      if (sold.some((x) => outs.includes(x))) {
                        t.collisions++;
                        apart('collision', c, got, ref);
                        continue;
                      }
                      if (sold.length === 2 && sold[0] === sold[1]) {
                        t.tuCollisions++;
                        apart('two devices', c, got, ref);
                        continue;
                      }
                      t.silent++;
                      if (got.figure !== '{}') t.silentWithItemInBoth++;
                      if (t.first.length < 5) t.first.push(`${JSON.stringify(c)} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
                    }
                  }
          }
      }
  return t;
}

// ------------------------------------------------------------------ world 10: compound reactions on two devices, two offline devices
// Adopted from the round-8 recheck's world 10 (chal10): two offline devices, the phone P with one late unit or two (in one
// push or two) and Q with one or none; an import under ASK, FAVOR_APP or FAVOR_MFC; the tablet T and a third device U each
// make a COMPOUND reaction to what they are shown (an answer and a by-hand edit, either first, in one push or two), U
// pulling before or after T's first push; an optional second import, with the reactions pushed before it, after it (an
// answer arriving after the second import, the by-hand edits late for it) or mixed; then P, Q, T and U push in a random
// order. Each offline path is compared with pushed-first (P and Q push at once; T and U keep their relative order), every
// reaction part allowed only where it fired offline. SILENT: other live counts and nothing shown (no held card, no STALE
// answer, no figure item pushed-first lacks); silentItem: the same counts and pushed-first's figure item gone, nothing
// shown. Counted apart, each read: a by-hand pick (pushed-first with the copy taken out by name ends the same), pushed-first
// holding an edit whose card's answer ends where the offline path ends, a by-hand sale of the very copy a late unit took
// out, and T and U taking out one copy.
type W10Answer = 'none' | 'take' | 'keep' | 'undo' | 'dismiss' | 'dismiss-align';
type W10Hand = 'none' | 'sell-high' | 'sell-low' | 'reown' | 'add' | 'tag';
interface W10Prog {
  ans: W10Answer;
  hand: W10Hand;
  handFirst: boolean;
  split: boolean;
}
export interface W10Case {
  policy: string;
  pre: string;
  n: number;
  pUnits: W9Unit[];
  pSplit: boolean;
  qUnit: W9Unit | null;
  d: number;
  second: number | null;
  timing: 'before' | 'after' | 'mixed';
  T: W10Prog;
  U: W10Prog;
  uPullAfterT: boolean;
  order: string[];
}

/** World 10's case for a seed (the challenger's generator, seed for seed). */
export function w10Case(seed: number): W10Case {
  const r = rng(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;
  const policy = pick(['ASK', 'ASK', 'FAVOR_APP', 'FAVOR_MFC']);
  const pre = pick(['none', 'none', 'appadd', 'appsell']);
  const n = 1 + Math.floor(r() * 3);
  const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`).filter((x) => !(pre === 'appsell' && x === `o${n}`));
  const unit = (who: string): W9Unit => (r() < 0.25 || copies.length === 0 ? ['add', who] : [pick(['sell', 'selldisp', 'cancel']), pick(copies)]);
  const pUnits: W9Unit[] = [unit('P1')];
  if (r() < 0.4) {
    const u = unit('P2');
    if (u[0] === 'add' || u[1] !== pUnits[0]![1]) pUnits.push(u);
  }
  const qUnit = r() < 0.7 ? unit('Q1') : null;
  let d = pick([-2, -1, 1, 2]);
  if (n + d < 0) d = 1;
  const second = pick([null, null, 0, -1, 1]);
  const timing = pick(['before', 'after', 'mixed'] as const);
  const prog = (): W10Prog => ({
    ans: pick(['none', 'take', 'keep', 'undo', 'dismiss', 'dismiss-align'] as const),
    hand: pick(['none', 'sell-high', 'sell-low', 'reown', 'add', 'tag'] as const),
    handFirst: r() < 0.4,
    split: r() < 0.4,
  });
  const Tp = prog();
  const Up = r() < 0.6 ? prog() : { ans: 'none' as W10Answer, hand: 'none' as W10Hand, handFirst: false, split: false };
  const pool = ['P', 'T', 'U', ...(qUnit ? ['Q'] : [])];
  const order: string[] = [];
  while (pool.length > 0) order.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return { policy, pre, n, pUnits, pSplit: pUnits.length > 1 && r() < 0.5, qUnit, d, second, timing, T: Tp, U: Up, uPullAfterT: r() < 0.5, order };
}

interface W10Run {
  counts: number;
  items: string;
  held: number;
  stale: boolean;
  fired: Record<string, string>;
  /** Per answer given: the kind of the item it answered (conflict, divergence, applied, favor_app, favor_mfc, align). */
  kinds: Record<string, string>;
  out: string;
}
/**
 * One path of a world-10 case: offline or pushed-first, each reaction part only where `allow` permits it, a by-hand sale
 * by name where `names` says, an answer only to an item of the kind `kinds` names where it names one, and pushed-first's
 * held cards answered at the end where `answerHeld` says.
 */
export function runCompoundLate(
  c: W10Case,
  path: 'REF' | 'OFF',
  sw: Switches,
  allow: Record<string, boolean> = {},
  names: Record<string, string | undefined> = {},
  answerHeld?: 'keep' | 'take',
  kinds: Record<string, string> = {},
): W10Run {
  const s = new Server({ namer: namer9, switches: sw });
  const P = new Device(s, 'P');
  const Q = new Device(s, 'Q');
  const Tb = new Device(s, 'T');
  const U = new Device(s, 'U');
  Tb.edit('pref/mfc/import', { import_policy: c.policy }, 470);
  Tb.push(471);
  s.runImport([row('1144', 'H1', 'owned', c.n)], 480);
  for (const d of [P, Q, Tb, U]) d.pull();
  if (c.pre === 'appadd') {
    Tb.edit('occ/b1/head', 'H1', 490);
    Tb.edit('occ/b1/status', 'owned', 490);
  }
  if (c.pre === 'appsell') Tb.edit(`occ/o${c.n}/status`, 'former', 490);
  Tb.push(491);
  c.pUnits.forEach((u, i) => w9Unit(P, u, 500 + i));
  if (c.qUnit) w9Unit(Q, c.qUnit, 505);
  const k1 = c.pSplit ? (c.pUnits[0]![0] === 'add' || c.pUnits[0]![0] === 'selldisp' ? 2 : 1) : undefined;
  if (path === 'REF') {
    P.push(510);
    Q.push(511);
  }
  s.runImport([row('1144', 'H1', 'owned', Math.max(0, c.n + c.d))], 600);
  const fired: Record<string, string> = {};
  const answered: Record<string, string> = {};
  let stale = false;
  const res: string[] = [];
  const pushOf = (name: string, d: Device, t: number, n?: number) => {
    const out = d.push(t, n).map((x) => x.outcome);
    // a STALE answer is shown: the client shows the item as it now is
    if (out.includes('STALE') && (fired[`${name}a`] ?? 'no') !== 'no') stale = true;
    res.push(...out);
  };
  const react = (name: string, d: Device, p: W10Prog, t: number) => {
    const doAnswer = () => {
      const key = `${name}a`;
      if (p.ans === 'none' || allow[key] === false) return void (fired[key] = 'no');
      const item = p.ans === 'undo' || p.ans === 'dismiss' ? 'change' : p.ans === 'dismiss-align' ? 'align' : 'figure';
      const shown = d.show(`imp/mfc/${item}/H1`);
      if (shown === null) return void (fired[key] = 'no');
      const kind = kindShown(shown, item);
      if (kinds[key] !== undefined && kinds[key] !== kind) return void (fired[key] = 'no');
      d.answer('H1', p.ans === 'dismiss-align' ? 'dismiss' : p.ans, t, {}, {}, item);
      fired[key] = p.ans;
      answered[key] = kind;
    };
    const doHand = () => {
      const key = `${name}h`;
      const shown = ['figure', 'change', 'align'].some((k) => d.show(`imp/mfc/${k}/H1`) !== null);
      if (p.hand === 'none' || allow[key] === false || !shown) return void (fired[key] = 'no');
      const occs = [...new Set([...d.replica.keys(), ...d.outbox.filter((e) => e.type === 'edit').map((e) => e.key)].filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!))].sort();
      const live = occs.filter((x) => d.show(`occ/${x}/status`) === 'owned' && d.show(`occ/${x}/head`) === 'H1');
      const removed = occs.filter((x) => d.show(`occ/${x}/status`) === null && d.show(`occ/${x}/head`) === 'H1');
      if (p.hand === 'sell-high' || p.hand === 'sell-low') {
        const nm = names[name];
        // by name only a copy this device shows live here
        const x = nm !== undefined ? (live.includes(nm) ? nm : undefined) : p.hand === 'sell-low' ? live[0] : live.at(-1);
        if (x === undefined) return void (fired[key] = 'no');
        d.edit(`occ/${x}/status`, 'former', t);
        fired[key] = `sell ${x}`;
      } else if (p.hand === 'reown') {
        const x = removed.at(-1);
        if (x === undefined) return void (fired[key] = 'no');
        d.edit(`occ/${x}/status`, 'owned', t);
        fired[key] = `reown ${x}`;
      } else if (p.hand === 'add') {
        d.edit(`occ/x${name}/head`, 'H1', t);
        d.edit(`occ/x${name}/status`, 'owned', t);
        fired[key] = 'add';
      } else {
        if (live[0] === undefined) return void (fired[key] = 'no');
        d.edit(`occ/${live[0]}/tag/t9`, {}, t);
        fired[key] = 'tag';
      }
    };
    const parts = p.handFirst ? [doHand, doAnswer] : [doAnswer, doHand];
    parts[0]!();
    if (p.split) pushOf(name, d, t + 1);
    parts[1]!();
  };
  Tb.pull();
  // U pulls before T reacts, or after (T's split push, if any, already went)
  if (!c.uPullAfterT) U.pull();
  react('T', Tb, c.T, 610);
  if (c.uPullAfterT) U.pull();
  react('U', U, c.U, 615);
  if (c.second !== null) {
    if (c.timing === 'before') {
      pushOf('T', Tb, 620);
      pushOf('U', U, 621);
    }
    if (c.timing === 'mixed') pushOf('T', Tb, 620);
    s.runImport([row('1144', 'H1', 'owned', Math.max(0, c.n + c.d + c.second))], 630);
  }
  for (const who of c.order) {
    if (path === 'OFF' && who === 'P') {
      if (k1 !== undefined) {
        pushOf('P', P, 700, k1);
        pushOf('P', P, 701);
      } else pushOf('P', P, 700);
    }
    if (path === 'OFF' && who === 'Q') pushOf('Q', Q, 702);
    if (who === 'T') pushOf('T', Tb, 703);
    if (who === 'U') pushOf('U', U, 704);
  }
  if (answerHeld !== undefined) {
    const X = new Device(s, 'X');
    for (let i = 0; i < 4; i++) {
      X.pull();
      if (X.show('imp/mfc/held/H1') === null) break;
      X.answer('H1', answerHeld, 710 + i, {}, {}, 'held');
      X.push(710 + i);
    }
  }
  for (let i = 0; i < 2; i++) for (const d of [P, Q, Tb, U]) d.pull();
  let counts = 0;
  for (const [k, v] of s.emitted) if (k.endsWith('/status') && v[0] === 'owned' && s.emitted.get(k.replace('/status', '/head'))?.[0] === 'H1') counts++;
  const items = JSON.stringify({ f: s.figureItems(), c: Object.keys(s.changeEntries()).sort(), a: Object.keys(s.alignEntries()).sort() });
  return { counts, items, held: Object.values(s.heldCards()).flat().length, stale, fired, kinds: answered, out: res.join(',') };
}

export interface CompoundLateTally {
  runs: number;
  same: number;
  sameCountsShown: number;
  differsShown: number;
  picks: number;
  refHeldAnswered: number;
  /** An answer the offline path gave to an item of another kind than pushed-first shows (an undo of an applied change against one of a favor_app settlement): pushed-first without it ends the same. */
  answerKind: number;
  collisions: number;
  tuCollisions: number;
  silent: number;
  silentItem: number;
  first: string[];
  /** The first paths counted apart, for reading. */
  apart: string[];
}

/** World 10's cases for seeds `from` to `to`, every `every`-th one. */
export function compoundLateWorld(opts: { sw?: Switches; from: number; to: number; every?: number }): CompoundLateTally {
  const sw = opts.sw ?? {};
  const every = opts.every ?? 1;
  const t: CompoundLateTally = { runs: 0, same: 0, sameCountsShown: 0, differsShown: 0, picks: 0, refHeldAnswered: 0, answerKind: 0, collisions: 0, tuCollisions: 0, silent: 0, silentItem: 0, first: [], apart: [] };
  const figOf = (items: string) => JSON.stringify((JSON.parse(items) as { f: unknown }).f);
  for (let seed = opts.from; seed <= opts.to; seed += every) {
    const c = w10Case(seed);
    const got = runCompoundLate(c, 'OFF', sw);
    const allow = Object.fromEntries(Object.entries(got.fired).map(([k, v]) => [k, v !== 'no']));
    const ref = runCompoundLate(c, 'REF', sw, allow);
    t.runs++;
    const what = (why: string, r: W10Run) => `${why} seed ${seed} ${JSON.stringify(c)} got ${JSON.stringify(got)} ref ${JSON.stringify(r)}`;
    const apart = (why: string, r: W10Run) => {
      if (t.apart.length < 30) t.apart.push(what(why, r));
    };
    const sameCounts = got.counts === ref.counts;
    if (sameCounts && got.items === ref.items && got.held === 0) {
      t.same++;
      continue;
    }
    const shown = got.held > 0 || got.stale || (figOf(got.items) !== figOf(ref.items) && figOf(got.items) !== '{}');
    if (shown) {
      if (sameCounts) t.sameCountsShown++;
      else t.differsShown++;
      continue;
    }
    if (sameCounts && figOf(got.items) === figOf(ref.items)) {
      t.same++;
      continue;
    }
    const pk = (x: string | undefined) => (x !== undefined && x.startsWith('sell ') ? x.split(' ')[1] : undefined);
    const names = { T: pk(got.fired.Th), U: pk(got.fired.Uh) };
    const byName = names.T !== undefined || names.U !== undefined ? runCompoundLate(c, 'REF', sw, allow, names) : undefined;
    if (byName !== undefined && byName.counts === got.counts && figOf(byName.items) === figOf(got.items)) {
      t.picks++;
      apart('pick', byName);
      continue;
    }
    // pushed-first holds an edit, and its card's answer (keep or take) ends at the offline path's counts (as in the
    // cross-import world), and at its figure item too when the counts were the same
    if (ref.held > 0 || (byName?.held ?? 0) > 0) {
      const ends = (['keep', 'take'] as const).flatMap((x) => [runCompoundLate(c, 'REF', sw, allow, {}, x), ...(byName === undefined ? [] : [runCompoundLate(c, 'REF', sw, allow, names, x)])]);
      const end = ends.find((e) => e.counts === got.counts && (!sameCounts || figOf(e.items) === figOf(got.items)));
      if (end !== undefined) {
        t.refHeldAnswered++;
        apart('pushed-first holds', end);
        continue;
      }
    }
    // the offline path answered an item of another kind than pushed-first shows: the same answer means another thing
    // there (an undo of an applied change restores the app's copies, one of a favor_app settlement takes MFC's side)
    if (Object.entries(got.kinds).some(([k, v]) => ref.kinds[k] !== undefined && ref.kinds[k] !== v)) {
      const same = runCompoundLate(c, 'REF', sw, allow, {}, undefined, got.kinds);
      if (same.counts === got.counts && (!sameCounts || figOf(same.items) === figOf(got.items))) {
        t.answerKind++;
        apart('answer kind', same);
        continue;
      }
    }
    if (sameCounts) {
      t.silentItem++;
      if (t.first.length < 5) t.first.push(what('item', ref));
      continue;
    }
    // a by-hand sale of the very copy a late unit took out (plain concurrency), or T and U taking out one copy
    const outs = [...c.pUnits, ...(c.qUnit ? [c.qUnit] : [])].filter((u) => u[0] !== 'add').map((u) => u[1]);
    const sold = [names.T, names.U].filter((x): x is string => x !== undefined);
    if (sold.some((x) => outs.includes(x))) {
      t.collisions++;
      apart('collision', ref);
      continue;
    }
    if (sold.length === 2 && sold[0] === sold[1]) {
      t.tuCollisions++;
      apart('two devices', ref);
      continue;
    }
    t.silent++;
    if (t.first.length < 5) t.first.push(what('silent', ref));
  }
  return t;
}
